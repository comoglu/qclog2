# qclog2

A real-time SeisComP QC monitoring dashboard. The backend subscribes to SeisComP's `QC` messaging group via `scmaster`, stores measurements in SQLite, and periodically writes JSON files that the frontend polls. No build step — the frontend is plain HTML/CSS/JS served statically.

**Live demo (synthetic data):** <https://comoglu.github.io/qclog2/> · **Slides:** [QCLog2_presentation.html](https://comoglu.github.io/qclog2/QCLog2_presentation.html)

![Table view with side-panel chart](docs/screenshots/panel.png)

| Heatmap | Overlay |
|---|---|
| ![Heatmap](docs/screenshots/heatmap.png) | ![Overlay](docs/screenshots/overlay.png) |
| **Grid** | **Map** |
| ![Grid](docs/screenshots/grid.png) | ![Map](docs/screenshots/map.png) |

---

## Features

- **Table view** — colour-coded grid of the latest value for every stream × parameter; click any cell to open a side-panel chart
- **Grid view** — compact 72 × 54 px station cards coloured by worst QC status, grouped by network; click any card to jump to Table view filtered to that station
- **Map view** — every station drawn (no clustering, so problems are never hidden), coloured by overall status or by one parameter; a *Needs attention* list with the reason and how long; per-station popup with all values and Chart/History links; recently changed stations pulse; respects the header filters. Base maps: an offline outline (Natural Earth, bundled, the default) or keyless tile services (OpenStreetMap, OpenTopoMap, NASA GIBS, USGS, Esri); optional plate boundaries (PB2002). Coordinates come from FDSNWS
- **History tab** — single-stream chart with presets 1 h / 6 h / 12 h / 24 h / 36 h / 3 d / 7 d / 14 d / 30 d / Custom date range; period status bar (% of time ok / warn / alert / no data); CSV export of one stream, all streams, or a per-stream period summary
- **Overlay tab** — Plotly multi-stream overlay for all streams on a single chart; comma-separated search filter with auto Y-axis rescaling
- **Heatmap tab** — canvas-based grid (streams × time bins) for pattern detection across all streams
- **Events log** — detects status transitions on every refresh cycle; browser notifications on alert/recovery
- **Configurable thresholds** — per-parameter warn/alert levels stored in `localStorage`; applied live to all views
- **Watchlist** — bookmark specific streams; filter to watchlisted streams only
- **Dark/light theme toggle**
- **CSV export**
- **Deep links** — open a specific view from a URL (see below)

---

## Demo mode

`index.html?demo=1` (and any `*.github.io` host, automatically) loads a synthetic dataset from `demo/` instead of the live backend. All stations and networks (XA / XB / XC) are invented. Timestamps are shifted on load so the data always looks current, and custom time ranges are served from the static files, so no backend is needed.

The dataset includes an ongoing station outage, a recovered 8 h outage, a slow telemetry link, a regional delay incident, GPS timing degradation, recurring gaps and a spike burst. Regenerate it with:

```bash
python3 demo/make_demo_data.py      # no SeisComP installation required
```

The generator pushes the data through the real backend code (`_rollup_hourly`, `_write_*`), so the files have exactly the live format.

## Deep links

Applied once after the first data load — useful for bookmarks and wall screens:

| URL parameter | Effect |
|---|---|
| `view=grid\|map\|history\|overlay\|heatmap\|events` | Open that tab |
| `stream=NET.STA.LOC.CHA` | With `view=history`: select the stream and load the chart |
| `param=latency` | Parameter for History / Overlay / Heatmap, or the Map colour |
| `range=6h\|24h\|3d\|7d\|30d` | Preset for all time pickers |
| `search=!MIRN,BHZ` | Overlay stream filter |
| `chart=NET.STA.LOC.CHA,latency` | Open the side-panel chart |

Example: `index.html?view=heatmap&param=latency&range=7d`

---

## Requirements

- [SeisComP](https://www.seiscomp.de/) with `scqc` and `scmaster` running
- Python 3.8+ (the `seiscomp-python` interpreter that ships with SeisComP)
- A web server (nginx recommended) to serve the static frontend files
- Optional: an FDSNWS station service (e.g. `fdsnws` module in SeisComP) for map coordinates

---

## Installation

### 1. Copy files to the deploy directory

```bash
DEPLOY=/opt/seiscomp/var/run/qclog2
sudo mkdir -p $DEPLOY
sudo chown $USER:$USER $DEPLOY

cp backend.py backfill.py run_backend.sh run_backfill.sh app.js index.html style.css $DEPLOY/
cp -r vendor/ $DEPLOY/vendor/
```

### 2. Create `config.json`

```bash
cp config.example.json $DEPLOY/config.json
```

Edit `$DEPLOY/config.json`:

| Key | Description | Default |
|-----|-------------|---------|
| `db_path` | Path to the SQLite database file | `…/qclog2/qc.db` |
| `output_dir` | Directory where JSON files are written | same as `db_path` parent |
| `json_interval` | Seconds between JSON writes | `60` |
| `raw_retention_h` | Hours to keep raw QC rows before rolling up to hourly | `72` |
| `hourly_retention_d` | Days to keep hourly rollup rows | `30` |
| `fdsnws` | FDSNWS base URL for station coordinates. Use a relative path (e.g. `/fdsnws`) if nginx proxies it; use a full URL only if the service is directly reachable from the browser. | `/fdsnws` |
| `api_port` | Port for the on-demand HTTP API (used by Custom time-range queries) | `8765` |
| `api_url` | URL prefix for the HTTP API as seen from the browser | `/api/qc` |
| `watchdog_min` | Exit (so systemd restarts the service) if no QC message arrives for this many minutes; `0` disables | `10` |

### 3. Install as a systemd service

```bash
sudo cp qclog2.service /etc/systemd/system/qclog2.service
```

Edit the service file to match your `User`, `SEISCOMP_ROOT`, and deploy path, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qclog2
sudo systemctl status qclog2
```

The service will restart automatically if it crashes.

### 4. Serve the frontend with nginx

Add a location block to your nginx site config:

```nginx
# Serve qclog2 dashboard
location /qclog2/ {
    alias /opt/seiscomp/var/run/qclog2/;
    try_files $uri $uri/ =404;
}

# On-demand QC query API (backend HTTP thread, default port 8765)
location /api/ {
    proxy_pass http://127.0.0.1:8765;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

# Proxy FDSNWS station service (adjust port to match your setup)
location /fdsnws/ {
    proxy_pass http://localhost:8081;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Then reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The dashboard is now available at `http://your-server/qclog2/`.

> **Tip:** Add `auth_basic` to the nginx location if you want password protection.

---

## Running the backend manually (development)

```bash
# Requires a running scmaster on localhost
seiscomp-python backend.py -H localhost

# Production wrapper — copies environment from running scmaster process
bash run_backend.sh -H localhost
```

### Frontend smoke test

Run before deploying frontend changes. It serves the repo locally, opens the
demo in headless Chrome and clicks through every view (table, filters, side
chart, grid, map, history, overlay, heatmap, events, dark theme). Any
JavaScript error or a view that doesn't render fails the run (exit code 1).

```bash
pip install websocket-client          # once; also needs Chrome or Chromium
python3 tests/smoke_test.py           # add --shots DIR for a screenshot per check
```

---

## Backfilling historical data

Run `backfill.py` once after first deploy to seed the database with past QC data. The normal backend continues handling real-time data independently.

### Mode A — from the SeisComP database (recommended)

```bash
seiscomp-python backfill.py -d localhost --days 7
# or a full connection string: -d mysql://sysop:PASSWORD@localhost/seiscomp
```

Options:

| Flag | Description |
|------|-------------|
| `-d DB` | SeisComP database connection (required for Mode A) |
| `--days N` | Days of history to import (1–365, default: 7) |

The SeisComP database only holds QC values if scqc archiving is enabled (`archive.interval` ≥ 0).

### Mode B — from another qclog2 SQLite database

Useful when seeding a new deployment from an existing one:

```bash
# Copy the database from the source server
scp mainbox:/opt/seiscomp/var/run/qclog2/qc.db /tmp/qc_import.db

# Import the last 30 days
seiscomp-python backfill.py --source-db /tmp/qc_import.db --days 30
```

### Mode C — from a MariaDB CSV export of `WaveformQuality`

```bash
seiscomp-python backfill.py --source-csv /tmp/wq.csv
```

The expected column order and the `SELECT … INTO OUTFILE` query are in the `_import_from_csv` docstring.

Backfill writes a backup (`qc.db.bak`) before importing and regenerates all JSON files when it finishes.

### Pruning old QC rows from the SeisComP database

If scqc archiving is on, `WaveformQuality` grows quickly. `strip_db.sh` deletes rows older than N days in batches, together with their matching `Object` rows (and nothing else):

```bash
bash strip_db.sh 7          # credentials from ~/.my.cnf, or MYSQL_OPTS="-u sysop -p"
```

---

## Architecture

```
scqc → scmaster → backend.py handleMessage()
                       │
                  qc_raw (SQLite)          ← raw rows, kept 72 h
                       │  (hourly rollup)
                  qc_hourly (SQLite)       ← hourly avg/min/max, kept 30 d
                       │  (every json_interval)
          qc_current.json                 ← latest values + hourly sparkline
          qc_24h.json                     ← 10-min bins, last 24 h
          qc_3d.json                      ← 10-min bins, last 3 d
                       │  (every hour)
          qc_7d.json                      ← hourly averages, last 7 d
          qc_30d.json                     ← hourly averages, last 30 d
                       │  (every json_interval)
          health.json                     ← alive check: ts, stream count, msg count
```

### Backend (`backend.py`)

- `QCBackend` extends `seiscomp.client.Application`
- Inserts are buffered (flush every 100 rows or `json_interval`)
- `_write_current()` — latest value + 24-point hourly sparkline per (stream, parameter)
- `_write_24h()` — 10-minute bins over the last 24 h from `qc_raw`
- `_write_3d()` — 10-minute bins over the last 3 d from `qc_raw`
- `_write_7d()` — hourly averages over the last 7 d (`qc_hourly` + recent `qc_raw`, via `_hourly_series()`)
- `_write_30d()` — hourly averages over the last 30 d (same)
- `_backup_db()` — daily consistent snapshot to `qc.db.bak` using SQLite's online backup API
- `_write_health()` — alive check JSON: timestamp, distinct stream count, total message count
- `_rollup_hourly()` — moves `qc_raw` rows older than `raw_retention_h` into `qc_hourly`, prunes old hourly rows, checkpoints the WAL

### Frontend (`app.js`)

Single global state object `S`. No framework, no build step.

- Polls `qc_current.json` on a configurable interval (default 60 s)
- History/Overlay time-range queries route to the right pre-built JSON file based on the selected span; Custom range queries the on-demand HTTP API
- Charts rendered with [uPlot](https://github.com/leeoniya/uPlot) (History, side panel) and [Plotly.js](https://plotly.com/javascript/) (Overlay)
- Map rendered with [Leaflet](https://leafletjs.com/). The default base map is drawn from [Natural Earth](https://www.naturalearthdata.com/) 1:50m land and borders (public domain, `geo/`), so it works without internet access. The tile options need no API key, but check each provider's terms for your use (OpenStreetMap asks heavy users to run their own tile server; Esri's terms ask for an ArcGIS account in production). Plate boundaries: Bird (2003), PB2002 (`geo/PB2002_boundaries.json`)
- All user preferences (thresholds, watchlist, FDSNWS URL) persisted to `localStorage`

---

## QC parameters

| Parameter | Description |
|-----------|-------------|
| `availability` | Data availability (%) |
| `delay` | Feed delay (s) |
| `latency` | Processing latency (s) |
| `timing_quality` | GPS timing quality (%) |
| `rms` | RMS amplitude |
| `offset` | DC offset |
| `gaps_count` | Number of data gaps |
| `overlaps_count` | Number of overlapping records |
| `spikes_count` | Number of spikes detected |

When a stream stops, scqc keeps reporting `latency` and `delay` (growing) and `availability` (dropping to 0) through its timeout handling; waveform-based parameters stop arriving and are shown greyed out as stale after 30 minutes.

### scqc load

scqc runs one instance of each plugin per stream, and with the default `report.interval = 60` every stream sends about 12 values per minute to the `QC` group. Load on scqc, scmaster and qclog2 therefore scales linearly with the number of streams. **Monitoring the vertical component only** (the scqc default, `use3Components = false`) is recommended; enabling three components roughly triples CPU, memory, message rate and storage.

---

## Health monitoring

`health.json` is written every `json_interval` seconds:

```json
{
  "ok": true,
  "ts": 1749639480000,
  "streams": 219,
  "messages": 45210
}
```

It is only rewritten while QC messages arrive, so its age is a direct measure of whether the feed is alive. The backend also has its own watchdog (`watchdog_min`): if messages stop it exits and systemd restarts it, which recovers a silently dropped scmaster connection. If scqc itself has stopped, a restart can't help, so also alert when `ts` gets old — for example:

```bash
# Example: cron check every 5 minutes
*/5 * * * * python3 -c "
import json, time, sys
d = json.load(open('/opt/seiscomp/var/run/qclog2/health.json'))
age = time.time() - d['ts']/1000
if age > 300: sys.exit(1)
" || mail -s 'qclog2 backend stale' admin@example.com
```

---

## Vendor libraries

All vendor libraries are bundled — no CDN dependency.

| Library | Version | License |
|---------|---------|---------|
| [Leaflet](https://leafletjs.com/) | 1.9.x | BSD-2-Clause |
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.x | MIT |
| [Plotly.js](https://plotly.com/javascript/) (basic build) | 2.35.2 | MIT |

---

## License

MIT
