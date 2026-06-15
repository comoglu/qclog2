#!/usr/bin/env seiscomp-python
# -*- coding: utf-8 -*-
"""
qclog2 backfill — seeds the local qclog2 SQLite DB with historical QC data,
then regenerates all JSON files.  Designed to be run once after first deploy,
or any time you want to re-import history.  The normal backend.py continues
handling real-time data from the messaging system independently.

Two modes:

  A) From the SeisComP database (recommended — needs -d for the DB connection):
       python3 backfill.py -d localhost --days 7

  B) From another qclog2 SQLite DB (offline, no scmaster needed):
       seiscomp-python backfill.py --source-db /path/to/qc.db [--days 30]
       # useful for seeding a new deployment from an existing one via scp:
       #   scp mainbox:/opt/seiscomp/var/run/qclog2/qc.db /tmp/qc_import.db
       #   seiscomp-python backfill.py --source-db /tmp/qc_import.db --days 30

Config is read from config.json next to this file (same as backend.py).
"""

from __future__ import print_function
import csv
import json
import os
import sqlite3
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path


def _adopt_scmaster_env():
    """Copy environment from the running scmaster process.

    Mirrors what run_backfill.sh does in bash, so this script can be
    invoked directly (python3 backfill.py -d localhost --days 4) without
    a wrapper that pre-loads the SeisComP environment.
    """
    try:
        pid = subprocess.check_output(
            ['pgrep', '-f', 'scmaster'], text=True
        ).split()[0].strip()
        with open(f'/proc/{pid}/environ', 'rb') as fh:
            for item in fh.read().split(b'\x00'):
                if b'=' in item:
                    key, _, val = item.partition(b'=')
                    os.environ.setdefault(key.decode(), val.decode())
    except Exception:
        pass  # not on Linux or scmaster not running — proceed as-is


_adopt_scmaster_env()

from seiscomp import core, client, datamodel


# ── Parameter normalisation (mirrors backend.py) ──────────────────────────────

_PARAM_MAP = {
    'availability':      'availability',
    'delay':             'delay',
    'latency':           'latency',
    'rms':               'rms',
    'timing quality':    'timing_quality',
    'offset':            'offset',
    'gaps count':        'gaps_count',
    'overlaps count':    'overlaps_count',
    'spikes count':      'spikes_count',
    'outage':            'outage',
    'gaps interval':     'gaps_interval',
    'overlaps interval': 'overlaps_interval',
    'spikes interval':   'spikes_interval',
}
PARAM_ORDER = [
    'availability', 'delay', 'latency', 'timing_quality',
    'rms', 'offset', 'gaps_count', 'overlaps_count', 'spikes_count', 'outage',
]
KNOWN_PARAMS = set(PARAM_ORDER)

def _norm_param(p):
    normalized = _PARAM_MAP.get(p.lower().strip(), p.lower().replace(' ', '_'))
    return normalized if normalized in KNOWN_PARAMS else None

def _sc_time_to_ms(t):
    return t.seconds() * 1000 + t.microseconds() // 1000

def _load_config():
    cfg_path = Path(__file__).parent / 'config.json'
    try:
        with open(cfg_path) as f:
            return json.load(f)
    except Exception:
        return {}

def _atomic_write(path, content):
    tmp = str(path) + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(content, f, separators=(',', ':'))
    os.replace(tmp, path)


# ── SQLite DB setup (mirrors backend.py) ──────────────────────────────────────

def _open_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, check_same_thread=False, timeout=60)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=NORMAL')
    db.execute('''
        CREATE TABLE IF NOT EXISTS qc_raw (
            stream    TEXT    NOT NULL,
            time_ms   INTEGER NOT NULL,
            parameter TEXT    NOT NULL,
            value     REAL    NOT NULL
        )''')
    db.execute('''
        CREATE TABLE IF NOT EXISTS qc_hourly (
            stream    TEXT    NOT NULL,
            hour_ms   INTEGER NOT NULL,
            parameter TEXT    NOT NULL,
            avg       REAL    NOT NULL,
            min       REAL    NOT NULL,
            max       REAL    NOT NULL,
            count     INTEGER NOT NULL,
            PRIMARY KEY (stream, hour_ms, parameter)
        )''')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_unique ON qc_raw(stream, time_ms, parameter)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_raw ON qc_raw(stream, parameter, time_ms DESC)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_raw_time ON qc_raw(time_ms)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_hourly ON qc_hourly(stream, parameter, hour_ms DESC)')
    db.commit()
    return db


# ── JSON generation (mirrors backend.py) ─────────────────────────────────────

def _rollup_hourly(db, raw_retention_h):
    now_ms  = int(time.time() * 1000)
    cutoff  = now_ms - raw_retention_h * 3600 * 1000
    hour_ms = 3600 * 1000
    old_rows = db.execute('''
        SELECT stream, (time_ms/?) * ? AS hour, parameter,
               AVG(value), MIN(value), MAX(value), COUNT(*)
        FROM qc_raw WHERE time_ms < ?
        GROUP BY stream, parameter, hour
    ''', (hour_ms, hour_ms, cutoff)).fetchall()
    if old_rows:
        db.executemany('''
            INSERT INTO qc_hourly (stream, hour_ms, parameter, avg, min, max, count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(stream, hour_ms, parameter) DO UPDATE SET
                avg   = (avg*count + excluded.avg*excluded.count) / (count + excluded.count),
                min   = MIN(min, excluded.min),
                max   = MAX(max, excluded.max),
                count = count + excluded.count
        ''', old_rows)
        db.execute('DELETE FROM qc_raw WHERE time_ms < ?', (cutoff,))
        db.commit()

def _write_current(db, output_dir):
    now_ms  = int(time.time() * 1000)
    cutoff  = now_ms - 24 * 3600 * 1000
    rows = db.execute('''
        SELECT stream, parameter, value, time_ms FROM qc_raw
        WHERE time_ms >= ? AND time_ms = (
            SELECT MAX(r2.time_ms) FROM qc_raw r2
            WHERE r2.stream=qc_raw.stream AND r2.parameter=qc_raw.parameter
              AND r2.time_ms >= ?
        ) ORDER BY stream, parameter
    ''', (cutoff, cutoff)).fetchall()
    streams = {}
    for stream, param, value, ts in rows:
        if stream not in streams: streams[stream] = {}
        streams[stream][param] = {'v': round(value, 4), 't': ts}
    spark_rows = db.execute('''
        SELECT stream, parameter, hour_ms, avg FROM qc_hourly
        WHERE hour_ms >= ? ORDER BY stream, parameter, hour_ms
    ''', (cutoff,)).fetchall()
    sparks = {}
    for stream, param, hour_ms, avg in spark_rows:
        if stream not in sparks: sparks[stream] = {}
        if param not in sparks[stream]: sparks[stream][param] = []
        sparks[stream][param].append([hour_ms, round(avg, 4)])
    for stream, params in sparks.items():
        if stream not in streams: streams[stream] = {}
        for param, points in params.items():
            if param in streams[stream]: streams[stream][param]['spark'] = points
            else: streams[stream][param] = {'v': None, 't': None, 'spark': points}
    _atomic_write(Path(output_dir) / 'qc_current.json',
                  {'generated': now_ms, 'params': PARAM_ORDER, 'streams': streams})

def _write_24h(db, output_dir):
    now_ms  = int(time.time() * 1000)
    cutoff  = now_ms - 24 * 3600 * 1000
    bin_ms  = 10 * 60 * 1000
    rows = db.execute('''
        SELECT stream, parameter, (time_ms/?) * ? AS bin, AVG(value)
        FROM qc_raw WHERE time_ms >= ?
        GROUP BY stream, parameter, bin ORDER BY stream, parameter, bin
    ''', (bin_ms, bin_ms, cutoff)).fetchall()
    streams = {}
    for stream, param, bin_val, avg in rows:
        if stream not in streams: streams[stream] = {}
        if param not in streams[stream]: streams[stream][param] = []
        streams[stream][param].append([bin_val, round(avg, 4)])
    _atomic_write(Path(output_dir) / 'qc_24h.json', {'generated': now_ms, 'streams': streams})

def _write_7d(db, output_dir):
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - 7 * 24 * 3600 * 1000
    rows = db.execute('''
        SELECT stream, parameter, hour_ms, avg FROM qc_hourly
        WHERE hour_ms >= ? ORDER BY stream, parameter, hour_ms
    ''', (cutoff,)).fetchall()
    streams = {}
    for stream, param, hour_ms, avg in rows:
        if stream not in streams: streams[stream] = {}
        if param not in streams[stream]: streams[stream][param] = []
        streams[stream][param].append([hour_ms, round(avg, 4)])
    _atomic_write(Path(output_dir) / 'qc_7d.json', {'generated': now_ms, 'streams': streams})


# ── Mode B: import from another qclog2 SQLite DB ──────────────────────────────

def _import_from_sqlite(source_path, dest_db, days):
    cutoff_ms = int(time.time() * 1000) - days * 86400 * 1000
    src = sqlite3.connect(source_path)

    rows = src.execute(
        'SELECT stream, time_ms, parameter, value FROM qc_raw WHERE time_ms >= ?',
        (cutoff_ms,)
    ).fetchall()
    print(f'[backfill] {len(rows)} raw rows from {source_path}')
    if rows:
        dest_db.executemany(
            'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
            rows
        )

    # Hourly rollup — merge via ON CONFLICT
    h_rows = src.execute(
        'SELECT stream, hour_ms, parameter, avg, min, max, count FROM qc_hourly WHERE hour_ms >= ?',
        (cutoff_ms,)
    ).fetchall()
    print(f'[backfill] {len(h_rows)} hourly rows from {source_path}')
    if h_rows:
        dest_db.executemany('''
            INSERT INTO qc_hourly (stream, hour_ms, parameter, avg, min, max, count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(stream, hour_ms, parameter) DO UPDATE SET
                avg   = (avg*count + excluded.avg*excluded.count) / (count + excluded.count),
                min   = MIN(min, excluded.min),
                max   = MAX(max, excluded.max),
                count = count + excluded.count
        ''', h_rows)

    dest_db.commit()
    src.close()


# ── Mode C: import from MariaDB CSV export ────────────────────────────────────

def _import_from_csv(csv_path, dest_db):
    """Import from a MariaDB INTO OUTFILE CSV of WaveformQuality.

    Expected columns (no header):
      networkCode, stationCode, locationCode, channelCode, parameter, start, value

    Generate with:
      SELECT COALESCE(waveformID_networkCode,''),
             COALESCE(waveformID_stationCode,''),
             COALESCE(waveformID_locationCode,''),
             COALESCE(waveformID_channelCode,''),
             parameter, start, value
      FROM WaveformQuality
      WHERE start >= '2026-06-13 01:50:00' AND start < '2026-06-14 09:00:00'
      INTO OUTFILE '/tmp/wq_gap.csv'
      FIELDS TERMINATED BY ',' LINES TERMINATED BY '\\n';
    """
    buf   = []
    count = 0
    skip  = 0
    with open(csv_path, newline='', encoding='utf-8') as probe:
        first = probe.readline()
    delim = '\t' if '\t' in first else ','
    with open(csv_path, newline='', encoding='utf-8') as fh:
        for row in csv.reader(fh, delimiter=delim):
            if len(row) < 7:
                skip += 1
                continue
            net, sta, loc, cha, raw_param, start_str, raw_value = row[:7]
            param = _norm_param(raw_param)
            if param is None:
                skip += 1
                continue
            try:
                dt = datetime.strptime(start_str.strip(), '%Y-%m-%d %H:%M:%S')
                ts_ms = int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
                value = float(raw_value)
            except (ValueError, OSError):
                skip += 1
                continue
            stream = f'{net}.{sta}.{loc}.{cha}'
            buf.append((stream, ts_ms, param, value))
            count += 1
            if len(buf) >= 500:
                dest_db.executemany(
                    'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value)'
                    ' VALUES (?,?,?,?)', buf)
                dest_db.commit()
                buf.clear()
                print(f'[backfill]   {count} rows inserted, {skip} skipped…',
                      end='\r', flush=True)
    if buf:
        dest_db.executemany(
            'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value)'
            ' VALUES (?,?,?,?)', buf)
        dest_db.commit()
    print(f'\n[backfill] CSV import done: {count} rows inserted, {skip} skipped.')


# ── Mode A: SeisComP application ──────────────────────────────────────────────

class BackfillApp(client.Application):

    def __init__(self, argc, argv):
        client.Application.__init__(self, argc, argv)
        self.setMessagingEnabled(False)
        self.setDatabaseEnabled(True, True)

        cfg = _load_config()
        self._db_path    = cfg.get('db_path',        str(Path(__file__).parent / 'qc.db'))
        self._output_dir = cfg.get('output_dir',     str(Path(__file__).parent))
        self._raw_ret_h  = cfg.get('raw_retention_h', 25)
        self._days       = 7
        self._source_db  = None
        self._source_csv = None

    def createCommandLineDescription(self):
        self.commandline().addGroup('Backfill')
        self.commandline().addIntOption(
            'Backfill', 'days',
            'Number of days of history to import (default: 7)')
        self.commandline().addStringOption(
            'Backfill', 'source-db',
            'Mode B: import from another qclog2 SQLite DB instead of SeisComP database')
        self.commandline().addStringOption(
            'Backfill', 'source-csv',
            'Mode C: import from a MariaDB CSV export of WaveformQuality')
        return True

    def validateParameters(self):
        if not client.Application.validateParameters(self):
            return False
        try:
            self._days = self.commandline().optionInt('days')
        except RuntimeError:
            pass
        try:
            self._source_db = self.commandline().optionString('source-db')
        except RuntimeError:
            pass
        try:
            self._source_csv = self.commandline().optionString('source-csv')
        except RuntimeError:
            pass
        if self._days < 1 or self._days > 365:
            print('[backfill] --days must be between 1 and 365', file=sys.stderr)
            return False
        return True

    def run(self):
        local_db = _open_db(self._db_path)
        print(f'[backfill] DB:     {self._db_path}')
        print(f'[backfill] Output: {self._output_dir}')
        print(f'[backfill] Days:   {self._days}')

        if self._source_csv:
            # ── Mode C ──────────────────────────────────────────────────
            print(f'[backfill] Mode C: importing from CSV {self._source_csv}')
            _import_from_csv(self._source_csv, local_db)
        elif self._source_db:
            # ── Mode B ──────────────────────────────────────────────────
            print(f'[backfill] Mode B: importing from {self._source_db}')
            _import_from_sqlite(self._source_db, local_db, self._days)
        else:
            # ── Mode A ──────────────────────────────────────────────────
            print('[backfill] Mode A: querying SeisComP database')
            db = self.database()
            if not db:
                print('[backfill] ERROR: no database connection.\n'
                      '  Check that -d <connection> is set and the SeisComP database is reachable.\n'
                      '  Alternatively use --source-db to import from another qclog2 DB.',
                      file=sys.stderr)
                return False

            query = datamodel.DatabaseQuery(db)

            now_ms    = int(time.time() * 1000)
            cutoff_ms = now_ms - self._days * 86400 * 1000

            sc_start = core.Time(cutoff_ms // 1000, (cutoff_ms % 1000) * 1000)
            sc_end   = core.Time.GMT()

            buf     = []
            count   = 0
            skipped = 0

            # Query one day at a time — a single multi-day query can be very
            # slow on large SC databases (full table scan, millions of rows).
            day_ms = 86_400_000
            for day in range(self._days, 0, -1):
                d_start_ms = now_ms - day * day_ms
                d_end_ms   = d_start_ms + day_ms
                d_start    = core.Time(d_start_ms // 1000, (d_start_ms % 1000) * 1000)
                d_end      = core.Time(d_end_ms   // 1000, (d_end_ms   % 1000) * 1000)
                day_label  = f'day {self._days - day + 1}/{self._days}'
                print(f'[backfill] Querying {day_label}…', flush=True)
                try:
                    it = query.getWaveformQuality(d_start, d_end)
                    while it.get():
                        wfq = datamodel.WaveformQuality.Cast(it.get())
                        if wfq:
                            wid    = wfq.waveformID()
                            stream = (f'{wid.networkCode()}.{wid.stationCode()}.'
                                      f'{wid.locationCode()}.{wid.channelCode()}')
                            ts_ms  = _sc_time_to_ms(wfq.start())
                            param  = _norm_param(wfq.parameter())
                            if param is None:
                                skipped += 1
                                it.next()
                                continue
                            value = wfq.value()
                            buf.append((stream, ts_ms, param, value))
                            count += 1
                            if len(buf) >= 500:
                                local_db.executemany(
                                    'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value)'
                                    ' VALUES (?,?,?,?)',
                                    buf)
                                local_db.commit()
                                buf.clear()
                                print(f'[backfill]   {count} rows inserted, {skipped} skipped…',
                                      end='\r', flush=True)
                        it.next()
                    # Flush remainder for this day
                    if buf:
                        local_db.executemany(
                            'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value)'
                            ' VALUES (?,?,?,?)',
                            buf)
                        local_db.commit()
                        buf.clear()
                    print(f'[backfill]   {count} rows inserted so far ({day_label} done)',
                          flush=True)

                except Exception:
                    print(f'\n[backfill] ERROR on {day_label}:', file=sys.stderr)
                    traceback.print_exc()
                    print('[backfill] Hint: try --source-db mode as a fallback.', file=sys.stderr)
                    return False

            if buf:
                local_db.executemany(
                    'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
                    buf)
                local_db.commit()

            print(f'\n[backfill] Imported {count} WaveformQuality records')

        # ── Regenerate everything ────────────────────────────────────────
        print('[backfill] Running hourly rollup...')
        _rollup_hourly(local_db, self._raw_ret_h)

        print('[backfill] Writing JSON files...')
        _write_current(local_db, self._output_dir)
        _write_24h(local_db, self._output_dir)
        _write_7d(local_db, self._output_dir)

        print(f'[backfill] Done.')
        return True


app = BackfillApp(len(sys.argv), sys.argv)
sys.exit(app())
