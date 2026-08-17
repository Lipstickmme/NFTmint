import http from 'node:http';
import { log } from './logger.js';
import type { MintTracker } from './tracker.js';

/**
 * Status server for the tracker.
 *
 * The tracker's state lives in a long-running process holding a WebSocket to
 * the sequencer feed. A serverless function cannot hold that connection, so
 * the durable process owns the data and exposes it over HTTP; a dashboard —
 * on Vercel or anywhere else — reads from here.
 *
 * That split is also the safer arrangement: the dashboard needs no private
 * keys, so the public-facing surface has no ability to spend.
 */

export interface ServerOptions {
  port: number;
  host?: string;
  /** When set, requests must send `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Origin allowed to read the API from a browser. */
  corsOrigin?: string;
}

export function startStatusServer(
  tracker: MintTracker,
  options: ServerOptions,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const cors = options.corsOrigin ?? '*';
    res.setHeader('access-control-allow-origin', cors);
    res.setHeader('access-control-allow-headers', 'authorization,content-type');
    res.setHeader('vary', 'origin');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // The dashboard HTML is public; the data endpoints are what we gate.
    const needsAuth = options.authToken !== undefined && url.pathname.startsWith('/api/');
    if (needsAuth) {
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (provided !== options.authToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };

    switch (url.pathname) {
      case '/api/health':
        return json(200, {
          ok: true,
          uptimeSec: Math.round(process.uptime()),
          ...tracker.stats(),
        });

      case '/api/collections': {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500);
        const freeOnly = url.searchParams.get('free') === 'true';
        let rows = tracker.snapshot(limit);
        if (freeOnly) rows = rows.filter((r) => r.isFree);
        return json(200, {
          generatedAt: new Date().toISOString(),
          config: {
            velocityWindowSec: tracker.config.velocityWindowSec,
            minAttempts: tracker.config.minAttempts,
            minUniqueMinters: tracker.config.minUniqueMinters,
          },
          stats: tracker.stats(),
          collections: rows,
        });
      }

      case '/':
      case '/index.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;

      default:
        return json(404, { error: 'not found' });
    }
  });

  // Bind loopback unless told otherwise. Reaching this from a Vercel dashboard
  // needs a public bind, but that has to be a deliberate choice rather than
  // something a local `npm run serve` does by accident.
  const host = options.host ?? '127.0.0.1';
  const isPublic = host === '0.0.0.0' || host === '::';

  server.listen(options.port, host, () => {
    log.info('Status server listening', {
      url: `http://${host}:${options.port}`,
      authRequired: options.authToken !== undefined,
    });
    if (isPublic && options.authToken === undefined) {
      log.warn(
        'This server is reachable from the network with NO token. Anyone who finds ' +
          'it can read your tracker data. Set TRACKER_AUTH_TOKEN, or bind to 127.0.0.1.',
      );
    }
  });

  return server;
}

/**
 * Self-contained dashboard. No build step and no external assets, so it works
 * behind a bare HTTP server and inside a Vercel function alike.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mint Tracker</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --fg:#e6e9ef; --dim:#8b93a7;
          --line:#232833; --hot:#ff8a3d; --free:#3ddc97; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --fg:#14171f; --dim:#5d6577; --line:#e3e6ec; }
  }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; padding:24px; }
  h1 { font-size:16px; margin:0 0 4px; letter-spacing:.02em; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:20px; }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:720px; }
  th,td { text-align:right; padding:7px 10px; border-bottom:1px solid var(--line);
          white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase;
       letter-spacing:.04em; }
  tr.hot td { color:var(--hot); font-weight:600; }
  .free { color:var(--free); }
  .stats { color:var(--dim); font-size:12px; margin-top:16px; }
  .err { color:#ff6b6b; }
</style>
</head>
<body>
<h1>Mint Tracker &mdash; Robinhood Chain</h1>
<div class="sub" id="sub">connecting&hellip;</div>
<div class="wrap">
<table>
  <thead><tr>
    <th>Contract</th><th>In window</th><th>Total</th><th>Unique</th>
    <th>Free</th><th>Age (s)</th><th>Per min</th>
  </tr></thead>
  <tbody id="rows"></tbody>
</table>
</div>
<div class="stats" id="stats"></div>
<script>
const fmt = n => Number(n).toLocaleString();
async function tick() {
  try {
    const res = await fetch('/api/collections?limit=40', { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    document.getElementById('sub').textContent =
      'window ' + data.config.velocityWindowSec + 's \\u00b7 threshold ' +
      data.config.minAttempts + ' mints / ' + data.config.minUniqueMinters +
      ' unique \\u00b7 updated ' + new Date(data.generatedAt).toLocaleTimeString();
    document.getElementById('rows').innerHTML = data.collections.map(c =>
      '<tr class="' + (c.flagged ? 'hot' : '') + '">' +
      '<td>' + c.contract + '</td>' +
      '<td>' + fmt(c.attemptsInWindow) + '</td>' +
      '<td>' + fmt(c.attempts) + '</td>' +
      '<td>' + fmt(c.uniqueMinters) + '</td>' +
      '<td class="' + (c.isFree ? 'free' : '') + '">' + (c.isFree ? 'yes' : 'no') + '</td>' +
      '<td>' + c.ageSec + '</td>' +
      '<td>' + c.attemptsPerMinute + '</td></tr>').join('');
    document.getElementById('stats').textContent = JSON.stringify(data.stats);
  } catch (err) {
    document.getElementById('sub').innerHTML =
      '<span class="err">' + err.message + '</span>';
  }
}
function authHeaders() {
  const t = new URLSearchParams(location.search).get('token');
  return t ? { authorization: 'Bearer ' + t } : {};
}
tick(); setInterval(tick, 4000);
</script>
</body>
</html>`;

export { DASHBOARD_HTML };
