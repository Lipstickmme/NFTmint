import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseEther, formatEther, type Address, type Hex } from 'viem';
import {
  describeCharges,
  extendSubscription,
  FEE_RECIPIENT,
  loadBillingConfig,
  networkCostOf,
  PaymentError,
  serviceFee,
  subscriptionStatus,
  SUBSCRIPTION_DAYS,
  verifyPayment,
  type Subscription,
} from '../src/billing.js';
import type { RpcClient } from '../src/rpc.js';

/**
 * What the app charges, and whether it says so.
 *
 * Two halves. The arithmetic half is ordinary: a percentage, a cap, a date
 * thirty days out. The half worth testing hard is the honesty — this fee is
 * taken from wallets the app generated and holds the keys to, so the person
 * paying it can only know about it if the code tells them. Several tests here
 * assert on wording rather than numbers, deliberately: a fee described as a
 * network cost would be a different product from a fee described as a fee.
 *
 * The other half worth testing hard is the replay: payments are public, so a
 * subscription that accepted any transaction to the right address would let one
 * person's payment unlock every account that could read a block explorer.
 */

const OWNED = '0x1111111111111111111111111111111111111111' as Address;
const STRANGER = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

const billing = loadBillingConfig({});

interface FakeTx {
  from?: Address;
  to?: Address | null;
  value?: Hex;
  blockNumber?: Hex | null;
}

/** A node that knows about exactly one transaction. */
function nodeWith(tx: FakeTx | null, status: Hex = '0x1'): RpcClient {
  return {
    call: async <T>(method: string): Promise<T> => {
      if (method === 'eth_getTransactionByHash') return tx as T;
      if (method === 'eth_getTransactionReceipt') {
        return (tx ? { status, from: tx.from, to: tx.to } : null) as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as RpcClient;
}

function payment(over: Partial<FakeTx> = {}): FakeTx {
  return {
    from: OWNED,
    to: FEE_RECIPIENT,
    value: `0x${billing.subscriptionWei.toString(16)}` as Hex,
    blockNumber: '0x64',
    ...over,
  };
}

describe('what the subscription costs, and what it says', () => {
  it('tells someone with no subscription what auto-mint needs, and what stays free', () => {
    const status = subscriptionStatus(undefined, billing);

    expect(status.active).toBe(false);
    expect(status.message).toContain('ETH');
    expect(status.message).toMatch(/Scanning and the live board are free/);
  });

  it('counts the days left rather than printing a timestamp', () => {
    const until = new Date(Date.now() + 3.2 * 24 * 60 * 60 * 1000).toISOString();
    const status = subscriptionStatus({ until } as Subscription, billing);

    expect(status.active).toBe(true);
    expect(status.daysLeft).toBe(4);
    expect(status.message).toContain('4 days left');
  });

  it('says "1 day", not "1 days"', () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    expect(subscriptionStatus({ until } as Subscription, billing).message).toContain('1 day left');
  });

  it('treats an expired subscription as off, and says renewing is optional', () => {
    const until = new Date(Date.now() - 60_000).toISOString();
    const status = subscriptionStatus({ until } as Subscription, billing);

    expect(status.active).toBe(false);
    expect(status.daysLeft).toBe(0);
    expect(status.message).toMatch(/scanning stays free/i);
  });

  it('charges nobody when the deployment has billing off', () => {
    const off = loadBillingConfig({ BILLING_ENABLED: 'false' });
    const status = subscriptionStatus(undefined, off);

    expect(status.active).toBe(true);
    expect(status.message).toMatch(/free here/);
    expect(describeCharges(off)).toBe('This deployment charges nothing.');
  });
});

describe('renewing', () => {
  it('adds to what is left instead of throwing it away', () => {
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    const current: Subscription = {
      until: '2026-08-21T00:00:00.000Z',
      txHash: HASH,
      paidWei: '1',
      paidAt: '2026-07-22T00:00:00.000Z',
    };

    const next = extendSubscription(current, { txHash: HASH, paidWei: 1n }, now);

    // 20 days left plus 30 bought, not 30 from today.
    expect(next.until).toBe('2026-09-20T00:00:00.000Z');
  });

  it('starts from today when the old period has already run out', () => {
    const now = Date.parse('2026-08-01T00:00:00.000Z');
    const expired: Subscription = {
      until: '2026-07-01T00:00:00.000Z',
      txHash: HASH,
      paidWei: '1',
      paidAt: '2026-06-01T00:00:00.000Z',
    };

    const next = extendSubscription(expired, { txHash: HASH, paidWei: 1n }, now);

    expect(next.until).toBe('2026-08-31T00:00:00.000Z');
    expect(SUBSCRIPTION_DAYS).toBe(30);
  });
});

describe('verifying a payment against the chain', () => {
  it('accepts a real payment from one of the account\'s own wallets', async () => {
    const verified = await verifyPayment(nodeWith(payment()), HASH, [OWNED], billing);

    expect(verified.paidWei).toBe(billing.subscriptionWei);
    expect(verified.from).toBe(OWNED);
  });

  it('refuses a payment sent from someone else\'s wallet', async () => {
    // Payments are public. Without this, one person's transaction hash would
    // unlock auto-mint for everybody who could read a block explorer.
    await expect(
      verifyPayment(nodeWith(payment({ from: STRANGER })), HASH, [OWNED], billing),
    ).rejects.toThrow(/does not hold/);
  });

  it('refuses a payment to the wrong address', async () => {
    await expect(
      verifyPayment(nodeWith(payment({ to: STRANGER })), HASH, [OWNED], billing),
    ).rejects.toThrow(/not to 0x643548/i);
  });

  it('says how much short an underpayment was', async () => {
    const short = billing.subscriptionWei / 2n;
    await expect(
      verifyPayment(
        nodeWith(payment({ value: `0x${short.toString(16)}` as Hex })),
        HASH,
        [OWNED],
        billing,
      ),
    ).rejects.toThrow(new RegExp(`${formatEther(short)} ETH`));
  });

  it('does not credit a transaction that failed on-chain', async () => {
    await expect(
      verifyPayment(nodeWith(payment(), '0x0'), HASH, [OWNED], billing),
    ).rejects.toThrow(/failed on-chain/);
  });

  it('asks the user to wait rather than failing them for being early', async () => {
    await expect(
      verifyPayment(nodeWith(payment({ blockNumber: null })), HASH, [OWNED], billing),
    ).rejects.toThrow(/not been included in a block yet/);

    await expect(verifyPayment(nodeWith(null), HASH, [OWNED], billing)).rejects.toThrow(
      /wait a few seconds/,
    );
  });

  it('rejects something that is not a hash before asking the chain', async () => {
    const exploding = { call: async () => { throw new Error('should not be called'); } };
    await expect(
      verifyPayment(exploding as unknown as RpcClient, 'not-a-hash', [OWNED], billing),
    ).rejects.toBeInstanceOf(PaymentError);
  });
});

describe('the per-mint service fee', () => {
  const cost = parseEther('0.0001');

  it('is a percentage of what the mint cost in gas', () => {
    const fee = serviceFee(cost, billing);

    expect(fee.pct).toBe(10);
    expect(fee.wei).toBe(cost / 10n);
    expect(fee.capped).toBe(false);
  });

  it('never exceeds its cap, however bad the gas was', () => {
    const fee = serviceFee(parseEther('10'), billing);

    expect(fee.wei).toBe(billing.feeMaxWei);
    expect(fee.capped).toBe(true);
    expect(fee.description).toContain('capped');
  });

  it('charges nothing when the mint cost could not be measured', () => {
    // A fee with no number behind it is a number nobody can check.
    expect(serviceFee(0n, billing).wei).toBe(0n);
    expect(serviceFee(0n, billing).description).toBe('No service fee on this mint.');
  });

  it('charges nothing when billing is off', () => {
    expect(serviceFee(cost, loadBillingConfig({ BILLING_ENABLED: 'false' })).wei).toBe(0n);
  });

  it('calls itself a fee, and says it is not a network cost', () => {
    // The whole point. Presented as part of gas, this would read as something
    // the chain charged rather than something this app did.
    const fee = serviceFee(cost, billing);

    expect(fee.description).toContain('Service fee');
    expect(fee.description).toContain(FEE_RECIPIENT);
    expect(fee.description).toMatch(/not a network cost/);
  });

  it('will not let a mistyped percentage run away', () => {
    expect(loadBillingConfig({ MINT_FEE_PCT: '400' }).feePct).toBe(25);
    expect(loadBillingConfig({ MINT_FEE_PCT: '-5' }).feePct).toBe(0);
    expect(loadBillingConfig({ MINT_FEE_PCT: 'nonsense' }).feePct).toBe(10);
  });

  it('falls back to a mistyped price rather than charging a random one', () => {
    expect(loadBillingConfig({ SUBSCRIPTION_PRICE_ETH: 'five dollars' }).subscriptionWei).toBe(
      parseEther('0.0015'),
    );
  });
});

describe('measuring what a mint cost', () => {
  it('uses the price the chain actually charged when it reports one', () => {
    const cost = networkCostOf(
      [{ gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00' }],
      parseEther('1'),
    );

    expect(cost).toBe(21_000n * 1_000_000_000n);
  });

  it('falls back to the fee that was authorised when it does not', () => {
    expect(networkCostOf([{ gasUsed: '0x5208' }], 1_000_000_000n)).toBe(21_000n * 1_000_000_000n);
  });

  it('ignores transactions with no receipt rather than guessing at them', () => {
    expect(networkCostOf([undefined, { gasUsed: '0x5208' }], 1n)).toBe(21_000n);
  });
});

describe('what a new user is told before anything is spent', () => {
  it('names both charges, what they cost, and where they go', () => {
    const text = describeCharges(billing);

    expect(text).toMatch(/free/);
    expect(text).toContain('service fee');
    expect(text).toContain(FEE_RECIPIENT);
    expect(text).toContain(`${SUBSCRIPTION_DAYS} days`);
  });
});

describe('prices the operator can change', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = (await import('node:path')).default;
    const { resetKv } = await import('../src/kv.js');
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-billing-'));
    env = { DATA_DIR: dir };
    resetKv();
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    const { resetKv } = await import('../src/kv.js');
    resetKv();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts from what the environment says, with nothing overridden', async () => {
    const { loadBilling } = await import('../src/billing.js');

    const resolved = await loadBilling({ ...env, MINT_FEE_PCT: '7' });

    expect(resolved.feePct).toBe(7);
    expect(resolved.overridden).toEqual([]);
    expect(resolved.defaults.feePct).toBe(7);
  });

  it('takes a new price and keeps it', async () => {
    const { saveBilling, loadBilling } = await import('../src/billing.js');
    const { resetKv } = await import('../src/kv.js');

    await saveBilling({ subscriptionEth: '0.004', feePct: 3 }, env);
    resetKv();
    const resolved = await loadBilling(env);

    expect(resolved.subscriptionWei).toBe(parseEther('0.004'));
    expect(resolved.feePct).toBe(3);
    expect(resolved.overridden).toEqual(expect.arrayContaining(['subscriptionEth', 'feePct']));
    // The environment's own value is still reported, so the screen can offer
    // a way back to it.
    expect(resolved.defaults.subscriptionEth).toBe('0.0015');
  });

  it('changes one field without disturbing the others', async () => {
    const { saveBilling, loadBilling } = await import('../src/billing.js');

    await saveBilling({ feePct: 12 }, env);
    await saveBilling({ subscriptionEth: '0.01' }, env);

    const resolved = await loadBilling(env);
    expect(resolved.feePct).toBe(12);
    expect(resolved.subscriptionWei).toBe(parseEther('0.01'));
  });

  it('clears an override back to the environment, which is not the same as zero', async () => {
    const { saveBilling, loadBilling } = await import('../src/billing.js');

    await saveBilling({ feePct: 0 }, env);
    expect((await loadBilling(env)).feePct).toBe(0);

    await saveBilling({ feePct: null }, env);
    const resolved = await loadBilling(env);

    expect(resolved.feePct).toBe(10);
    expect(resolved.overridden).not.toContain('feePct');
  });

  it('turns billing off and on again', async () => {
    const { saveBilling, loadBilling, subscriptionStatus } = await import('../src/billing.js');

    await saveBilling({ enabled: false }, env);
    const off = await loadBilling(env);

    expect(off.enabled).toBe(false);
    expect(subscriptionStatus(undefined, off).active).toBe(true);

    await saveBilling({ enabled: true }, env);
    expect((await loadBilling(env)).enabled).toBe(true);
  });

  it('moves the payout address only when it is a real address', async () => {
    const { saveBilling, loadBilling } = await import('../src/billing.js');
    const next = '0x1111111111111111111111111111111111111111';

    await saveBilling({ recipient: next }, env);
    expect((await loadBilling(env)).recipient).toBe(next);

    // Every payment and every fee goes here; a typo is unrecoverable, so a
    // half-typed address must not be storable.
    await expect(saveBilling({ recipient: '0x1234' }, env)).rejects.toThrow(/42-character/);
    expect((await loadBilling(env)).recipient).toBe(next);
  });

  it('refuses a fee percentage outside the range, and says why', async () => {
    const { saveBilling } = await import('../src/billing.js');

    await expect(saveBilling({ feePct: 60 }, env)).rejects.toThrow(/between 0 and 25/);
    await expect(saveBilling({ feePct: -1 }, env)).rejects.toThrow(/between 0 and 25/);
    await expect(saveBilling({ feePct: 'lots' }, env)).rejects.toThrow(/must be a number/);
  });

  it('refuses an amount that is not an amount', async () => {
    const { saveBilling } = await import('../src/billing.js');

    await expect(saveBilling({ subscriptionEth: 'five' }, env)).rejects.toThrow(/amount in ETH/);
    await expect(saveBilling({ feeMaxEth: '' }, env)).rejects.toThrow(/cannot be empty/);
  });

  it('re-clamps a stored row that was edited by hand', async () => {
    // The form enforces 0-25. Someone with access to the store is not going to
    // be stopped by a form, so the ceiling is applied on read as well.
    const { loadBilling } = await import('../src/billing.js');
    const { openHash, resetKv } = await import('../src/kv.js');
    await openHash('settings', env, 0).set('billing', JSON.stringify({ feePct: 400 }));
    resetKv();

    expect((await loadBilling(env)).feePct).toBe(25);
  });

  it('refuses to save where the change would not survive a restart', async () => {
    const { saveBilling } = await import('../src/billing.js');
    const { resetKv } = await import('../src/kv.js');
    resetKv();

    // No DATA_DIR and no KV: the store is memory, so a price set here would
    // silently revert and start charging the old amount again.
    await expect(saveBilling({ feePct: 5 }, {})).rejects.toThrow(/no durable storage/);
  });

  it('falls back to the environment when the settings row is unreadable', async () => {
    const { loadBilling } = await import('../src/billing.js');
    const { openHash, resetKv } = await import('../src/kv.js');
    await openHash('settings', env, 0).set('billing', 'not json');
    resetKv();

    const resolved = await loadBilling(env);

    expect(resolved.feePct).toBe(10);
    expect(resolved.overridden).toEqual([]);
  });
});
