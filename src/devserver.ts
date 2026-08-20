import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { log } from './logger.js';
import type { ApiRequest, ApiResponse } from './http.js';

/**
 * Local development server.
 *
 * Mounts the exact same handler modules Vercel deploys, over a plain Node
 * server. That means the UI can be exercised end to end before deploying, and
 * a bug in a route shows up here rather than in production — the routes are
 * the same code, only the adapter differs.
 */

type Handler = (req: ApiRequest, res: ApiResponse) => Promise<void>;

const ROUTES: Record<string, () => Promise<{ default: Handler }>> = {
  '/api/health': () => import('../api/health.js') as Promise<{ default: Handler }>,
  '/api/status': () => import('../api/status.js') as Promise<{ default: Handler }>,
  '/api/preflight': () => import('../api/preflight.js') as Promise<{ default: Handler }>,
  '/api/mint': () => import('../api/mint.js') as Promise<{ default: Handler }>,
  '/api/scan': () => import('../api/scan.js') as Promise<{ default: Handler }>,
  '/api/hunt': () => import('../api/hunt.js') as Promise<{ default: Handler }>,
  '/api/plan': () => import('../api/plan.js') as Promise<{ default: Handler }>,
  '/api/inspect': () => import('../api/inspect.js') as Promise<{ default: Handler }>,
  '/api/collections': () => import('../api/collections.js') as Promise<{ default: Handler }>,
  '/api/findings': () => import('../api/findings.js') as Promise<{ default: Handler }>,
  '/api/account': () => import('../api/account.js') as Promise<{ default: Handler }>,
  '/api/origin': () => import('../api/origin.js') as Promise<{ default: Handler }>,
  '/api/live': () => import('../api/live.js') as Promise<{ default: Handler }>,
  '/api/mintnow': () => import('../api/mintnow.js') as Promise<{ default: Handler }>,
};

function adaptResponse(res: http.ServerResponse): ApiResponse {
  let statusCode = 200;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
    },
    send(body: string) {
      res.writeHead(statusCode);
      res.end(body);
    },
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startDevServer(port: number): Promise<http.Server> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.join(here, '..', 'public', 'index.html');

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      const route = ROUTES[url.pathname];
      if (route) {
        try {
          const mod = await route();
          const apiReq: ApiRequest = {
            method: req.method,
            url: req.url,
            headers: req.headers as Record<string, string | string[] | undefined>,
            body: req.method === 'POST' || req.method === 'PATCH' ? await readBody(req) : undefined,
          };
          await mod.default(apiReq, adaptResponse(res));
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
          );
        }
        return;
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        try {
          const html = await readFile(indexPath, 'utf8');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('public/index.html not found');
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  log.info('Dev server running', {
    ui: `http://127.0.0.1:${port}/`,
    routes: Object.keys(ROUTES).length,
  });
  return server;
}
