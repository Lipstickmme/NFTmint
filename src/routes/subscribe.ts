import { formatEther } from 'viem';
import { privateKeysOf } from '../accounts.js';
import { authenticateAccount, saveAccount } from '../accountstore.js';
import {
  describeCharges,
  extendSubscription,
  loadBillingConfig,
  PaymentError,
  SUBSCRIPTION_DAYS,
  subscriptionStatus,
  verifyPayment,
} from '../billing.js';
import { loadHuntRuntime } from '../config.js';
import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';
import { RpcClient } from '../rpc.js';

/**
 * GET  /api/subscribe  — what auto-mint costs, and whether this account has it
 * POST /api/subscribe  — claim a payment: { txHash }
 *
 * Payment is a plain ETH transfer on the same chain the bot mints on, which
 * keeps the whole thing inside what the app already does: no card details, no
 * third-party processor holding anyone's money, and a receipt the payer can
 * check on a block explorer without asking anybody.
 *
 * The flow is: the UI shows the address and the amount, the user sends from one
 * of their own wallets, then posts the transaction hash here. This route reads
 * that transaction off the chain and decides. Nothing about the amount or the
 * recipient is taken from the request — only the hash is, and everything else
 * is looked up.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  await handleApi(
    req,
    res,
    { methods: ['GET', 'POST'], publicRoute: true, limit: 'account' },
    async (body) => {
      const billing = loadBillingConfig();
      const account = await authenticateAccount(
        header(req, 'x-account-id'),
        header(req, 'x-account-token'),
      );

      if (method === 'GET') {
        return {
          ...priceSheet(billing),
          status: subscriptionStatus(account.subscription, billing),
        };
      }

      const txHash = String(body.txHash ?? '').trim();
      if (!txHash) {
        throw new PaymentError(
          'Send the payment first, then paste its transaction hash here so it can be checked on-chain.',
        );
      }

      // Read-only: no keys are needed to look a transaction up, so this works
      // for an account that has not funded anything yet.
      const config = loadHuntRuntime(process.env, false);
      const rpcUrls = account.rpcUrl ? [account.rpcUrl, ...config.rpcUrls] : config.rpcUrls;
      const client = new RpcClient(rpcUrls[0]);

      try {
        // Every wallet, not just the first: people pay from whichever one has
        // gas in it, and refusing the other nine would be a strange rule.
        const owned = privateKeysOf(account).map((w) => w.address);
        const paid = await verifyPayment(client, txHash, owned, billing);

        // Replay is checked against this account's own history rather than a
        // shared ledger: the payment is already tied to a wallet only this
        // account holds, so the remaining risk is someone re-submitting their
        // own transaction to get a second month out of one payment.
        if (account.subscription?.txHash === paid.txHash) {
          return {
            ...priceSheet(billing),
            status: subscriptionStatus(account.subscription, billing),
            note: 'That payment is already applied to this account.',
          };
        }

        account.subscription = extendSubscription(account.subscription, paid);
        await saveAccount(account);

        return {
          ...priceSheet(billing),
          status: subscriptionStatus(account.subscription, billing),
          note: `Thanks — ${formatEther(paid.paidWei)} ETH received. Auto-mint is on for ${SUBSCRIPTION_DAYS} days.`,
        };
      } finally {
        client.destroy();
      }
    },
  );
}

/** What it costs, in the shape the UI renders. */
function priceSheet(billing: ReturnType<typeof loadBillingConfig>) {
  return {
    billingEnabled: billing.enabled,
    payTo: billing.recipient,
    priceEth: formatEther(billing.subscriptionWei),
    priceNote: billing.subscriptionNote,
    days: SUBSCRIPTION_DAYS,
    feePct: billing.feePct,
    feeMaxEth: formatEther(billing.feeMaxWei),
    // One sentence covering both charges, so no screen has to assemble it.
    summary: describeCharges(billing),
  };
}

function header(req: ApiRequest, name: string): string {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}
