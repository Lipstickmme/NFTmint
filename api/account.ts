import { formatEther, type Hex } from 'viem';
import {
  createAccount,
  normalizeRpcUrl,
  privateKeysOf,
  toView,
  WALLETS_PER_ACCOUNT,
} from '../src/accounts.js';
import {
  accountStorageKind,
  accountsAreDurable,
  authenticateAccount,
  saveAccount,
} from '../src/accountstore.js';
import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadHuntRuntime } from '../src/config.js';
import { RpcClient } from '../src/rpc.js';

/**
 * POST   /api/account            — sign up: ten fresh wallets and an access key
 * GET    /api/account            — your addresses and their balances
 * GET    /api/account?reveal=1   — your private keys
 * PATCH  /api/account            — set your own RPC, or pause auto-mint
 *
 * Authenticated by the account's own credentials — `x-account-id` and
 * `x-account-token` — not the operator's API_TOKEN, because these are the
 * routes an ordinary user of the app calls. Sign-up is the only route that
 * needs no credential at all, which is why it is the most tightly limited.
 *
 * The access key is shown exactly once, at sign-up. Only its hash is stored, so
 * it cannot be recovered or reset: losing it means losing the account, and the
 * UI says so before it disappears.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  await handleApi(
    req,
    res,
    {
      methods: ['GET', 'POST', 'PATCH'],
      publicRoute: true,
      limit: method === 'POST' ? 'signup' : 'account',
    },
    async (body, query) => {
      if (method === 'POST') return signUp();

      const account = await authenticateAccount(
        header(req, 'x-account-id'),
        header(req, 'x-account-token'),
      );

      if (method === 'PATCH') {
        if ('rpcUrl' in body) {
          const url = normalizeRpcUrl(String(body.rpcUrl ?? ''));
          account.rpcUrl = url || undefined;
        }
        if ('autoMint' in body) account.autoMint = Boolean(body.autoMint);
        await saveAccount(account);
        return { ...toView(account), saved: true };
      }

      if (query.get('reveal') === '1') {
        // Deliberately a separate request rather than part of the normal view,
        // so keys are never sitting in a response the page fetches on load.
        return {
          ...toView(account),
          keys: privateKeysOf(account).map(({ address, privateKey }) => ({
            address,
            privateKey,
          })),
          warning:
            'Anyone with these keys can spend anything the wallets hold. Keep them ' +
            'to gas money only, and never paste them anywhere else.',
        };
      }

      return { ...toView(account), wallets: await balances(account.rpcUrl, account) };
    },
  );
}

async function signUp(): Promise<Record<string, unknown>> {
  const { account, token } = createAccount();
  // Written before the key is returned, so an account can never exist only in
  // the response the client might drop.
  await saveAccount(account);

  // Storage is chosen from the environment, and the memory fallback loses keys
  // on restart. That is a footgun worth naming at the moment of creation.
  const durable = accountsAreDurable();
  return {
    ...toView(account),
    token,
    storage: accountStorageKind(),
    durable,
    notice: durable
      ? 'Save this key now. It is shown once and cannot be recovered.'
      : 'Save this key now — it is shown once. This deployment has no database ' +
        'attached, so these wallets will be lost on the next restart. Do not fund ' +
        'them until storage is configured.',
    walletCount: WALLETS_PER_ACCOUNT,
  };
}

/** Balances for the account's own wallets, via its RPC if it set one. */
async function balances(
  rpcUrl: string | undefined,
  account: { wallets: Array<{ address: `0x${string}` }> },
): Promise<Array<{ address: string; balanceEth: string; funded: boolean }>> {
  // Reading balances needs an endpoint, not wallets. Requiring PRIVATE_KEYS
  // here would break the whole point of generated accounts: a deployment that
  // only ever mints for signed-up users has no operator keys to give.
  const config = loadHuntRuntime(process.env, false);
  const client = new RpcClient(rpcUrl ?? config.rpcUrls[0], { maxSockets: 8 });
  try {
    return await Promise.all(
      account.wallets.map(async ({ address }) => {
        try {
          const hex = await client.call<Hex>('eth_getBalance', [address, 'latest']);
          const wei = BigInt(hex);
          return { address, balanceEth: formatEther(wei), funded: wei > 0n };
        } catch {
          // One unreachable read must not blank the whole list.
          return { address, balanceEth: '—', funded: false };
        }
      }),
    );
  } finally {
    client.destroy();
  }
}

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
