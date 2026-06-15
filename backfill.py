#!/usr/bin/env seiscomp-python
# -*- coding: utf-8 -*-
"""
qclog2 backfill — seeds the local qclog2 SQLite DB with historical QC data,
then regenerates all JSON files.  Designed to be run once after first deploy,
or any time you want to re-import history.  The normal backend.py continues
handling real-time data from the messaging system independently.

Two modes:

  A) From the SeisComP database (recommended — needs -H host):
       seiscomp-python backfill.py -H localhost [--days 7]

  B) From another qclog2 SQLite DB (offline, no scmaster needed):
       seiscomp-python backfill.py --source-db /path/to/qc.db [--days 30]
       # useful for seeding a new deployment from an existing one via scp:
       #   scp mainbox:/opt/seiscomp/var/run/qclog2/qc.db /tmp/qc_import.db
       #   seiscomp-python backfill.py --source-db /tmp/qc_import.db --days 30

Config is read from config.json next to this file (same as backend.py).
"""

from __future__ import print_function
import json
import os
import sqlite3
import subprocess
import sys
import time
import traceback
from pathlib import Path


def _adopt_scmaster_env():
    """Copy environment from the running scmaster process.

    Mirrors what run_backfill.sh does in bash, so this script can be
    invoked directly (python3 backfill.py -H localhost --days 4) without
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

    # Raw rows — delete then re-insert to avoid duplicates
    dest_db.execute('DELETE FROM qc_raw WHERE time_ms >= ?', (cutoff_ms,))
    rows = src.execute(
        'SELECT stream, time_ms, parameter, value FROM qc_raw WHERE time_ms >= ?',
        (cutoff_ms,)
    ).fetchall()
    print(f'[backfill] {len(rows)} raw rows from {source_path}')
    if rows:
        dest_db.executemany(
            'INSERT INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
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

    def createCommandLineDescription(self):
        self.commandline().addGroup('Backfill')
        self.commandline().addIntOption(
            'Backfill', 'days',
            'Number of days of history to import (default: 7)')
        self.commandline().addStringOption(
            'Backfill', 'source-db',
            'Mode B: import from another qclog2 SQLite DB instead of SeisComP database')
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
        if self._days < 1 or self._days > 365:
            print('[backfill] --days must be between 1 and 365', file=sys.stderr)
            return False
        return True

    def run(self):
        local_db = _open_db(self._db_path)
        print(f'[backfill] DB:     {self._db_path}')
        print(f'[backfill] Output: {self._output_dir}')
        print(f'[backfill] Days:   {self._days}')

        if self._source_db:
            # ── Mode B ──────────────────────────────────────────────────
            print(f'[backfill] Mode B: importing from {self._source_db}')
            _import_from_sqlite(self._source_db, local_db, self._days)
        else:
            # ── Mode A ──────────────────────────────────────────────────
            print('[backfill] Mode A: querying SeisComP database')
            db = self.database()
            if not db:
                print('[backfill] ERROR: no database connection.\n'
                      '  Check that -H <host> is set and the SeisComP database is reachable.\n'
                      '  Alternatively use --source-db to import from another qclog2 DB.',
                      file=sys.stderr)
                return False

            query = datamodel.DatabaseQuery(db)

            now_ms    = int(time.time() * 1000)
            cutoff_ms = now_ms - self._days * 86400 * 1000

            sc_start = core.Time(cutoff_ms // 1000, (cutoff_ms % 1000) * 1000)
            sc_end   = core.Time.GMT()

            # Clear existing raw rows in the import window (prevent duplicates)
            local_db.execute('DELETE FROM qc_raw WHERE time_ms >= ?', (cutoff_ms,))
            local_db.commit()

            buf   = []
            count = 0
            skipped = 0

            print('[backfill] Executing SC database query (may take a minute)…', flush=True)
            try:
                it = query.getWaveformQuality(sc_start, sc_end)
                print('[backfill] Streaming rows…', flush=True)
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
                        value  = wfq.value()
                        buf.append((stream, ts_ms, param, value))
                        count += 1
                        if len(buf) >= 500:
                            local_db.executemany(
                                'INSERT INTO qc_raw (stream, time_ms, parameter, value)'
                                ' VALUES (?,?,?,?)',
                                buf)
                            local_db.commit()
                            buf.clear()
                            print(f'[backfill]   {count} rows inserted, {skipped} skipped…',
                                  end='\r', flush=True)
                    it.next()

            except Exception:
                # Flush whatever was buffered before giving up
                if buf:
                    try:
                        local_db.executemany(
                            'INSERT INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
                            buf)
                        local_db.commit()
                    except Exception:
                        pass
                print('\n[backfill] ERROR querying SeisComP database:', file=sys.stderr)
                traceback.print_exc()
                print('\n[backfill] Hint: try --source-db mode as a fallback.', file=sys.stderr)
                return False

            if buf:
                local_db.executemany(
                    'INSERT INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
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
