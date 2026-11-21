#!/usr/bin/env seiscomp-python
# -*- coding: utf-8 -*-
"""
qclog2 backfill — seeds the local qclog2 SQLite DB with historical QC data,
then regenerates all JSON files.  Designed to be run once after first deploy,
or any time you want to re-import history.  The normal backend.py continues
handling real-time data from the messaging system independently.

Three modes:

  A) From the SeisComP database (recommended — needs -d for the DB connection):
       python3 backfill.py -d localhost --days 7

  B) From another qclog2 SQLite DB (offline, no scmaster needed):
       seiscomp-python backfill.py --source-db /path/to/qc.db [--days 30]
       # useful for seeding a new deployment from an existing one via scp:
       #   scp mainbox:/opt/seiscomp/var/run/qclog2/qc.db /tmp/qc_import.db
       #   seiscomp-python backfill.py --source-db /tmp/qc_import.db --days 30

  C) From a MariaDB CSV export of WaveformQuality (see _import_from_csv):
       seiscomp-python backfill.py --source-csv /tmp/wq.csv

Config is read from config.json next to this file (same as backend.py).
"""

from __future__ import print_function
import csv
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


# Shared DB schema, rollup and JSON writers live in backend.py so the two
# scripts can't drift apart (backend.py only starts its app under __main__).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backend import (                                       # noqa: E402
    _PARAM_MAP, PARAM_ORDER, _sc_time_to_ms, _load_config, _open_db,
    _rollup_hourly, _write_current, _write_24h, _write_3d, _write_7d,
    _write_30d, _backup_db,
)

# Backfill drops parameters the dashboard doesn't display (e.g. *_interval).
KNOWN_PARAMS = set(PARAM_ORDER)

def _norm_param(p):
    normalized = _PARAM_MAP.get(p.lower().strip(), p.lower().replace(' ', '_'))
    return normalized if normalized in KNOWN_PARAMS else None


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
        self._raw_ret_h  = cfg.get('raw_retention_h', 72)
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
        # Backup before touching anything (consistent even if backend is running)
        _backup_db(self._db_path)

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
        _write_3d(local_db, self._output_dir)
        _write_7d(local_db, self._output_dir)
        _write_30d(local_db, self._output_dir)

        print(f'[backfill] Done.')
        return True


if __name__ == '__main__':
    app = BackfillApp(len(sys.argv), sys.argv)
    sys.exit(app())
