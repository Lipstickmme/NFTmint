import { describe, it, expect } from 'vitest';
import {
  loadProxyConfig,
  proxyRequest,
  checkAuth,
  ProxyConfigError,
  type ProxyConfig,
} from '../src/proxy.js';

const baseConfig: ProxyConfig = {
  upstreamUrl: 'https://tracker.example.com',
  timeoutMs: 1_000,
};

describe('loadProxyConfig', () => {
  it('reads the upstream URL and strips trailing slashes', () => {
    const cfg = loadProxyConfig({
      TRACKER_UPSTREAM_URL: 'https://tracker.example.com///',
    } as NodeJS.ProcessEnv);
    expect(cfg.upstreamUrl).toBe('https://tracker.example.com');
  });

  it('explains what to do when the upstream is missing', () => {
    expect(() => loadProxyConfig({} as NodeJS.ProcessEnv)).toThrow(ProxyConfigError);
    expect(() => loadProxyConfig({} as NodeJS.ProcessEnv)).toThrow(/nftmint serve/);
  });

  it('rejects a non-http upstream', () => {
    expect(() =>
      loadProxyConfig({ TRACKER_UPSTREAM_URL: 'wss://nope' } as NodeJS.ProcessEnv),
    ).toThrow(/must be an http\(s\) URL/);
  });

  it('picks up optional tokens', () => {
    const cfg = loadProxyConfig({
      TRACKER_UPSTREAM_URL: 'http://localhost:8080',
      TRACKER_UPSTREAM_TOKEN: 'upstream-secret',
      DASHBOARD_TOKEN: 'public-secret',
    } as NodeJS.ProcessEnv);
    expect(cfg.upstreamToken).toBe('upstream-secret');
    expect(cfg.publicToken).toBe('public-secret');
  });
});

describe('checkAuth', () => {
  it('allows everything when no token is configured', () => {
    expect(checkAuth(baseConfig, undefined)).toBe(true);
  });

  it('requires a matching bearer token when configured', () => {
    const cfg = { ...baseConfig, publicToken: 'secret' };
    expect(checkAuth(cfg, 'Bearer secret')).toBe(true);
    expect(checkAuth(cfg, 'bearer secret')).toBe(true);
    expect(checkAuth(cfg, 'Bearer wrong')).toBe(false);
    expect(checkAuth(cfg, undefined)).toBe(false);
  });
});

describe('proxyRequest', () => {
  it('forwards the path and query, and returns the upstream body', async () => {
    let seenUrl = '';
    const fakeFetch = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ collections: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await proxyRequest(
      baseConfig,
      '/api/collections',
      '?limit=10',
      fakeFetch,
    );

    expect(seenUrl).toBe('https://tracker.example.com/api/collections?limit=10');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ collections: [] });
  });

  it('attaches the upstream bearer token when configured', async () => {
    let seenAuth: string | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await proxyRequest({ ...baseConfig, upstreamToken: 'tok' }, '/api/health', '', fakeFetch);
    expect(seenAuth).toBe('Bearer tok');
  });

  it('reports a readable error when the upstream is unreachable', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await proxyRequest(baseConfig, '/api/health', '', fakeFetch);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'upstream unreachable' });
  });

  it('reports a timeout distinctly from an unreachable upstream', async () => {
    const fakeFetch = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    const result = await proxyRequest(baseConfig, '/api/health', '', fakeFetch);
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ error: 'upstream timed out' });
  });

  it('does not leak an HTML error page into the dashboard', async () => {
    const fakeFetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;

    const result = await proxyRequest(baseConfig, '/api/health', '', fakeFetch);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'upstream returned non-JSON' });
  });

  it('passes through an upstream error status', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const result = await proxyRequest(baseConfig, '/api/collections', '', fakeFetch);
    expect(result.status).toBe(401);
  });
});
