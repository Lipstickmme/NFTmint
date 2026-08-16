import { handleApi } from '../src/http.js';
import { loadProxyConfig, proxyRequest } from '../src/proxy.js';
/**
 * GET /api/collections — live leaderboard from a persistent tracker.
 *
 * Optional. Only useful when TRACKER_UPSTREAM_URL points at a machine running
 * `nftmint serve`, which can hold the sequencer feed open continuously. For a
 * Vercel-only deployment use /api/scan instead, which samples a window inside
 * a single invocation.
 */
export default async function handler(req, res) {
    await handleApi(req, res, { methods: ['GET'] }, async (_body, query) => {
        const config = loadProxyConfig();
        const search = query.toString();
        const { status, body } = await proxyRequest(config, '/api/collections', search ? `?${search}` : '');
        if (status >= 400) {
            throw new Error(typeof body === 'object' && body !== null && 'error' in body
                ? String(body.error)
                : `upstream returned ${status}`);
        }
        return body;
    });
}
//# sourceMappingURL=collections.js.map