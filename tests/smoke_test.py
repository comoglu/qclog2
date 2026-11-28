#!/usr/bin/env python3
"""Frontend smoke test: load the demo in headless Chrome and click through
every view. Fails on any JavaScript exception or console error, or when a view
does not render.

    python3 tests/smoke_test.py               # run all checks
    python3 tests/smoke_test.py --shots DIR   # also save a screenshot per check

Needs Google Chrome or Chromium and the websocket-client package
(pip install websocket-client). Serves the repo itself on a free local port and
uses the synthetic demo data (?demo=1), so no backend is needed. Map tiles are
not loaded: the default base map is the bundled offline outline.
"""
import argparse, base64, functools, http.server, json, os, shutil, socket
import subprocess, sys, tempfile, threading, time, urllib.request

import websocket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(port):
    handler = functools.partial(QuietHandler, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def find_chrome():
    for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'):
        if shutil.which(name):
            return shutil.which(name)
    sys.exit('Chrome/Chromium not found')


class Browser:
    """Minimal Chrome DevTools Protocol client."""

    def __init__(self):
        self.port = free_port()
        self.profile = tempfile.mkdtemp(prefix='qclog2-smoke-')
        self.proc = subprocess.Popen(
            [find_chrome(), '--headless=new', '--disable-gpu', '--no-first-run',
             f'--remote-debugging-port={self.port}', f'--user-data-dir={self.profile}',
             'about:blank'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json'))
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError('Chrome did not start')
        page = next(t for t in tabs if t['type'] == 'page')
        self.ws = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30)
        self.n = 0
        self.errors = []
        self.call('Runtime.enable')
        self.call('Emulation.setDeviceMetricsOverride', width=1600, height=900,
                  deviceScaleFactor=1, mobile=False)

    def _event(self, m):
        if m.get('method') == 'Runtime.exceptionThrown':
            d = m['params']['exceptionDetails']
            self.errors.append('exception: ' + d.get('exception', {}).get('description', d.get('text', '')))
        elif m.get('method') == 'Runtime.consoleAPICalled' and m['params']['type'] == 'error':
            self.errors.append('console.error: ' + ' '.join(
                str(a.get('value', a.get('description', ''))) for a in m['params']['args']))

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == self.n:
                return m
            self._event(m)

    def js(self, expr):
        r = self.call('Runtime.evaluate', expression=expr, awaitPromise=True, returnByValue=True)
        res = r.get('result', {})
        if 'exceptionDetails' in res:
            raise AssertionError(res['exceptionDetails'].get('exception', {}).get('description', 'JS error'))
        return res.get('result', {}).get('value')

    def wait(self, expr, timeout=10):
        """Poll a JS expression until it is truthy; return its value."""
        end = time.time() + timeout
        while time.time() < end:
            v = self.js(expr)
            if v:
                return v
            time.sleep(0.2)
        raise AssertionError(f'timed out waiting for: {expr}')

    def screenshot(self, path):
        data = self.call('Page.captureScreenshot', format='png')['result']['data']
        with open(path, 'wb') as f:
            f.write(base64.b64decode(data))

    def close(self):
        self.proc.kill()
        self.proc.wait()
        shutil.rmtree(self.profile, ignore_errors=True)


# Each check: (name, JS setup to run, JS condition that must become truthy)
CHECKS = [
    ('table', "switchView('table')",
     "document.querySelectorAll('#qc-tbody tr.stream-row').length > 0"),
    ('table filter', "document.getElementById('filter-net').value='XB';"
                     "document.getElementById('filter-net').dispatchEvent(new Event('change'))",
     "[...document.querySelectorAll('#qc-tbody tr.stream-row')].every(r => r.dataset.stream.startsWith('XB.'))"),
    ('side chart', "document.getElementById('filter-net').value='';"
                   "document.getElementById('filter-net').dispatchEvent(new Event('change'));"
                   "document.querySelector('.qc-cell[data-param]').click()",
     "!!document.querySelector('#chart-wrap .uplot')"),
    ('grid', "closeChart(); switchView('grid')",
     "document.querySelectorAll('.sta-card').length > 0"),
    ('map', "switchView('map')",
     "Object.keys(_mapMarkers).length > 0 && document.querySelectorAll('#map .ol-land').length > 0"),
    ('map antimeridian',
     # Demo XD stations straddle 180°: drawn in one piece (station longitudes
     # within 180° of each other) and the view centred on them, not on 0°
     "",
     "!!_lonShift && S.coordinates['XD.LOMA'][1] > 180"
     " && (l => Math.max(...l) - Math.min(...l) < 180)(Object.values(S.coordinates).map(c => c[1]))"
     " && _map.getCenter().lng > 100"
     " && lonShiftFor([-150, -160, -135, 173, -176]).by === -360"      # Alaska + Aleutians
     " && lonShiftFor([140, 150, 155]) === null"                        # compact, no shift
     " && lonShiftFor([-120, 0, 120]) === null"),                       # worldwide, no shift
    ('map attention list', "",
     "document.querySelectorAll('.map-prob').length > 0"),
    ('map popup', "document.querySelector('.map-prob').click()",
     "!!document.querySelector('.leaflet-popup .mp-chip')"),
    ('map colour by', "const c=document.getElementById('map-color'); c.value='latency';"
                      "c.dispatchEvent(new Event('change'))",
     "S.mapColor === 'latency' && Object.keys(_mapMarkers).length > 0"),
    ('map hide OK', "document.querySelector('.map-count[data-status=ok]').click()",
     "Object.values(_mapMarkers).length < Object.keys(S.coordinates).length"),
    ('map plates', "const p=document.getElementById('map-plates'); p.checked=true;"
                   "p.dispatchEvent(new Event('change'))",
     "!!_platesLayer && _map.hasLayer(_platesLayer)"),
    ('history', "switchView('history'); populateHistStream();"
                "const s=document.getElementById('hist-stream'); s.value=s.options[1].value; loadHistoryChart()",
     "!!document.querySelector('#history-chart-wrap .uplot')"),
    ('overlay', "switchView('overlay')",
     "document.getElementById('overlay-chart-wrap').classList.contains('js-plotly-plot')"),
    ('heatmap', "switchView('heatmap')",
     "(c => c && c.width > 0)(document.getElementById('heatmap-canvas'))"),
    ('events', "switchView('events')",
     "document.querySelectorAll('#events-tbody tr').length > 0"),
    ('dark theme', "document.getElementById('theme-toggle').click(); switchView('map')",
     "document.body.classList.contains('dark') && Object.keys(_mapMarkers).length > 0"),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--shots', help='directory for a screenshot per check')
    args = ap.parse_args()
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)

    port = free_port()
    srv = serve(port)
    b = Browser()
    failed = 0
    try:
        b.call('Page.navigate', url=f'http://127.0.0.1:{port}/index.html?demo=1')
        b.wait("typeof S !== 'undefined' && !!S.data", timeout=20)
        for i, (name, setup, cond) in enumerate(CHECKS, 1):
            before = len(b.errors)
            try:
                if setup:
                    b.js(setup)
                b.wait(cond)
                new = b.errors[before:]
                if new:
                    raise AssertionError('; '.join(new))
                print(f'ok    {name}')
            except AssertionError as e:
                failed += 1
                print(f'FAIL  {name}: {e}')
            if args.shots:
                b.screenshot(os.path.join(args.shots, f'{i:02d}-{name.replace(" ", "-")}.png'))
    finally:
        b.close()
        srv.shutdown()

    print(f'\n{len(CHECKS) - failed}/{len(CHECKS)} checks passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
