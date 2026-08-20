import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';
import { loadWalletKeys } from '../config.js';
import { RpcClient } from '../rpc.js';
import { loadWallets } from '../wallet.js';
import { resolveTarget } from '../resolve.js';
import { buildMintPlan } from '../mintplan.js';

/**
 * GET /api/plan?target=<address or link>&quantity=1
 *
 * One call that turns "here is a collection" into "here is exactly how to mint
 * it": resolves the address out of whatever was pasted, reads supply, price and
 * sale state, then finds a mint entrypoint the contract actually accepts by
 * simulating each candidate.
 *
 * This is what removes the need for anyone to know a function signature or
 * paste raw calldata.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['GET'], limit: 'read' }, async (_body, query) => {
    const target = query.get('target') ?? query.get('contract') ?? '';
    const quantity = Number(query.get('quantity') ?? 1);

    const resolved = resolveTarget(target);

    const cfg = loadWalletKeys();
    const client = new RpcClient(cfg.rpcUrls[0], { timeoutMs: 10_000, maxSockets: 8 });
    try {
      const wallet = loadWallets(cfg.privateKeys)[0].address;
      const plan = await buildMintPlan(client, resolved.contract, wallet, {
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      });
      return { resolvedVia: resolved.via, ...plan };
    } finally {
      client.destroy();
    }
  });
}
