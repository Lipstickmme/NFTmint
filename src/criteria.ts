import { formatEther } from 'viem';
import type { ContractInfo } from './inspect.js';
import type { TrackedCollection } from './tracker.js';

/**
 * What makes a mint worth auto-buying.
 *
 * The goal is not "lots of transactions" — that is trivially faked by one bot
 * in a loop, and it says nothing about whether supply is actually running out.
 * The goal is a collection that real people are racing for and that will sell
 * out soon, because those are the mints where getting in early matters.
 *
 * Six independent signals, each of which rules out a different way of being
 * wrong:
 *
 *  1. Mint rate        — is it moving fast at all?
 *  2. Unique minters   — is it many people, or one bot spamming? A collection
 *                        with 300 attempts from 4 addresses is a bot fight over
 *                        something nobody else wants.
 *  3. Freshness        — did it start recently? Joining a mint 20 minutes in
 *                        means the good tokens are gone and you are racing the
 *                        tail.
 *  4. Liveness         — are mints still landing right now? A gap means it
 *                        already finished; the counts are history.
 *  5. Sellout runway   — remaining supply divided by current rate. This is the
 *                        signal that actually answers "is it minting out with
 *                        speed". Fast rate against unlimited supply is not
 *                        scarcity; fast rate against 400 remaining is.
 *  6. Not already gone — if it is 95% minted, you will very likely lose the
 *                        race and pay gas for a revert.
 *
 * Every check reports its own pass/fail with the numbers, so the UI can show
 * why a collection was taken or skipped rather than being a black box.
 */

export interface HuntCriteria {
  /** Sustained mint attempts per minute. */
  minMintsPerMinute: number;
  /** Distinct minting addresses. The anti-bot gate. */
  minUniqueMinters: number;
  /** Attempts inside the tracker's velocity window. */
  minAttemptsInWindow: number;
  /** Ignore collections first seen longer ago than this. */
  maxAgeSec: number;
  /** Require a mint attempt within the last few seconds. */
  requireLive: boolean;
  /**
   * Projected seconds until supply is exhausted at the current rate.
   * Only applied when supply is readable from the contract.
   */
  maxSelloutSec: number;
  /** Skip collections already this far through their supply. */
  maxSupplyProgressPct: number;
  /** Only mint when no ETH is attached. */
  freeOnly: boolean;
  /** Ceiling on mint price when freeOnly is off. */
  maxPriceWei: bigint;
  /** If the contract exposes a sale-open flag, it must say open. */
  requireSaleOpen: boolean;
  /** Skip contracts the wallet already holds a token from. */
  skipIfOwned: boolean;
}

export const DEFAULT_CRITERIA: HuntCriteria = {
  minMintsPerMinute: 30,
  minUniqueMinters: 8,
  minAttemptsInWindow: 15,
  maxAgeSec: 300,
  requireLive: true,
  maxSelloutSec: 900,
  maxSupplyProgressPct: 90,
  freeOnly: true,
  maxPriceWei: 0n,
  requireSaleOpen: true,
  skipIfOwned: true,
};

export interface Check {
  name: string;
  passed: boolean;
  /** Observed value, formatted for display. */
  actual: string;
  /** Threshold, formatted for display. */
  required: string;
  /** Plain-language reason this check exists. */
  why: string;
  /** True when the data needed was unavailable, so the check was not applied. */
  skipped?: boolean;
}

export interface Evaluation {
  contract: string;
  passed: boolean;
  checks: Check[];
  /** Seconds until sellout at the observed rate, when supply is readable. */
  projectedSelloutSec?: number;
  /** One-line summary suitable for a log line or a table cell. */
  reason: string;
}

/**
 * Estimate how long until supply runs out at the current rate.
 *
 * Uses attempts rather than confirmed mints, so it is an optimistic estimate —
 * some attempts revert. That bias is acceptable here: it errs toward treating a
 * mint as urgent, which is the safer direction when the cost of being late is
 * missing it entirely and the cost of being early is only gas.
 */
export function projectSelloutSec(
  remaining: bigint,
  mintsPerMinute: number,
): number | undefined {
  if (mintsPerMinute <= 0) return undefined;
  return (Number(remaining) / mintsPerMinute) * 60;
}

export function evaluate(
  collection: TrackedCollection,
  criteria: HuntCriteria,
  info?: ContractInfo,
): Evaluation {
  const checks: Check[] = [];

  checks.push({
    name: 'mint rate',
    passed: collection.attemptsPerMinute >= criteria.minMintsPerMinute,
    actual: `${collection.attemptsPerMinute}/min`,
    required: `>= ${criteria.minMintsPerMinute}/min`,
    why: 'A collection minting out fast produces a high sustained rate.',
  });

  checks.push({
    name: 'unique minters',
    passed: collection.uniqueMinters >= criteria.minUniqueMinters,
    actual: String(collection.uniqueMinters),
    required: `>= ${criteria.minUniqueMinters}`,
    why:
      'Many distinct wallets means real demand. A high count from few addresses ' +
      'is one bot spamming something nobody else wants.',
  });

  checks.push({
    name: 'burst size',
    passed: collection.attemptsInWindow >= criteria.minAttemptsInWindow,
    actual: String(collection.attemptsInWindow),
    required: `>= ${criteria.minAttemptsInWindow}`,
    why: 'Enough activity inside the recent window to be a real rush.',
  });

  checks.push({
    name: 'freshness',
    passed: collection.ageSec <= criteria.maxAgeSec,
    actual: `${Math.round(collection.ageSec)}s old`,
    required: `<= ${criteria.maxAgeSec}s`,
    why: 'Joining late means the supply is mostly gone and you race the tail.',
  });

  if (criteria.requireLive) {
    checks.push({
      name: 'still minting',
      passed: collection.status === 'live',
      actual: `${collection.status} (last ${Math.round(collection.lastSeenSecAgo)}s ago)`,
      required: 'live',
      why: 'A gap in activity means it already finished — the counts are history.',
    });
  }

  if (criteria.freeOnly) {
    checks.push({
      name: 'free mint',
      passed: collection.isFree && BigInt(collection.observedValueWei) === 0n,
      actual: collection.isFree
        ? 'free'
        : `${formatEther(BigInt(collection.observedValueWei))} ETH`,
      required: 'free',
      why: 'Free-only caps your downside at gas.',
    });
  } else {
    const observed = BigInt(collection.observedValueWei);
    checks.push({
      name: 'price',
      passed: observed <= criteria.maxPriceWei,
      actual: `${formatEther(observed)} ETH`,
      required: `<= ${formatEther(criteria.maxPriceWei)} ETH`,
      why: 'Keeps a single mint inside your per-collection budget.',
    });
  }

  // ── Contract-derived checks. Absent data skips rather than fails, because a
  // non-standard ABI is common and should not by itself disqualify a mint.
  let projectedSelloutSec: number | undefined;

  if (info?.soldOut) {
    checks.push({
      name: 'not sold out',
      passed: false,
      actual: 'sold out',
      required: 'supply remaining',
      why: 'Nothing left to mint.',
    });
  } else if (info?.progressPct !== undefined) {
    checks.push({
      name: 'supply left',
      passed: info.progressPct <= criteria.maxSupplyProgressPct,
      actual: `${info.progressPct.toFixed(1)}% minted`,
      required: `<= ${criteria.maxSupplyProgressPct}%`,
      why: 'Past this point you will probably lose the race and pay gas for a revert.',
    });

    if (info.remaining !== undefined) {
      projectedSelloutSec = projectSelloutSec(
        BigInt(info.remaining),
        collection.attemptsPerMinute,
      );
      if (projectedSelloutSec !== undefined) {
        checks.push({
          name: 'selling out fast',
          passed: projectedSelloutSec <= criteria.maxSelloutSec,
          actual: `~${formatDuration(projectedSelloutSec)} to sell out`,
          required: `<= ${formatDuration(criteria.maxSelloutSec)}`,
          why:
            'Remaining supply divided by the current rate. This is the real test ' +
            'of scarcity — a fast rate against unlimited supply is not selling out.',
        });
      }
    }
  } else {
    checks.push({
      name: 'supply left',
      passed: true,
      skipped: true,
      actual: 'not readable',
      required: `<= ${criteria.maxSupplyProgressPct}%`,
      why: 'This contract does not expose totalSupply/maxSupply, so this was skipped.',
    });
  }

  if (criteria.requireSaleOpen && info?.saleOpen) {
    checks.push({
      name: 'sale open',
      passed: info.saleOpen.value,
      actual: info.saleOpen.value ? 'open' : 'closed',
      required: 'open',
      why: `The contract's ${info.saleOpen.source} says whether minting is allowed.`,
    });
  }

  if (criteria.skipIfOwned && info?.ownedByWallet !== undefined) {
    const owned = BigInt(info.ownedByWallet);
    checks.push({
      name: 'not already held',
      passed: owned === 0n,
      actual: `holds ${owned}`,
      required: '0',
      why:
        'You already minted this one. Checking on-chain is what stops a repeating ' +
        'hunt from buying the same collection every cycle.',
    });
  }

  const failed = checks.filter((c) => !c.passed && !c.skipped);
  const passed = failed.length === 0;

  return {
    contract: collection.contract,
    passed,
    checks,
    projectedSelloutSec,
    reason: passed
      ? `qualified: ${collection.attemptsPerMinute}/min from ${collection.uniqueMinters} wallets` +
        (projectedSelloutSec !== undefined
          ? `, ~${formatDuration(projectedSelloutSec)} to sell out`
          : '')
      : `skipped: ${failed.map((c) => c.name).join(', ')}`,
  };
}

/**
 * Criteria the UI is allowed to change, with the range each may take.
 *
 * These are *quality* dials — they decide what counts as a good mint. Loosening
 * them means buying more things, which is a strategy choice the operator should
 * be able to make from the browser.
 *
 * The *money* limits are deliberately absent: `maxPriceWei`, the per-cycle mint
 * cap, and the spend ceiling stay server-side. A browser can change what the
 * bot looks for, never how much it is allowed to lose.
 */
const ADJUSTABLE = {
  minMintsPerMinute: { min: 0, max: 100_000 },
  minUniqueMinters: { min: 0, max: 10_000 },
  minAttemptsInWindow: { min: 0, max: 100_000 },
  maxAgeSec: { min: 5, max: 86_400 },
  maxSelloutSec: { min: 10, max: 86_400 },
  maxSupplyProgressPct: { min: 0, max: 100 },
} as const;

const ADJUSTABLE_FLAGS = [
  'requireLive',
  'requireSaleOpen',
  'skipIfOwned',
  'freeOnly',
] as const;

export type AdjustableKey = keyof typeof ADJUSTABLE | (typeof ADJUSTABLE_FLAGS)[number];

/** Which criteria the UI may edit, and their bounds. For rendering the form. */
export function adjustableCriteria(): Record<string, unknown> {
  return {
    numbers: ADJUSTABLE,
    flags: ADJUSTABLE_FLAGS,
  };
}

/**
 * Merge user-supplied criteria over the configured defaults.
 *
 * Unknown keys are ignored and numbers are clamped, so a malformed or hostile
 * request degrades to the server's settings rather than doing something wild.
 */
export function mergeCriteria(
  base: HuntCriteria,
  overrides: Record<string, string | undefined>,
): { criteria: HuntCriteria; applied: string[] } {
  const criteria: HuntCriteria = { ...base };
  const applied: string[] = [];

  for (const [key, bounds] of Object.entries(ADJUSTABLE)) {
    const raw = overrides[key];
    if (raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) continue;
    const clamped = Math.min(Math.max(parsed, bounds.min), bounds.max);
    (criteria as unknown as Record<string, number>)[key] = clamped;
    applied.push(`${key}=${clamped}`);
  }

  for (const key of ADJUSTABLE_FLAGS) {
    const raw = overrides[key];
    if (raw === undefined || raw === '') continue;
    const value = raw === 'true';
    (criteria as unknown as Record<string, boolean>)[key] = value;
    applied.push(`${key}=${value}`);
  }

  // Turning off free-only does not grant a budget: paid mints still need
  // HUNT_MAX_PRICE_ETH set on the server, which a browser cannot touch.
  return { criteria, applied };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
