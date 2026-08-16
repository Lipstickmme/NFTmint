import {
  checkAuth,
  loadProxyConfig,
  proxyRequest,
  ProxyConfigError,
} from '../src/proxy.js';

/** Vercel route: GET /api/health — upstream tracker liveness. */

interface Req {
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
    res.status(500).json({ ok: false, error: message });
    return;
  }

  const authorization = req.headers.authorization;
  if (!checkAuth(config, typeof authorization === 'string' ? authorization : undefined)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const { status, body } = await proxyRequest(config, '/api/health');
  res.status(status).json(body);
}
