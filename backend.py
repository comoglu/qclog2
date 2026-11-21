#!/usr/bin/env seiscomp-python
# -*- coding: utf-8 -*-
"""
qclog2 backend — listens to scqc messages via scmaster, stores in SQLite,
periodically writes qc_current.json and qc_24h.json for the frontend.

Run:
  seiscomp-python backend.py -H localhost
  or via systemd (see qclog2-backend.service)
"""

from __future__ import print_function
import json
import os
import sqlite3
import sys
import threading
import time
import traceback
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from seiscomp import core, client, datamodel


# ── Parameter name normalisation ─────────────────────────────────────────────
# scqc sends human-readable strings; we normalise to snake_case JSON keys
_PARAM_MAP = {
    'availability':     'availability',
    'delay':            'delay',
    'latency':          'latency',
    'rms':              'rms',
    'timing quality':   'timing_quality',
    'offset':           'offset',
    'gaps count':       'gaps_count',
    'overlaps count':   'overlaps_count',
    'spikes count':     'spikes_count',
    'outage':           'outage',
    'gaps interval':    'gaps_interval',
    'overlaps interval':'overlaps_interval',
    'spikes interval':  'spikes_interval',
}

# Display order for the frontend grid
PARAM_ORDER = [
    'availability', 'delay', 'latency', 'timing_quality',
    'rms', 'offset', 'gaps_count', 'overlaps_count',
    'spikes_count', 'outage',
]


def _norm_param(p):
    return _PARAM_MAP.get(p.lower().strip(), p.lower().replace(' ', '_'))


def _sc_time_to_ms(t):
    """Convert SeisComP core.Time to epoch milliseconds (int)."""
    return t.seconds() * 1000 + t.microseconds() // 1000


def _load_config():
    cfg_path = Path(__file__).parent / 'config.json'
    try:
        with open(cfg_path) as f:
            return json.load(f)
    except Exception:
        return {}


# ── Database ──────────────────────────────────────────────────────────────────

def _ensure_unique_raw_index(db):
    """Create the (stream, time_ms, parameter) unique index that INSERT OR IGNORE
    relies on. Duplicates are removed first, but only when the index is missing,
    so the full-table scan happens once per database, not on every start."""
    exists = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_raw_unique'"
    ).fetchone()
    if exists:
        return
    print('[qclog2] Creating unique index on qc_raw (one-time, removing duplicates)…',
          flush=True)
    db.execute('''DELETE FROM qc_raw WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM qc_raw GROUP BY stream, time_ms, parameter)''')
    db.execute('CREATE UNIQUE INDEX idx_raw_unique ON qc_raw(stream, time_ms, parameter)')
    db.commit()


def _open_db(path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, check_same_thread=False, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=NORMAL')
    db.execute('PRAGMA busy_timeout=30000')
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
    _ensure_unique_raw_index(db)
    db.execute('CREATE INDEX IF NOT EXISTS idx_raw ON qc_raw(stream, parameter, time_ms DESC)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_raw_time ON qc_raw(time_ms)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_hourly ON qc_hourly(stream, parameter, hour_ms DESC)')
    db.commit()
    return db


# ── JSON generation ───────────────────────────────────────────────────────────

def _atomic_write(path, content):
    """Write JSON atomically so readers never see a partial file."""
    tmp = str(path) + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(content, f, separators=(',', ':'))
    os.replace(tmp, path)


def _hourly_series(db, from_ms, to_ms, param=None):
    """Hourly averages over [from_ms, to_ms] as (stream, parameter, hour_ms, avg).

    qc_hourly only holds data older than raw_retention_h; anything newer is
    still in qc_raw. Both are combined here, weighted by sample count, so an
    hour split across the rollup boundary is averaged correctly.
    """
    p_sql  = ' AND parameter = ?' if param else ''
    p_args = [param] if param else []
    return db.execute(f'''
        SELECT stream, parameter, hour, SUM(s) / SUM(n)
        FROM (
            SELECT stream, parameter, hour_ms AS hour, avg * count AS s, count AS n
            FROM qc_hourly
            WHERE hour_ms >= ? AND hour_ms <= ?{p_sql}
            UNION ALL
            SELECT stream, parameter, (time_ms / 3600000) * 3600000 AS hour,
                   SUM(value) AS s, COUNT(*) AS n
            FROM qc_raw
            WHERE time_ms >= ? AND time_ms <= ?{p_sql}
            GROUP BY stream, parameter, hour
        )
        GROUP BY stream, parameter, hour
        ORDER BY stream, parameter, hour
    ''', [from_ms, to_ms] + p_args + [from_ms, to_ms] + p_args).fetchall()


def _write_current(db, output_dir):
    """
    qc_current.json — latest value per stream per parameter, plus a 24-point
    sparkline at hourly resolution for each (used for mini inline charts).
    """
    now_ms = int(time.time() * 1000)
    cutoff  = now_ms - 24 * 3600 * 1000   # only consider last 24h

    # Latest value per (stream, parameter) within last 24h
    rows = db.execute('''
        SELECT stream, parameter, value, time_ms
        FROM qc_raw
        WHERE time_ms >= ?
        AND time_ms = (
            SELECT MAX(r2.time_ms) FROM qc_raw r2
            WHERE r2.stream = qc_raw.stream
              AND r2.parameter = qc_raw.parameter
              AND r2.time_ms >= ?
        )
        ORDER BY stream, parameter
    ''', (cutoff, cutoff)).fetchall()

    streams = {}
    for stream, param, value, ts in rows:
        if stream not in streams:
            streams[stream] = {}
        streams[stream][param] = {'v': round(value, 4), 't': ts}

    # Hourly sparklines (last 24 hours, raw + rolled-up)
    hour_cutoff = now_ms - 24 * 3600 * 1000
    spark_rows = _hourly_series(db, hour_cutoff, now_ms)

    sparks = {}
    for stream, param, hour_ms, avg in spark_rows:
        if stream not in sparks:
            sparks[stream] = {}
        if param not in sparks[stream]:
            sparks[stream][param] = []
        sparks[stream][param].append([hour_ms, round(avg, 4)])

    # Merge sparklines into stream dict
    for stream, params in sparks.items():
        if stream not in streams:
            streams[stream] = {}
        for param, points in params.items():
            if param in streams[stream]:
                streams[stream][param]['spark'] = points
            else:
                # param in history but not in recent raw — include anyway
                streams[stream][param] = {'v': None, 't': None, 'spark': points}

    _atomic_write(
        Path(output_dir) / 'qc_current.json',
        {'generated': now_ms, 'params': PARAM_ORDER, 'streams': streams}
    )


def _write_24h(db, output_dir):
    """
    qc_24h.json — last 24h at 10-minute resolution for interactive uPlot charts.
    Format: { generated, streams: { "N.S.L.C": { param: [[t_ms, v], ...] } } }
    """
    now_ms   = int(time.time() * 1000)
    cutoff   = now_ms - 24 * 3600 * 1000
    bin_ms   = 10 * 60 * 1000   # 10-minute bins

    rows = db.execute('''
        SELECT stream, parameter,
               (time_ms / ?) * ? AS bin,
               AVG(value) AS avg
        FROM qc_raw
        WHERE time_ms >= ?
        GROUP BY stream, parameter, bin
        ORDER BY stream, parameter, bin
    ''', (bin_ms, bin_ms, cutoff)).fetchall()

    streams = {}
    for stream, param, bin_ms_val, avg in rows:
        if stream not in streams:
            streams[stream] = {}
        if param not in streams[stream]:
            streams[stream][param] = []
        streams[stream][param].append([bin_ms_val, round(avg, 4)])

    _atomic_write(
        Path(output_dir) / 'qc_24h.json',
        {'generated': now_ms, 'bin_ms': bin_ms, 'streams': streams}
    )


def _write_7d(db, output_dir, rows=None):
    """
    qc_7d.json — last 7 days at hourly resolution (qc_hourly + recent qc_raw).

    Pass the rows returned by _write_30d() to reuse them: the raw-table part
    of _hourly_series() is the expensive bit and is identical for both.
    """
    now_ms  = int(time.time() * 1000)
    cutoff  = now_ms - 7 * 24 * 3600 * 1000

    if rows is None:
        rows = _hourly_series(db, cutoff, now_ms)
    else:
        rows = [r for r in rows if r[2] >= cutoff]

    streams = {}
    for stream, param, hour_ms, avg in rows:
        if stream not in streams:
            streams[stream] = {}
        if param not in streams[stream]:
            streams[stream][param] = []
        streams[stream][param].append([hour_ms, round(avg, 4)])

    _atomic_write(
        Path(output_dir) / 'qc_7d.json',
        {'generated': now_ms, 'bin_ms': 3_600_000, 'streams': streams}
    )


def _write_3d(db, output_dir):
    """qc_3d.json — last 3 days at 10-minute resolution.

    Uses qc_raw for the recent portion and falls back to qc_hourly for the
    older portion that has already been rolled up, so the full 3-day window
    is always populated regardless of raw_retention_h.
    """
    now_ms   = int(time.time() * 1000)
    cutoff   = now_ms - 3 * 24 * 3600 * 1000
    bin_ms   = 10 * 60 * 1000

    # Find the oldest raw row so we know where to fill from qc_hourly.
    oldest_raw = (db.execute('SELECT MIN(time_ms) FROM qc_raw').fetchone()[0]
                  or now_ms)

    streams = {}

    def add_rows(rows):
        for stream, param, bin_val, avg in rows:
            streams.setdefault(stream, {}).setdefault(param, []).append(
                [bin_val, round(avg, 4)])

    # Hourly fill-in for the gap between 3d-ago and where raw starts.
    # Expand each hourly point into 6 x 10-min bins so the heatmap sees
    # uniform 10-min resolution throughout (no 1-in-6 sparse holes).
    if oldest_raw > cutoff:
        hourly = db.execute('''
            SELECT stream, parameter, hour_ms AS bin, avg
            FROM qc_hourly
            WHERE hour_ms >= ? AND hour_ms < ?
            ORDER BY stream, parameter, hour_ms
        ''', (cutoff, oldest_raw)).fetchall()
        expanded = [
            (stream, param, hour_bin + i * bin_ms, avg)
            for stream, param, hour_bin, avg in hourly
            for i in range(6)
        ]
        add_rows(expanded)

    # 10-minute bins from qc_raw for the recent portion.
    add_rows(db.execute('''
        SELECT stream, parameter,
               (time_ms / ?) * ? AS bin,
               AVG(value) AS avg
        FROM qc_raw
        WHERE time_ms >= ?
        GROUP BY stream, parameter, bin
        ORDER BY stream, parameter, bin
    ''', (bin_ms, bin_ms, cutoff)).fetchall())

    for pdata in streams.values():
        for pts in pdata.values():
            pts.sort(key=lambda x: x[0])

    _atomic_write(
        Path(output_dir) / 'qc_3d.json',
        {'generated': now_ms, 'bin_ms': bin_ms, 'streams': streams}
    )


def _write_30d(db, output_dir):
    """qc_30d.json — last 30 days at hourly resolution (qc_hourly + recent qc_raw)."""
    now_ms = int(time.time() * 1000)
    cutoff = now_ms - 30 * 24 * 3600 * 1000

    rows = _hourly_series(db, cutoff, now_ms)

    streams = {}
    for stream, param, hour_ms, avg in rows:
        if stream not in streams:
            streams[stream] = {}
        if param not in streams[stream]:
            streams[stream][param] = []
        streams[stream][param].append([hour_ms, round(avg, 4)])

    _atomic_write(
        Path(output_dir) / 'qc_30d.json',
        {'generated': now_ms, 'bin_ms': 3_600_000, 'streams': streams}
    )
    return rows


def _write_health(output_dir, stream_count, msg_count):
    """health.json — written every json_interval; shows backend is alive."""
    _atomic_write(
        Path(output_dir) / 'health.json',
        {
            'ok':           True,
            'ts':           int(time.time() * 1000),
            'streams':      stream_count,
            'messages':     msg_count,
        }
    )


# ── On-demand query API ──────────────────────────────────────────────────────

class _APIHandler(BaseHTTPRequestHandler):
    """Minimal HTTP handler for arbitrary time-range QC queries.

    GET /api/qc?from=<epoch_ms>&to=<epoch_ms>[&param=<name>]
    Returns JSON compatible with the pre-built qc_24h/qc_7d files plus
    a 'bin_ms' field so the frontend knows the resolution returned.

    Resolution is chosen automatically:
      span ≤ 2 h  → 1-min bins  (from qc_raw)
      span ≤ 48 h → 10-min bins (from qc_raw)
      span > 48 h → 1-h bins    (from qc_hourly, up to 31 days)
    """
    db_path: str = ''

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip('/') != '/api/qc':
            self.send_error(404)
            return

        qs = parse_qs(parsed.query)
        try:
            from_ms = int(qs['from'][0])
            to_ms   = int(qs['to'][0])
        except (KeyError, ValueError, IndexError):
            self.send_error(400, 'Missing or invalid from / to (epoch ms)')
            return

        if to_ms <= from_ms:
            self.send_error(400, 'to must be after from')
            return

        span = to_ms - from_ms
        if span > 31 * 86_400_000:
            self.send_error(400, 'Range exceeds 31 days')
            return

        param = qs.get('param', [None])[0]  # optional filter

        # Pick resolution
        if span <= 2 * 3_600_000:
            bin_ms = 60_000          # 1 min
        elif span <= 48 * 3_600_000:
            bin_ms = 10 * 60_000     # 10 min
        else:
            bin_ms = 3_600_000       # 1 h

        p_sql  = ' AND parameter = ?' if param else ''
        p_args = [param] if param else []

        db = sqlite3.connect(self.db_path, check_same_thread=True)
        try:
            if span <= 48 * 3_600_000:
                rows = db.execute(
                    'SELECT stream, parameter, (time_ms/?) * ? AS bin, AVG(value) '
                    'FROM qc_raw WHERE time_ms >= ? AND time_ms <= ?' + p_sql +
                    ' GROUP BY stream, parameter, bin',
                    [bin_ms, bin_ms, from_ms, to_ms] + p_args).fetchall()

                # Raw rows older than raw_retention_h have been rolled up into
                # qc_hourly. Fill that part of the window from qc_hourly,
                # repeating each hourly value across its sub-hour bins so the
                # resolution looks uniform (same approach as _write_3d).
                oldest_raw = db.execute('SELECT MIN(time_ms) FROM qc_raw').fetchone()[0]
                fill_to = min(to_ms, oldest_raw) if oldest_raw is not None else to_ms
                if fill_to > from_ms:
                    hourly = db.execute(
                        'SELECT stream, parameter, hour_ms, avg FROM qc_hourly '
                        'WHERE hour_ms >= ? AND hour_ms < ?' + p_sql,
                        [from_ms - 3_600_000, fill_to] + p_args).fetchall()
                    per_hour = 3_600_000 // bin_ms
                    rows += [
                        (s, p, b, avg)
                        for s, p, hour_ms, avg in hourly
                        for b in (hour_ms + i * bin_ms for i in range(per_hour))
                        if from_ms <= b < fill_to
                    ]
                rows.sort(key=lambda r: (r[0], r[1], r[2]))
            else:
                rows = _hourly_series(db, from_ms, to_ms, param)
        except Exception:
            traceback.print_exc()
            self.send_error(500, 'Query failed')
            return
        finally:
            db.close()

        streams = {}
        for stream, p, bin_val, avg in rows:
            if stream not in streams:
                streams[stream] = {}
            if p not in streams[stream]:
                streams[stream][p] = []
            streams[stream][p].append([bin_val, round(avg, 4)])

        payload = json.dumps({
            'generated': int(time.time() * 1000),
            'from':      from_ms,
            'to':        to_ms,
            'bin_ms':    bin_ms,
            'streams':   streams,
        }, separators=(',', ':')).encode()

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):  # noqa: A002
        pass  # suppress per-request stdout noise


def _start_api(db_path, port):
    _APIHandler.db_path = db_path
    srv = ThreadingHTTPServer(('127.0.0.1', port), _APIHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    print(f'[qclog2] API listening on 127.0.0.1:{port}/api/qc', flush=True)


# ── Maintenance ───────────────────────────────────────────────────────────────

def _backup_db(db_path):
    """Write a consistent snapshot of qc.db to qc.db.bak.

    Uses SQLite's online backup API, which is safe while the database is
    being written (a plain file copy of a WAL-mode DB can be inconsistent
    and misses the -wal file). The snapshot goes to a temp file first so an
    interrupted backup never replaces the previous good one.
    """
    src_path = Path(db_path)
    if not src_path.exists():
        return
    bak = src_path.with_suffix('.db.bak')
    tmp = src_path.with_suffix('.db.bak.tmp')
    try:
        src = sqlite3.connect(str(src_path), timeout=60)
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        os.replace(tmp, bak)
        print(f'[qclog2] Backup written: {bak}', flush=True)
    except Exception:
        traceback.print_exc()
        try:
            tmp.unlink()
        except OSError:
            pass


def _rollup_hourly(db, raw_retention_h):
    """
    Aggregate raw rows older than raw_retention_h into qc_hourly, then prune them.
    Called once per hour.
    """
    now_ms   = int(time.time() * 1000)
    cutoff   = now_ms - raw_retention_h * 3600 * 1000
    hour_ms  = 3600 * 1000

    # Find raw rows outside retention window
    old_rows = db.execute('''
        SELECT stream,
               (time_ms / ?) * ? AS hour,
               parameter,
               AVG(value), MIN(value), MAX(value), COUNT(*)
        FROM qc_raw
        WHERE time_ms < ?
        GROUP BY stream, parameter, hour
    ''', (hour_ms, hour_ms, cutoff)).fetchall()

    if old_rows:
        db.executemany('''
            INSERT INTO qc_hourly (stream, hour_ms, parameter, avg, min, max, count)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(stream, hour_ms, parameter) DO UPDATE SET
                avg   = (avg * count + excluded.avg * excluded.count) / (count + excluded.count),
                min   = MIN(min, excluded.min),
                max   = MAX(max, excluded.max),
                count = count + excluded.count
        ''', old_rows)
        db.execute('DELETE FROM qc_raw WHERE time_ms < ?', (cutoff,))
        db.commit()
        db.execute('PRAGMA wal_checkpoint(PASSIVE)')

    # Prune hourly rows older than 30 days
    hourly_cutoff = now_ms - 30 * 24 * 3600 * 1000
    db.execute('DELETE FROM qc_hourly WHERE hour_ms < ?', (hourly_cutoff,))
    db.commit()


# ── SeisComP Application ──────────────────────────────────────────────────────

class QCBackend(client.Application):

    def __init__(self, argc, argv):
        client.Application.__init__(self, argc, argv)
        self.setMessagingEnabled(True)
        self.setMessagingUsername('qclog2')
        self.addMessagingSubscription('QC')
        self.setDatabaseEnabled(False, False)

        cfg = _load_config()
        self._db_path       = cfg.get('db_path',       str(Path(__file__).parent / 'qc.db'))
        self._output_dir    = cfg.get('output_dir',    str(Path(__file__).parent))
        self._json_interval = cfg.get('json_interval', 60)
        self._raw_ret_h     = cfg.get('raw_retention_h', 72)
        self._api_port      = cfg.get('api_port', 8765)

        self._db            = None
        self._insert_buf    = []       # batch inserts
        self._buf_limit     = 100
        self._last_json     = 0
        self._last_rollup   = 0
        self._last_3d       = 0
        self._last_7d       = 0
        self._last_backup   = 0
        self._msg_count     = 0
        self._seen_streams  = set()

    def run(self):
        try:
            self._db = _open_db(self._db_path)
            print(f'[qclog2] DB: {self._db_path}', flush=True)
            print(f'[qclog2] Output: {self._output_dir}', flush=True)
            _start_api(self._db_path, self._api_port)
            return client.Application.run(self)
        except Exception:
            traceback.print_exc()
            return False

    def handleMessage(self, msg):
        try:
            dm = core.DataMessage.Cast(msg)
            if not dm:
                return

            now = time.time()
            for att in dm:
                wfq = datamodel.WaveformQuality.Cast(att)
                if not wfq:
                    continue
                wid = wfq.waveformID()
                stream = f'{wid.networkCode()}.{wid.stationCode()}.{wid.locationCode()}.{wid.channelCode()}'
                ts_ms  = _sc_time_to_ms(wfq.start())
                param  = _norm_param(wfq.parameter())
                value  = wfq.value()
                self._insert_buf.append((stream, ts_ms, param, value))
                self._msg_count += 1
                self._seen_streams.add(stream)

            # Flush buffer
            if len(self._insert_buf) >= self._buf_limit:
                self._flush()

            # Periodic tasks
            if now - self._last_json >= self._json_interval:
                self._flush()
                self._write_json()
                self._last_json = now

            if now - self._last_rollup >= 3600:
                _rollup_hourly(self._db, self._raw_ret_h)
                self._last_rollup = now

            if now - self._last_3d >= 600:
                _write_3d(self._db, self._output_dir)
                self._last_3d = now

            if now - self._last_7d >= 3600:
                rows_30d = _write_30d(self._db, self._output_dir)
                _write_7d(self._db, self._output_dir, rows_30d)
                self._last_7d = now

            if now - self._last_backup >= 86400:
                _backup_db(self._db_path)
                self._last_backup = now

        except Exception:
            traceback.print_exc()

    def _flush(self):
        if not self._insert_buf:
            return
        self._db.executemany(
            'INSERT OR IGNORE INTO qc_raw (stream, time_ms, parameter, value) VALUES (?,?,?,?)',
            self._insert_buf
        )
        self._db.commit()
        self._insert_buf.clear()

    def _write_json(self):
        try:
            _write_current(self._db, self._output_dir)
            _write_24h(self._db, self._output_dir)
            _write_3d(self._db, self._output_dir)
            _write_health(self._output_dir, len(self._seen_streams), self._msg_count)
            print(f'[qclog2] JSON written at {time.strftime("%H:%M:%S")}', flush=True)
        except Exception:
            traceback.print_exc()


if __name__ == '__main__':
    app = QCBackend(len(sys.argv), sys.argv)
    sys.exit(app())
