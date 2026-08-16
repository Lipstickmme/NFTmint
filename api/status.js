import { handleApi } from '../src/http.js';
import { getStatus } from '../src/service.js';
/**
 * GET /api/status — chain reachability, endpoint latency, wallet balances.
 *
 * Authenticated: it derives wallet addresses from the configured keys, and
 * those should not be public.
 */
export default async function handler(req, res) {
    await handleApi(req, res, { methods: ['GET'] }, async () => getStatus());
}
//# sourceMappingURL=status.js.map