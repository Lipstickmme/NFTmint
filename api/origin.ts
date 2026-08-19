import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadHuntRuntime } from '../src/config.js';
import { describeOrigin } from '../src/origin.js';
import { authenticateAccount } from '../src/accountstore.js';

/**
 * GET /api/origin — the route your mints take onto the chain.
 *
 * Reports the provider, region and measured latency of every endpoint in play,
 * and which one a mint will actually leave through. When an account is signed
 * in and has set its own RPC, that endpoint is measured alongside the
 * deployment's so the two can be compared directly — which is the whole point
 * of letting people bring their own.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const accountId = header(req, 'x-account-id');
  const accountToken = header(req, 'x-account-token');
  const asAccount = Boolean(accountId && accountToken);

  await handleApi(
    req,
    res,
    { methods: ['GET'], publicRoute: asAccount, limit: 'read' },
    async () => {
      // Endpoint measurement needs no wallets, so the keys are not required.
      const config = loadHuntRuntime(process.env, false);

      let rpcUrls = config.rpcUrls;
      if (asAccount) {
        const account = await authenticateAccount(accountId, accountToken);
        if (account.rpcUrl) rpcUrls = [account.rpcUrl, ...rpcUrls];
      }

      return describeOrigin({
        network: config.network,
        chainId: config.chainId,
        rpcUrls,
        submitOnlyUrls: config.submitOnlyUrls ?? [],
      });
    },
  );
}

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
