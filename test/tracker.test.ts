import { describe, it, expect, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { MintTracker, type HotCollection } from '../src/tracker.js';
import { classifyMint, parseExtraSelectors, MINT_SELECTORS } from '../src/mintdetect.js';
import { selectorOf } from '../src/calldata.js';
import type { FeedTx } from '../src/feed.js';

const CONTRACT_A = '0x00000000000000000000000000000000000000aa' as Address;
const CONTRACT_B = '0x00000000000000000000000000000000000000bb' as Address;

const MINT_SEL = selectorOf('mint(uint256)');
const TRANSFER_SEL = selectorOf('transfer(address,uint256)');

function tx(overrides: Partial<FeedTx> = {}): FeedTx {
  return {
    hash: '0xhash' as Hex,
    to: CONTRACT_A,
    selector: MINT_SEL,
    value: 0n,
    data: `${MINT_SEL}${'01'.padStart(64, '0')}` as Hex,
    raw: '0x02f8' as Hex,
    ...overrides,
  };
}

describe('classifyMint', () => {
  it('recognizes a known mint selector', () => {
    const result = classifyMint({ to: CONTRACT_A, selector: MINT_SEL, value: 0n, data: '0x' });
    expect(result.isMint).toBe(true);
    expect(result.isFree).toBe(true);
    expect(result.signature).toBe('mint(uint256)');
  });

  it('marks a mint carrying ETH as not free', () => {
    const result = classifyMint({
      to: CONTRACT_A,
      selector: MINT_SEL,
      value: 10n ** 16n,
      data: '0x',
    });
    expect(result.isMint).toBe(true);
    expect(result.isFree).toBe(false);
  });

  it('ignores non-mint calls', () => {
    expect(
      classifyMint({ to: CONTRACT_A, selector: TRANSFER_SEL, value: 0n, data: '0x' }).isMint,
    ).toBe(false);
  });

  it('ignores contract creation and bare transfers', () => {
    expect(classifyMint({ to: undefined, selector: MINT_SEL, value: 0n, data: '0x' }).isMint).toBe(
      false,
    );
    expect(classifyMint({ to: CONTRACT_A, selector: undefined, value: 1n, data: '0x' }).isMint).toBe(
      false,
    );
  });

  it('honours extra selectors registered by the operator', () => {
    const custom = '0xdeadbeef' as Hex;
    expect(classifyMint({ to: CONTRACT_A, selector: custom, value: 0n, data: '0x' }).isMint).toBe(
      false,
    );
    expect(
      classifyMint(
        { to: CONTRACT_A, selector: custom, value: 0n, data: '0x' },
        new Set([custom]),
      ).isMint,
    ).toBe(true);
  });

  it('covers the common mint entrypoints', () => {
    expect(MINT_SELECTORS.has(selectorOf('mint(uint256)'))).toBe(true);
    expect(MINT_SELECTORS.has(selectorOf('publicMint(uint256)'))).toBe(true);
    expect(MINT_SELECTORS.has(selectorOf('whitelistMint(uint256,bytes32[])'))).toBe(true);
  });
});

describe('parseExtraSelectors', () => {
  it('accepts raw selectors and signatures alike', () => {
    const set = parseExtraSelectors('0xdeadbeef,customMint(uint256)');
    expect(set.has('0xdeadbeef')).toBe(true);
    expect(set.has(selectorOf('customMint(uint256)'))).toBe(true);
  });

  it('returns empty for undefined', () => {
    expect(parseExtraSelectors(undefined).size).toBe(0);
  });

  it('rejects garbage rather than silently ignoring it', () => {
    expect(() => parseExtraSelectors('nonsense')).toThrow(/neither a 4-byte selector/);
  });
});

describe('MintTracker velocity', () => {
  it('counts mint attempts per contract', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 1000 });
    for (let i = 0; i < 5; i++) tracker.ingest(tx());
    tracker.ingest(tx({ to: CONTRACT_B }));

    expect(tracker.get(CONTRACT_A)?.attempts).toBe(5);
    expect(tracker.get(CONTRACT_B)?.attempts).toBe(1);
    expect(tracker.totalMints).toBe(6);
  });

  it('ignores non-mint traffic but still counts it as seen', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false });
    tracker.ingest(tx({ selector: TRANSFER_SEL }));
    expect(tracker.totalSeen).toBe(1);
    expect(tracker.totalMints).toBe(0);
    expect(tracker.size()).toBe(0);
  });

  it('separates free from paid attempts', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 1000 });
    tracker.ingest(tx({ value: 0n }));
    tracker.ingest(tx({ value: 0n }));
    tracker.ingest(tx({ value: 10n ** 16n }));

    const stats = tracker.get(CONTRACT_A)!;
    expect(stats.freeAttempts).toBe(2);
    expect(stats.paidAttempts).toBe(1);
    expect(stats.totalValueWei).toBe(10n ** 16n);
  });

  it('fires "hot" once the window threshold is crossed', () => {
    const tracker = new MintTracker({
      velocityWindowSec: 10,
      minAttempts: 5,
      minUniqueMinters: 0,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    const t0 = Date.now();
    for (let i = 0; i < 4; i++) tracker.ingest(tx(), -1, t0 + i * 100);
    expect(hot).not.toHaveBeenCalled();

    tracker.ingest(tx(), -1, t0 + 400);
    expect(hot).toHaveBeenCalledTimes(1);

    const payload = hot.mock.calls[0][0] as HotCollection;
    expect(payload.contract).toBe(CONTRACT_A);
    expect(payload.attemptsInWindow).toBe(5);
    expect(payload.isFree).toBe(true);
  });

  it('fires only once per contract', () => {
    const tracker = new MintTracker({
      minAttempts: 2,
      minUniqueMinters: 0,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    for (let i = 0; i < 20; i++) tracker.ingest(tx());
    expect(hot).toHaveBeenCalledTimes(1);
  });

  it('does not fire when mints are spread beyond the window', () => {
    const tracker = new MintTracker({
      velocityWindowSec: 5,
      minAttempts: 5,
      minUniqueMinters: 0,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    // One mint every 10s: real but slow demand, not a rush.
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) tracker.ingest(tx(), -1, t0 + i * 10_000);
    expect(hot).not.toHaveBeenCalled();
  });

  it('requires enough distinct minters to rule out a single spammer', () => {
    const tracker = new MintTracker({
      minAttempts: 3,
      minUniqueMinters: 5,
      trackUniqueMinters: false, // no recovery, so uniqueMinters stays 0
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    for (let i = 0; i < 50; i++) tracker.ingest(tx());
    // 50 attempts but no evidence of distinct minters — correctly withheld.
    expect(hot).not.toHaveBeenCalled();
  });

  it('respects freeOnly by not flagging paid collections', () => {
    const tracker = new MintTracker({
      minAttempts: 3,
      minUniqueMinters: 0,
      freeOnly: true,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    for (let i = 0; i < 10; i++) tracker.ingest(tx({ value: 10n ** 16n }));
    expect(hot).not.toHaveBeenCalled();
  });

  it('ignores collections older than the freshness limit', () => {
    const tracker = new MintTracker({
      minAttempts: 2,
      minUniqueMinters: 0,
      maxContractAgeSec: 60,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    const t0 = Date.now();
    tracker.ingest(tx(), -1, t0);
    // Same contract, two hours later — a long-running mint, not a fresh drop.
    tracker.ingest(tx(), -1, t0 + 7_200_000);
    tracker.ingest(tx(), -1, t0 + 7_200_001);
    expect(hot).not.toHaveBeenCalled();
  });

  it('captures sample calldata from a real minter', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 1000 });
    const data = `${MINT_SEL}${'03'.padStart(64, '0')}` as Hex;
    tracker.ingest(tx({ data }));

    expect(tracker.get(CONTRACT_A)?.sampleCalldata.get(MINT_SEL)).toBe(data);
  });

  it('reports observed value so the autopilot knows the price', () => {
    const tracker = new MintTracker({
      minAttempts: 2,
      minUniqueMinters: 0,
      freeOnly: false,
      trackUniqueMinters: false,
    });
    const hot = vi.fn();
    tracker.on('hot', hot);

    tracker.ingest(tx({ value: 100n }));
    tracker.ingest(tx({ value: 100n }));

    expect((hot.mock.calls[0][0] as HotCollection).observedValueWei).toBe(100n);
  });
});

describe('MintTracker snapshot', () => {
  it('ranks hottest first', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 10_000 });
    for (let i = 0; i < 3; i++) tracker.ingest(tx({ to: CONTRACT_A }));
    for (let i = 0; i < 9; i++) tracker.ingest(tx({ to: CONTRACT_B }));

    const rows = tracker.snapshot();
    expect(rows[0].contract).toBe(CONTRACT_B);
    expect(rows[0].attempts).toBe(9);
    expect(rows[1].contract).toBe(CONTRACT_A);
  });

  it('serializes cleanly, with no bigints to break JSON', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 10_000 });
    tracker.ingest(tx({ value: 10n ** 18n }));

    const rows = tracker.snapshot();
    expect(() => JSON.stringify(rows)).not.toThrow();
    expect(rows[0].totalValueWei).toBe('1000000000000000000');
  });

  it('honours the limit', () => {
    const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 10_000 });
    for (let i = 0; i < 20; i++) {
      const addr = `0x${i.toString(16).padStart(40, '0')}` as Address;
      tracker.ingest(tx({ to: addr }));
    }
    expect(tracker.snapshot(5)).toHaveLength(5);
  });
});

describe('MintTracker memory bounds', () => {
  it('evicts cold contracts once over capacity', () => {
    const tracker = new MintTracker({
      trackUniqueMinters: false,
      minAttempts: 10_000,
      maxContracts: 10,
      evictAfterSec: 1,
    });

    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      const addr = `0x${i.toString(16).padStart(40, '0')}` as Address;
      tracker.ingest(tx({ to: addr }), -1, t0 + i * 1000);
    }

    // Bounded rather than growing with every contract ever seen.
    expect(tracker.size()).toBeLessThanOrEqual(10);
  });
});
