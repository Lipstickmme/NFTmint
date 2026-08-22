import { formatEther, parseEther, type Address, type Hex } from 'viem';
import type { RpcClient } from './rpc.js';

/**
 * What the app charges for, and what it says about it.
 *
 * Two charges, both paid on-chain to one address:
 *
 *   A monthly subscription unlocks auto-mint. Scanning, the live board and the
 *   findings history stay free — the subscription buys the thing that costs
 *   the operator money to run, which is the bot watching and minting on your
 *   behalf around the clock.
 *
 *   A per-mint service fee on every mint the app makes, auto or manual, taken
 *   only when one actually lands. It is a percentage of what that mint cost in
 *   gas, so it scales with use rather than punishing a quiet week, and it is
 *   capped so a congested block cannot turn a fee into a surprise.
 *
 * Every function here that produces a number also produces the sentence that
 * describes it. That is deliberate. A fee the payer cannot see is not a fee,
 * it is a deduction, and this one is charged to people whose wallets the app
 * generated and holds the keys to. So the fee appears in the mint result, in
 * the report, and on the screen where auto-mint is switched on — as a service
 * fee, under its own name, never folded into the gas line where it would read
 * as a cost of the network rather than a charge by this app.
 */

/** Where both charges are paid. */
export const FEE_RECIPIENT = '0x643548aB552dfD4E3B402d03c5723a12FcEFa446' as Address;

/** Monthly subscription, in ETH. Roughly $5 at 0.0015 ETH; see below. */
const DEFAULT_SUBSCRIPTION_ETH = '0.0015';

/** Service fee as a percentage of the mint's network cost. */
const DEFAULT_FEE_PCT = 10;

/** Ceiling on one service fee, whatever gas did. */
const DEFAULT_FEE_MAX_ETH = '0.0002';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SUBSCRIPTION_DAYS = 30;

export interface BillingConfig {
  recipient: Address;
  /** Price of one subscription period, in wei. */
  subscriptionWei: bigint;
  /** Human note about what that is worth, since nothing here reads a price feed. */
  subscriptionNote: string;
  feePct: number;
  feeMaxWei: bigint;
  /** Both charges off. For a self-hosted deployment that bills nobody. */
  enabled: boolean;
}

function ethEnv(value: string | undefined, fallback: string): bigint {
  const raw = value?.trim();
  if (!raw) return parseEther(fallback);
  try {
    return parseEther(raw);
  } catch {
    return parseEther(fallback);
  }
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const pct = Number(env.MINT_FEE_PCT ?? DEFAULT_FEE_PCT);
  return {
    recipient: (env.FEE_RECIPIENT?.trim() as Address) || FEE_RECIPIENT,
    subscriptionWei: ethEnv(env.SUBSCRIPTION_PRICE_ETH, DEFAULT_SUBSCRIPTION_ETH),
    subscriptionNote:
      env.SUBSCRIPTION_PRICE_NOTE?.trim() ||
      'about $5 a month — priced in ETH, so the dollar figure moves with the market',
    // Clamped rather than trusted: a typo in an environment variable should not
    // be able to charge someone 400% of their gas.
    feePct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 25) : DEFAULT_FEE_PCT,
    feeMaxWei: ethEnv(env.MINT_FEE_MAX_ETH, DEFAULT_FEE_MAX_ETH),
    // Billing is on by default for a hosted deployment and can be turned off
    // wholesale, because someone running this for themselves should not be
    // paying a fee to somebody else's address.
    enabled: env.BILLING_ENABLED?.trim().toLowerCase() !== 'false',
  };
}

// ── The subscription ─────────────────────────────────────────────────────────

/** What is stored on an account once it has paid. */
export interface Subscription {
  /** ISO timestamp. Auto-mint is allowed until this moment. */
  until: string;
  /** The payment that bought the current period. */
  txHash: Hex;
  paidWei: string;
  paidAt: string;
}

export interface SubscriptionStatus {
  active: boolean;
  until?: string;
  daysLeft?: number;
  /** Plain sentence for the UI. Never a number on its own. */
  message: string;
}

export function subscriptionStatus(
  subscription: Subscription | undefined,
  billing: BillingConfig,
  now = Date.now(),
): SubscriptionStatus {
  if (!billing.enabled) {
    return { active: true, message: 'Billing is off on this deployment. Auto-mint is free here.' };
  }
  if (!subscription) {
    return {
      active: false,
      message: `Auto-mint needs a subscription: ${formatEther(billing.subscriptionWei)} ETH for ${SUBSCRIPTION_DAYS} days (${billing.subscriptionNote}). Scanning and the live board are free.`,
    };
  }

  const until = Date.parse(subscription.until);
  if (!Number.isFinite(until) || until <= now) {
    return {
      active: false,
      until: subscription.until,
      daysLeft: 0,
      message: `Subscription ended ${subscription.until.slice(0, 10)}. Renew to start auto-mint again — scanning stays free either way.`,
    };
  }

  const daysLeft = Math.ceil((until - now) / DAY_MS);
  return {
    active: true,
    until: subscription.until,
    daysLeft,
    message: `Auto-mint is on. ${daysLeft} day${daysLeft === 1 ? '' : 's'} left, until ${subscription.until.slice(0, 10)}.`,
  };
}

/**
 * Extend a subscription by one period.
 *
 * Extends from whichever is later, now or the current expiry, so paying early
 * adds time instead of throwing away what is left.
 */
export function extendSubscription(
  current: Subscription | undefined,
  payment: { txHash: Hex; paidWei: bigint },
  now = Date.now(),
): Subscription {
  const currentUntil = current ? Date.parse(current.until) : Number.NaN;
  const base = Number.isFinite(currentUntil) && currentUntil > now ? currentUntil : now;
  return {
    until: new Date(base + SUBSCRIPTION_DAYS * DAY_MS).toISOString(),
    txHash: payment.txHash,
    paidWei: payment.paidWei.toString(),
    paidAt: new Date(now).toISOString(),
  };
}

// ── Verifying a payment ──────────────────────────────────────────────────────

interface ChainTx {
  from?: Address;
  to?: Address | null;
  value?: Hex;
  blockNumber?: Hex | null;
}

interface ChainReceipt {
  status?: Hex;
  from?: Address;
  to?: Address | null;
}

export class PaymentError extends Error {}

export interface VerifiedPayment {
  txHash: Hex;
  paidWei: bigint;
  from: Address;
}

/**
 * Confirm that a transaction really paid for a subscription.
 *
 * Checked against the chain rather than trusted from the client, and checked in
 * the order that gives the most useful error: does it exist, did it succeed,
 * did it go to the right address, was it enough, and was it sent from a wallet
 * this account controls. That last check is what stops one person's payment
 * from being replayed by everyone who can read the block explorer.
 */
export async function verifyPayment(
  client: RpcClient,
  txHash: string,
  ownedAddresses: readonly Address[],
  billing: BillingConfig,
): Promise<VerifiedPayment> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new PaymentError('That does not look like a transaction hash.');
  }
  const hash = txHash.toLowerCase() as Hex;

  const tx = await client.call<ChainTx | null>('eth_getTransactionByHash', [hash]);
  if (!tx) {
    throw new PaymentError(
      'No transaction with that hash on this network yet. If you just sent it, wait a few seconds and try again.',
    );
  }
  if (!tx.blockNumber) {
    throw new PaymentError('That transaction has not been included in a block yet. Try again shortly.');
  }

  const receipt = await client.call<ChainReceipt | null>('eth_getTransactionReceipt', [hash]);
  if (!receipt || BigInt(receipt.status ?? '0x0') !== 1n) {
    throw new PaymentError('That transaction failed on-chain, so nothing was paid.');
  }

  const to = (tx.to ?? '').toString().toLowerCase();
  if (to !== billing.recipient.toLowerCase()) {
    throw new PaymentError(`That payment went to ${tx.to ?? 'a contract'}, not to ${billing.recipient}.`);
  }

  const paidWei = BigInt(tx.value ?? '0x0');
  if (paidWei < billing.subscriptionWei) {
    throw new PaymentError(
      `That paid ${formatEther(paidWei)} ETH; a subscription is ${formatEther(billing.subscriptionWei)} ETH.`,
    );
  }

  const from = (tx.from ?? '').toString().toLowerCase();
  const owned = ownedAddresses.some((a) => a.toLowerCase() === from);
  if (!owned) {
    throw new PaymentError(
      'That payment was sent from a wallet this account does not hold. Pay from one of your own wallets so the payment can be tied to your account.',
    );
  }

  return { txHash: hash, paidWei, from: tx.from as Address };
}

// ── The per-mint service fee ─────────────────────────────────────────────────

export interface ServiceFee {
  wei: bigint;
  eth: string;
  recipient: Address;
  pct: number;
  /** What the mint cost in gas, which the fee is a percentage of. */
  networkCostWei: bigint;
  capped: boolean;
  /** The sentence shown to whoever paid it. */
  description: string;
}

/**
 * The fee for one minted collection.
 *
 * Zero is a real answer: a mint whose network cost could not be measured is not
 * charged, because a fee nobody can check against a number is exactly the kind
 * of charge this app should not be making.
 */
export function serviceFee(networkCostWei: bigint, billing: BillingConfig): ServiceFee {
  const uncapped = billing.enabled
    ? (networkCostWei * BigInt(Math.round(billing.feePct * 100))) / 10_000n
    : 0n;
  const capped = uncapped > billing.feeMaxWei;
  const wei = capped ? billing.feeMaxWei : uncapped;

  return {
    wei,
    eth: formatEther(wei),
    recipient: billing.recipient,
    pct: billing.feePct,
    networkCostWei,
    capped,
    description:
      wei === 0n
        ? 'No service fee on this mint.'
        : `Service fee: ${formatEther(wei)} ETH — ${billing.feePct}% of the ${formatEther(networkCostWei)} ETH this mint cost in gas${capped ? ', capped' : ''}. Paid to ${billing.recipient}. This is a charge by this app, not a network cost.`,
  };
}

/** Gas actually spent, from receipts. Used as the base for the fee. */
export function networkCostOf(
  receipts: Array<{ gasUsed?: Hex; effectiveGasPrice?: Hex } | undefined>,
  fallbackGasPrice: bigint,
): bigint {
  let total = 0n;
  for (const receipt of receipts) {
    if (!receipt?.gasUsed) continue;
    const price = receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : fallbackGasPrice;
    total += BigInt(receipt.gasUsed) * price;
  }
  return total;
}

/** One line for the UI, before anything is spent. */
export function describeCharges(billing: BillingConfig): string {
  if (!billing.enabled) return 'This deployment charges nothing.';
  return (
    `Scanning and the live board are free. Auto-mint is ` +
    `${formatEther(billing.subscriptionWei)} ETH per ${SUBSCRIPTION_DAYS} days ` +
    `(${billing.subscriptionNote}). Every mint the app makes for you — auto or ` +
    `manual — carries a ${billing.feePct}% service fee on that mint's own gas, ` +
    `capped at ${formatEther(billing.feeMaxWei)} ETH, and only when the mint lands. ` +
    `Both charges are paid to ${billing.recipient}.`
  );
}

// ── Collecting the service fee ───────────────────────────────────────────────

/** Just enough of a wallet to sign one transfer. */
export interface FeePayer {
  address: Address;
  account: { signTransaction: (tx: Record<string, unknown>) => Promise<Hex> };
}

export interface FeePayment {
  fee: ServiceFee;
  txHash?: Hex;
  /** Why the fee was not taken. Never a reason to fail the mint. */
  error?: string;
}

export interface PayFeeParams {
  wallet: FeePayer;
  client: RpcClient;
  chainId: number;
  networkCostWei: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  billing: BillingConfig;
  /** Work out the fee and describe it, but send nothing. */
  dryRun?: boolean;
}

/** Gas for a plain ETH transfer. */
const TRANSFER_GAS = 21_000n;

/**
 * Take the service fee for one minted collection.
 *
 * A separate transfer rather than something folded into the mint, for two
 * reasons. The mint's value goes to the NFT contract, so there is nowhere to
 * hide a fee inside it even if that were the right thing to do. And a separate
 * transaction is a separate line on a block explorer, under this app's own
 * address, which is what makes the charge checkable by the person paying it.
 *
 * Never throws. A fee that cannot be collected is the operator's problem; the
 * user already has their NFT, and failing their mint over a rounding error in
 * someone else's revenue would be indefensible.
 */
export async function payServiceFee(params: PayFeeParams): Promise<FeePayment | undefined> {
  const fee = serviceFee(params.networkCostWei, params.billing);
  if (fee.wei === 0n) return undefined;
  if (params.dryRun) return { fee };

  try {
    const [nonceHex, balanceHex] = await Promise.all([
      params.client.call<Hex>('eth_getTransactionCount', [params.wallet.address, 'pending']),
      params.client.call<Hex>('eth_getBalance', [params.wallet.address, 'latest']),
    ]);

    const gasCost = TRANSFER_GAS * params.maxFeePerGas;
    if (BigInt(balanceHex) < fee.wei + gasCost) {
      return {
        fee,
        error:
          'Not enough left in that wallet to cover the service fee after the mint. ' +
          'It has not been charged.',
      };
    }

    const serialized = await params.wallet.account.signTransaction({
      to: fee.recipient,
      value: fee.wei,
      data: '0x',
      nonce: Number(BigInt(nonceHex)),
      gas: TRANSFER_GAS,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      chainId: params.chainId,
      type: 'eip1559',
    });

    const txHash = await params.client.call<Hex>('eth_sendRawTransaction', [serialized]);
    return { fee, txHash };
  } catch (err) {
    return { fee, error: err instanceof Error ? err.message : String(err) };
  }
}
