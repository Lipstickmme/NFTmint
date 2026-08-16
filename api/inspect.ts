import { isAddress, type Address } from 'viem';
import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadWalletKeys } from '../src/config.js';
import { RpcClient } from '../src/rpc.js';
import { inspectContract } from '../src/inspect.js';
import { loadWallets } from '../src/wallet.js';

/**
 * GET /api/inspect?contract=0x… — read a collection's live state.
 *
 * Answers the questions the feed cannot: how much supply is left, what it
 * costs, whether the sale is open, and whether this wallet already holds one.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['GET'] }, async (_body, query) => {
    const contract = query.get('contract')?.trim();
    if (!contract || !isAddress(contract)) {
      const err = new Error('Pass ?contract=0x… with a valid address');
      err.name = 'ConfigError'; // reported as a 400, not a 500
      throw err;
    }

    const cfg = loadWalletKeys();
    const client = new RpcClient(cfg.rpcUrls[0], { timeoutMs: 8_000 });
    try {
      const wallet = loadWallets(cfg.privateKeys)[0]?.address;
      return await inspectContract(client, contract as Address, wallet);
    } finally {
      client.destroy();
    }
  });
}
