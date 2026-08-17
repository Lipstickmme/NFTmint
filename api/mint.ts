import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { runMintService } from '../src/service.js';

/**
 * POST /api/mint — pre-sign and broadcast a mint immediately.
 *
 * This is the only endpoint that spends. It is authenticated, capped by
 * MAX_MINT_VALUE_ETH, and fires with TRIGGER_MODE forced to `now`: a
 * serverless function cannot outlive its request waiting for a drop, so
 * scheduling belongs to a Cron job calling this endpoint at the right moment.
 *
 * Body (all optional; each falls back to the environment):
 *   contract, network, mintFunction, mintArgs, calldata, priceEth, quantity,
 *   valueEth, gasLimit, maxFeeGwei, txPerWallet, requireSimulation, dryRun
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['POST'], limit: 'mint' }, async (body) => runMintService(body));
}
