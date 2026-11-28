#!/usr/bin/env python3
"""
Generate the synthetic dataset used by the qclog2 demo page (index.html?demo=1,
and the default on GitHub Pages).

All stations, networks and values are invented. The data goes through the real
backend pipeline: rows are inserted into a temporary SQLite DB, rolled up with
backend._rollup_hourly(), and the JSON files are written by backend._write_*(),
so the demo files have exactly the format the live backend produces.

Run from anywhere (no SeisComP installation needed):
    python3 demo/make_demo_data.py

Behaviour modelled on scqc defaults (report.interval = 60 s): during an outage
scqc keeps reporting latency/delay (growing) and availability (dropping to 0)
via its timeout tasks, while waveform-based parameters (rms, offset, timing,
gaps, ...) simply stop arriving.
"""

import json
import math
import random
import sqlite3
import sys
import tempfile
import time
import types
from pathlib import Path

DEMO_DIR = Path(__file__).resolve().parent
ROOT     = DEMO_DIR.parent
sys.path.insert(0, str(ROOT))

# backend.py imports seiscomp at module level; stub it when SeisComP isn't installed.
try:
    import seiscomp.client  # noqa: F401
except ImportError:
    sc = types.ModuleType('seiscomp')
    for name in ('core', 'client', 'datamodel'):
        mod = types.ModuleType('seiscomp.' + name)
        setattr(sc, name, mod)
        sys.modules['seiscomp.' + name] = mod
    sc.client.Application = object
    sys.modules['seiscomp'] = sc

import backend  # noqa: E402

random.seed(20261121)

STEP_MS   = 5 * 60_000         # one synthetic report per 5 min (scqc: 60 s)
DAYS      = 30
RAW_RET_H = 72                 # backend default

# ── Invented network ─────────────────────────────────────────────────────────
# (net, sta, lat, lon, channels)
STATIONS = [
    ('XA', 'KORU', -31.2, 116.4, 'HH'), ('XA', 'TALB', -33.9, 121.8, 'HH'),
    ('XA', 'MIRN', -28.1, 114.6, 'HH'), ('XA', 'WEDG', -26.5, 118.9, 'HH'),
    ('XA', 'PELL', -22.3, 117.2, 'HH'), ('XA', 'DUNE', -24.8, 123.5, 'HH'),
    ('XB', 'OKRA', -19.6, 134.1, 'BH'), ('XB', 'SALT', -23.7, 133.9, 'BH'),
    ('XB', 'GIBB', -16.4, 127.8, 'BH'), ('XB', 'NARR', -29.0, 131.6, 'BH'),
    ('XC', 'BRIM', -27.4, 152.9, 'EH'), ('XC', 'CORM', -30.6, 150.2, 'EH'),
    ('XC', 'FENN', -33.2, 148.7, 'EH'), ('XC', 'HOLT', -35.8, 146.9, 'EH'),
    ('XC', 'LYRE', -37.6, 144.3, 'EH'), ('XC', 'QUAY', -25.1, 149.4, 'EH'),
    # Across the antimeridian, so the demo exercises the map's 180° handling
    ('XD', 'KAVU', -17.8, 178.4, 'EH'), ('XD', 'LOMA', -18.6, -178.9, 'EH'),
    ('XD', 'NUKA', -21.1, -175.2, 'EH'),
]

H = 3_600_000
NOW_MS = (int(time.time() * 1000) // STEP_MS) * STEP_MS


def ago(hours):
    return NOW_MS - int(hours * H)


# ── Scenarios (times in hours before "now") ──────────────────────────────────
# Each is (stream prefix, kind, start_h_ago, end_h_ago or None=ongoing)
SCENARIOS = [
    ('XA.MIRN.',  'outage',  5.5,  None),   # station down right now
    ('XB.GIBB.',  'outage', 52.0,  44.0),   # 8 h outage two days ago, recovered
    ('XC.',       'telemetry', 120.0, 117.0),  # regional link problem, 5 days ago
    ('XB.SALT.',  'latency', 3.0,  None),   # slow link right now (warn level)
    ('XA.PELL.',  'gps',    400.0, None),   # timing quality degrading for weeks
    ('XC.HOLT.',  'gappy',  30.0,  None),   # recurring gaps since yesterday
    ('XA.DUNE.',  'spiky',  80.0,  60.0),   # burst of spikes 3 days ago
]


def active(stream, kind, t):
    for prefix, k, start_h, end_h in SCENARIOS:
        if k != kind or not stream.startswith(prefix):
            continue
        if ago(start_h) <= t and (end_h is None or t < ago(end_h)):
            return ago(start_h)
    return None


def streams():
    out = []
    for net, sta, *_ , band in STATIONS:
        comps = 'ZNE' if band != 'EH' else 'Z'        # short-period: vertical only
        loc = '00' if band != 'EH' else ''
        for c in comps:
            out.append(f'{net}.{sta}.{loc}.{band}{c}')
    return out


def gen_rows(stream):
    """Yield (stream, time_ms, parameter, value) for the whole period."""
    rnd = random.Random(stream)
    base_delay = rnd.uniform(2.0, 9.0) if not stream.startswith('XC') else rnd.uniform(6, 14)
    base_rms   = rnd.uniform(80, 900)
    base_off   = rnd.uniform(-400, 400)
    timing     = rnd.uniform(96, 100)
    off_phase  = rnd.uniform(0, 2 * math.pi)
    off_period = rnd.uniform(20, 60) * H
    utc_offset = 8 if stream.startswith('XA') else (9.5 if stream.startswith('XB') else 10)

    t = NOW_MS - DAYS * 24 * H
    while t <= NOW_MS:
        out_start = active(stream, 'outage', t)
        if out_start is not None:
            # scqc timeout tasks: latency/delay = time since last data
            gap_s = (t - out_start) / 1000
            yield (stream, t, 'latency', gap_s)
            yield (stream, t, 'delay', gap_s + base_delay)
            yield (stream, t, 'availability', 0.0 if gap_s > 600 else 100 * (1 - gap_s / 600))
            t += STEP_MS
            continue

        delay = base_delay * rnd.uniform(0.8, 1.3)
        if active(stream, 'telemetry', t) is not None:
            delay += rnd.uniform(90, 420)
        if active(stream, 'latency', t) is not None:
            delay += rnd.uniform(65, 140)
        yield (stream, t, 'delay', delay)
        yield (stream, t, 'latency', delay * rnd.uniform(0.9, 1.1) + rnd.uniform(0, 1.5))

        gps = active(stream, 'gps', t)
        if gps is not None:
            # slow GPS degradation with increasingly frequent deep dropouts
            weeks = (t - gps) / (24 * H) / 7
            tq = timing - 7 * weeks + rnd.uniform(-2, 2)
            if rnd.random() < 0.05 + 0.08 * weeks:
                tq -= rnd.uniform(20, 55)
            tq = max(10.0, min(100.0, tq))
        else:
            tq = min(100.0, timing + rnd.uniform(-1.5, 1.5))
        yield (stream, t, 'timing_quality', round(tq))

        # Cultural noise: higher during local daytime
        local_h = ((t / H) + utc_offset) % 24
        diurnal = 1 + 0.6 * max(0.0, math.sin((local_h - 6) / 12 * math.pi))
        yield (stream, t, 'rms', base_rms * diurnal * rnd.uniform(0.85, 1.15))
        yield (stream, t, 'offset', base_off + 40 * math.sin(t / off_period + off_phase) + rnd.uniform(-8, 8))

        gaps = 0
        if active(stream, 'gappy', t) is not None:
            gaps = rnd.choice([0, 0, 1, 2, 3, 6])
        elif rnd.random() < 0.002:
            gaps = 1
        yield (stream, t, 'gaps_count', gaps)
        yield (stream, t, 'overlaps_count', 1 if rnd.random() < 0.0008 else 0)
        spikes = rnd.choice([0, 1, 3, 8]) if active(stream, 'spiky', t) is not None \
            else (1 if rnd.random() < 0.001 else 0)
        yield (stream, t, 'spikes_count', spikes)
        avail = 100.0 if gaps == 0 else max(90.0, 100 - gaps * rnd.uniform(0.3, 1.5))
        yield (stream, t, 'availability', avail)
        t += STEP_MS


def build_events():
    """Status-change log matching the scenarios (what the Events tab would
    have recorded with the default thresholds)."""
    ev = []

    def add(stream, frm, to, start_h, end_h):
        ev.append({'ts': ago(start_h), 'stream': stream, 'from': frm, 'to': to,
                   'resolvedTs': None if end_h is None else ago(end_h)})
        if end_h is not None:
            ev.append({'ts': ago(end_h), 'stream': stream, 'from': to, 'to': 'ok',
                       'resolvedTs': None})

    for s in streams():
        if s.startswith('XA.MIRN.'):
            add(s, 'ok', 'alert', 5.4, None)
        if s.startswith('XB.SALT.'):
            add(s, 'ok', 'warn', 2.9, None)
        if s.startswith('XC.HOLT.'):
            add(s, 'ok', 'warn', 29.8, None)
        if s.startswith('XB.GIBB.'):
            add(s, 'ok', 'alert', 51.9, 43.9)
        if s.startswith('XC.'):                      # regional telemetry incident
            add(s, 'ok', 'warn', 119.9, 117.0)
    ev.sort(key=lambda e: e['ts'], reverse=True)
    return ev


def main():
    with tempfile.TemporaryDirectory() as tmp:
        db = backend._open_db(str(Path(tmp) / 'demo.db'))
        n = 0
        for s in streams():
            rows = list(gen_rows(s))
            db.executemany('INSERT OR IGNORE INTO qc_raw VALUES (?,?,?,?)', rows)
            n += len(rows)
        db.commit()
        print(f'inserted {n} raw rows for {len(streams())} streams')

        # Roll up exactly as the live backend would with default retention
        real_time = time.time
        time.time = lambda: NOW_MS / 1000
        try:
            backend._rollup_hourly(db, RAW_RET_H)
            out = str(DEMO_DIR)
            backend._write_current(db, out)
            backend._write_24h(db, out)
            backend._write_3d(db, out)
            backend._write_7d(db, out)
            backend._write_30d(db, out)
        finally:
            time.time = real_time
        db.close()

    with open(DEMO_DIR / 'events.json', 'w') as f:
        json.dump({'generated': NOW_MS, 'events': build_events()}, f, separators=(',', ':'))

    with open(DEMO_DIR / 'stations.txt', 'w') as f:
        f.write('#Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime\n')
        for net, sta, lat, lon, _ in STATIONS:
            f.write(f'{net}|{sta}|{lat}|{lon}|300|Demo station {sta}|2020-01-01T00:00:00|\n')

    for p in sorted(DEMO_DIR.glob('*.json')):
        print(f'{p.name:18s} {p.stat().st_size / 1e6:6.2f} MB')


if __name__ == '__main__':
    main()
