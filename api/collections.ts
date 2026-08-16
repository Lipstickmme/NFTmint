import {
  checkAuth,
  loadProxyConfig,
  proxyRequest,
  ProxyConfigError,
} from '../src/proxy.js';

/**
 * Vercel route: GET /api/collections
 *
 * Forwards to the durable tracker process. This function holds no keys and
 * cannot sign anything — by design, the public surface has no ability to spend.
 */

interface Req {
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status: (code: number) => Res;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('cache-control', 'no-store');

  let config;
  try {
    config = loadProxyConfig();
  } catch (err) {
    const message = err instanceof ProxyConfigError ? err.message : String(err);
    res.status(500).json({ error: message });
    return;
  }

  const authorization = req.headers.authorization;
  if (!checkAuth(config, typeof authorization === 'string' ? authorization : undefined)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const search = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const { status, body } = await proxyRequest(config, '/api/collections', search);
  res.status(status).json(body);
}
