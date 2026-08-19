import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { evaluate, projectSelloutSec, formatDuration, scoreOf, CLOSE_SCORE, DEFAULT_CRITERIA, type HuntCriteria } from '../src/criteria.js';
import { activityStatus, type TrackedCollection } from '../src/tracker.js';
import type { ContractInfo } from '../src/inspect.js';

const CONTRACT = '0x00000000000000000000000000000000000000aa' as Address;

/** A collection that passes every feed-derived check. */
function hot(overrides: Partial<TrackedCollection> = {}): TrackedCollection {
  return {
    contract: CONTRACT,
    firstSeenAt: Date.now() - 60_000,
    lastSeenAt: Date.now(),
    ageSec: 60,
    lastSeenSecAgo: 2,
    status: 'live',
    attempts: 200,
    freeAttempts: 200,
    paidAttempts: 0,
    uniqueMinters: 50,
    attemptsInWindow: 60,
    attemptsPerMinute: 200,
    totalValueWei: '0',
    observedValueWei: '0',
    isFree: true,
    topSelector: '0xa0712d68',
    sampleCalldata: '0xa0712d6801',
    flagged: true,
    ...overrides,
  };
}

function info(overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    contract: CONTRACT,
    hasCode: true,
    // 3000 of 5000 gone, 2000 left. At the fixture's 200/min that is ~10
    // minutes to sell out, inside the 15-minute default threshold.
    totalSupply: { value: '3000', source: 'totalSupply()' },
    maxSupply: { value: '5000', source: 'maxSupply()' },
    progressPct: 60,
    remaining: '2000',
    soldOut: false,
    // The default fixture is a real collection, so it answers ERC-165.
    isNft: true,
    looksLikeNft: true,
    summary: '',
    ...overrides,
  };
}

const criteria: HuntCriteria = { ...DEFAULT_CRITERIA };

function failedNames(checks: { name: string; passed: boolean; skipped?: boolean }[]): string[] {
  return checks.filter((c) => !c.passed && !c.skipped).map((c) => c.name);
}

describe('projectSelloutSec', () => {
  it('divides remaining supply by the observed rate', () => {
    // 600 left at 60/min = 10 minutes.
    expect(projectSelloutSec(600n, 60)).toBe(600);
  });

  it('returns undefined when nothing is minting', () => {
    expect(projectSelloutSec(100n, 0)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(7200)).toBe('2.0h');
  });
});

describe('activityStatus', () => {
  it('classifies by how long ago the last mint landed', () => {
    expect(activityStatus(3)).toBe('live');
    expect(activityStatus(40)).toBe('slowing');
    expect(activityStatus(500)).toBe('quiet');
  });
});

describe('evaluate', () => {
  it('passes a genuinely hot, fast-selling collection', () => {
    const result = evaluate(hot(), criteria, info());
    expect(result.passed).toBe(true);
    expect(result.reason).toMatch(/qualified/);
    expect(result.projectedSelloutSec).toBeDefined();
  });

  it('rejects a bot spamming from few wallets despite a high rate', () => {
    // 200 mints/min looks great until you see it came from 3 addresses.
    const result = evaluate(hot({ uniqueMinters: 3 }), criteria, info());
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('unique minters');
  });

  it('rejects a collection that already stopped minting', () => {
    const result = evaluate(
      hot({ status: 'quiet', lastSeenSecAgo: 400 }),
      criteria,
      info(),
    );
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('still minting');
  });

  it('rejects a drop that started too long ago', () => {
    const result = evaluate(hot({ ageSec: 5_000 }), criteria, info());
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('freshness');
  });

  it('rejects a sold-out collection', () => {
    const result = evaluate(hot(), criteria, info({ soldOut: true }));
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('not sold out');
  });

  it('rejects a collection almost entirely minted', () => {
    const result = evaluate(
      hot(),
      criteria,
      info({ progressPct: 97, remaining: '150', totalSupply: { value: '4850', source: 'totalSupply()' } }),
    );
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('supply left');
  });

  it('rejects fast minting against effectively unlimited supply', () => {
    // The point of the sellout check: speed alone is not scarcity.
    const result = evaluate(
      hot({ attemptsPerMinute: 60 }),
      criteria,
      info({ remaining: '5000000', maxSupply: { value: '5000000', source: 'maxSupply()' }, progressPct: 1 }),
    );
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('selling out fast');
  });

  it('accepts scarce supply that will run out quickly', () => {
    const result = evaluate(
      hot({ attemptsPerMinute: 120 }),
      criteria,
      info({ remaining: '400', progressPct: 92, maxSupply: { value: '5000', source: 'maxSupply()' } }),
    );
    // 400 / 120 per min = 200s to sell out — genuinely urgent.
    expect(result.projectedSelloutSec).toBeCloseTo(200, 0);
    // Still rejected here because 92% is past the progress gate.
    expect(failedNames(result.checks)).toContain('supply left');
    expect(failedNames(result.checks)).not.toContain('selling out fast');
  });

  it('rejects a paid mint in free-only mode', () => {
    const result = evaluate(
      hot({ isFree: false, observedValueWei: '10000000000000000', paidAttempts: 200, freeAttempts: 0 }),
      criteria,
      info(),
    );
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('free mint');
  });

  it('enforces a price ceiling when free-only is off', () => {
    const paid: HuntCriteria = { ...criteria, freeOnly: false, maxPriceWei: 1_000_000_000_000_000n };
    const result = evaluate(
      hot({ isFree: false, observedValueWei: '50000000000000000' }),
      paid,
      info(),
    );
    expect(failedNames(result.checks)).toContain('price');
  });

  it('rejects a contract whose sale flag says closed', () => {
    const result = evaluate(
      hot(),
      criteria,
      info({ saleOpen: { value: false, source: 'saleIsActive()' } }),
    );
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('sale open');
  });

  it('skips a collection the wallet already holds', () => {
    // This is what stops a repeating hunt buying the same thing every cycle.
    const result = evaluate(hot(), criteria, info({ ownedByWallet: '1' }));
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('not already held');
  });

  it('refuses a contract that says it is not an NFT', () => {
    // Load-bearing since detection stopped requiring a hardcoded selector: on
    // the feed a busy router looks exactly like a hot drop, and asking the
    // contract is the only thing that separates them.
    const result = evaluate(hot(), criteria, info({ isNft: false, looksLikeNft: false }));
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('is an NFT');
    // Not "close" either — nothing you loosen makes a router mintable.
    expect(result.score).toBe(0);
  });

  it('accepts an older collection that does not answer ERC-165', () => {
    // Plenty of real ERC-721s predate it, so silence cannot be a rejection.
    const result = evaluate(hot(), criteria, info({ isNft: undefined, looksLikeNft: true }));
    expect(result.passed).toBe(true);
  });

  it('refuses a contract with neither ERC-165 nor the shape of a collection', () => {
    const result = evaluate(hot(), criteria, info({ isNft: undefined, looksLikeNft: false }));
    expect(result.passed).toBe(false);
    expect(failedNames(result.checks)).toContain('is an NFT');
  });

  it('still passes when supply is unreadable, marking the check skipped', () => {
    // A non-standard ABI should not by itself disqualify a mint.
    const result = evaluate(hot(), criteria, info({
      totalSupply: undefined, maxSupply: undefined, progressPct: undefined, remaining: undefined,
      isNft: true,
    }));
    expect(result.passed).toBe(true);
    const supply = result.checks.find((c) => c.name === 'supply left');
    expect(supply?.skipped).toBe(true);
  });

  it('works with no contract data at all', () => {
    const result = evaluate(hot(), criteria, undefined);
    expect(result.passed).toBe(true);
  });

  it('explains every check it applied', () => {
    const result = evaluate(hot(), criteria, info());
    for (const check of result.checks) {
      expect(check.why.length).toBeGreaterThan(10);
      expect(check.actual).toBeTruthy();
      expect(check.required).toBeTruthy();
    }
  });

  it('leads its summary with the score and the weakest rule', () => {
    const result = evaluate(hot({ uniqueMinters: 1, attemptsPerMinute: 1 }), criteria, info());
    expect(result.reason).toMatch(/\/100/);
    expect(result.reason).toMatch(/unique minters/);
  });

  it('scores a full pass at 100', () => {
    const result = evaluate(hot(), criteria, info());
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it('scores a collection that only just misses far above one that misses badly', () => {
    // The whole reason for a score: counting failed rules calls both of these
    // "failed one rule", which is the distinction that actually matters.
    const near = evaluate(
      hot({ uniqueMinters: criteria.minUniqueMinters - 1 }), criteria, info(),
    );
    const far = evaluate(hot({ uniqueMinters: 1 }), criteria, info());

    expect(near.passed).toBe(false);
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.score).toBeGreaterThanOrEqual(90);
  });

  it('scores an un-tunable blocker below the close cut', () => {
    // No threshold makes an already-held or closed-sale collection buyable, so
    // it must not sit in the list of things one dial away from qualifying.
    const blocked = evaluate(hot(), criteria, {
      ...info(),
      saleOpen: { value: false, source: 'saleIsActive()' },
      ownedByWallet: '2',
    });
    expect(blocked.score).toBeLessThan(CLOSE_SCORE);
  });
});
