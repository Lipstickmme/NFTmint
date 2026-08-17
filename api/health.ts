import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadProxyConfig, proxyRequest } from '../src/proxy.js';
import { buildInfo } from '../src/version.js';

/**
 * GET /api/health — deployment readiness.
 *
 * Public, so the UI can tell you what is wrong before you have a token. It
 * reports only whether things are *configured*, never their values, so an
 * unauthenticated caller learns nothing exploitable.
 *
 * When TRACKER_UPSTREAM_URL points at a persistent tracker, its health is
 * included too.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['GET'], publicRoute: true }, async () => {
    const env = process.env;
    const configured = {
      apiToken: Boolean(env.API_TOKEN?.trim()),
      privateKeys: Boolean(env.PRIVATE_KEYS?.trim()),
      rpcUrls: Boolean(env.RPC_URLS?.trim()),
      network: env.NETWORK?.trim() || 'testnet',
      spendCeilingEth: env.MAX_MINT_VALUE_ETH?.trim() || '0.05',
      upstreamTracker: Boolean(env.TRACKER_UPSTREAM_URL?.trim()),
    };

    const problems: string[] = [];
    if (!configured.apiToken) {
      problems.push('API_TOKEN is not set — the mint endpoints will refuse to run.');
    }
    if (!configured.privateKeys) {
      problems.push('PRIVATE_KEYS is not set — minting is unavailable.');
    }
    if (!configured.rpcUrls) {
      problems.push(
        'RPC_URLS is not set — falling back to the public endpoint, which is rate limited.',
      );
    }

    let upstream: unknown;
    if (configured.upstreamTracker) {
      try {
        const { body } = await proxyRequest(loadProxyConfig(), '/api/health');
        upstream = body;
      } catch {
        upstream = { error: 'upstream tracker unreachable' };
      }
    }

    // Included so a stale front end can be identified in one request, without
    // needing a token.
    return { ok: problems.length === 0, build: buildInfo(), configured, problems, upstream };
  });
}
