import { formatEther } from 'viem';
import { describeCharges, loadBilling, saveBilling, SUBSCRIPTION_DAYS } from '../billing.js';
import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';

/**
 * GET   /api/billing — what is being charged, and which values came from where
 * PATCH /api/billing — change a price
 *
 * Operator only: this is the deployment's own pricing, not an account setting,
 * and the payout address on it is where every payment and every fee goes. Both
 * methods sit behind the API_TOKEN for that reason — `handleApi` requires it
 * unless a route opts out, and this one very deliberately does not.
 *
 * A change takes effect on the next request. There is no redeploy, no rebuild,
 * and no window where half the app is on the old price: every path that charges
 * anything reads this same resolver.
 *
 * PATCH takes only the fields being changed. `null` clears an override and
 * returns that field to whatever the environment says — which is a different
 * thing from setting it to zero, and worth keeping distinct when the field in
 * question is a price.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();

  await handleApi(req, res, { methods: ['GET', 'PATCH'], limit: 'account' }, async (body) => {
    const billing = method === 'PATCH' ? await saveBilling(body) : await loadBilling();

    return {
      billingEnabled: billing.enabled,
      payTo: billing.recipient,
      subscriptionEth: formatEther(billing.subscriptionWei),
      subscriptionNote: billing.subscriptionNote,
      days: SUBSCRIPTION_DAYS,
      feePct: billing.feePct,
      feeMaxEth: formatEther(billing.feeMaxWei),
      summary: describeCharges(billing),
      /** Which fields the operator has set, rather than the environment. */
      overridden: billing.overridden,
      defaults: billing.defaults,
      updatedAt: billing.updatedAt,
      saved: method === 'PATCH',
    };
  });
}
