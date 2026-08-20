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
  /**
   * How close this check came, from 0 to 1. Exactly 1 when it passed.
   *
   * Pass/fail alone throws away the difference between "needed 30 mints a
   * minute and saw 29" and "saw 2". Both are skips, but only one is worth
   * looking at, and only one says the threshold might be a shade too tight.
   */
  score: number;
  /** Relative importance when the per-check scores are rolled into one. */
  weight: number;
  /**
   * A rule with no threshold behind it: sold out, sale closed, already held.
   *
   * These are not "nearly passed" at any setting — there is no dial that makes
   * an owned collection buyable again. Failing one takes the score to zero, so
   * an unbuyable collection can never sit in the list of things one adjustment
   * away from qualifying.
   */
  blocking?: boolean;
}

export interface Evaluation {
  contract: string;
  passed: boolean;
  checks: Check[];
  /** Seconds until sellout at the observed rate, when supply is readable. */
  projectedSelloutSec?: number;
  /**
   * Weighted match score out of 100. A collection that passed everything is
   * 100 by construction; anything lower is the distance left to cover.
   */
  score: number;
  /** One-line summary suitable for a log line or a table cell. */
  reason: string;
}

/**
 * Good enough to be worth showing, even though it did not qualify.
 *
 * The cut is deliberately generous. The list it feeds is for tuning, and the
 * question it answers is "was anything nearly good enough, and which dial was
 * in the way" — so it should err toward showing one collection too many.
 */
export const CLOSE_SCORE = 70;

export function isClose(score: number, min = CLOSE_SCORE): boolean {
  return score >= min;
}

/**
 * Partial credit toward a floor: half the required rate scores 0.5.
 */
function atLeast(actual: number, required: number): number {
  if (required <= 0) return 1;
  return Math.max(0, Math.min(1, actual / required));
}

/**
 * Partial credit against a ceiling: twice the allowed age scores 0.5.
 */
function atMost(actual: number, required: number): number {
  if (actual <= required) return 1;
  if (actual <= 0) return 1;
  return Math.max(0, Math.min(1, required / Math.max(actual, 1e-9)));
}

/**
 * Partial credit for a percentage under a ceiling, measured as the headroom
 * left. At 100% minted the score is 0 however loose the ceiling was, which is
 * right: there is nothing left regardless of what you asked for.
 */
function headroom(actualPct: number, requiredPct: number): number {
  if (actualPct <= requiredPct) return 1;
  const span = 100 - requiredPct;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (100 - actualPct) / span));
}

/**
 * Roll the per-check scores into one number out of 100.
 *
 * Skipped checks are left out entirely rather than counted as passes: a
 * contract with an unreadable supply should not score higher than one whose
 * supply was read and was fine.
 */
export function scoreOf(checks: Check[]): number {
  const applied = checks.filter((c) => !c.skipped);
  if (applied.length === 0) return 0;
  // Nothing you can adjust rescues this, so it is not close to anything.
  if (applied.some((c) => c.blocking && !c.passed)) return 0;
  const total = applied.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return 0;
  const earned = applied.reduce((sum, c) => sum + c.score * c.weight, 0);
  return Math.round((earned / total) * 100);
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
    score: atLeast(collection.attemptsPerMinute, criteria.minMintsPerMinute),
    weight: 2,
  });

  checks.push({
    name: 'unique minters',
    passed: collection.uniqueMinters >= criteria.minUniqueMinters,
    actual: String(collection.uniqueMinters),
    required: `>= ${criteria.minUniqueMinters}`,
    why:
      'Many distinct wallets means real demand. A high count from few addresses ' +
      'is one bot spamming something nobody else wants.',
    // The highest-value dial, so it carries the most weight in the score.
    score: atLeast(collection.uniqueMinters, criteria.minUniqueMinters),
    weight: 3,
  });

  checks.push({
    name: 'burst size',
    passed: collection.attemptsInWindow >= criteria.minAttemptsInWindow,
    actual: String(collection.attemptsInWindow),
    required: `>= ${criteria.minAttemptsInWindow}`,
    why: 'Enough activity inside the recent window to be a real rush.',
    score: atLeast(collection.attemptsInWindow, criteria.minAttemptsInWindow),
    weight: 1,
  });

  checks.push({
    name: 'freshness',
    passed: collection.ageSec <= criteria.maxAgeSec,
    actual: `${Math.round(collection.ageSec)}s old`,
    required: `<= ${criteria.maxAgeSec}s`,
    why: 'Joining late means the supply is mostly gone and you race the tail.',
    score: atMost(collection.ageSec, criteria.maxAgeSec),
    weight: 1,
  });

  if (criteria.requireLive) {
    checks.push({
      name: 'still minting',
      passed: collection.status === 'live',
      actual: `${collection.status} (last ${Math.round(collection.lastSeenSecAgo)}s ago)`,
      required: 'live',
      why: 'A gap in activity means it already finished — the counts are history.',
      // 'slowing' is genuinely closer than 'ended' and scores accordingly.
      score: collection.status === 'live' ? 1 : collection.status === 'slowing' ? 0.5 : 0,
      weight: 2,
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
      score: collection.isFree && BigInt(collection.observedValueWei) === 0n ? 1 : 0,
      weight: 2,
    });
  } else {
    const observed = BigInt(collection.observedValueWei);
    checks.push({
      name: 'price',
      passed: observed <= criteria.maxPriceWei,
      actual: `${formatEther(observed)} ETH`,
      required: `<= ${formatEther(criteria.maxPriceWei)} ETH`,
      why: 'Keeps a single mint inside your per-collection budget.',
      score: atMost(Number(observed), Number(criteria.maxPriceWei)),
      weight: 2,
    });
  }

  // ── Contract-derived checks. Absent data skips rather than fails, because a
  // non-standard ABI is common and should not by itself disqualify a mint.
  let projectedSelloutSec: number | undefined;

  // Is this even an NFT?
  //
  // This became load-bearing when mint detection stopped requiring a hardcoded
  // selector. On the feed, a busy router with three hundred distinct callers is
  // indistinguishable from a hot drop — same shape, same velocity, same crowd.
  // The only thing that tells them apart is asking the contract, and getting it
  // wrong means sending copied calldata to something that is not a mint at all.
  if (!info) {
    // No contract data at all — the read failed, or the contract answers
    // nothing. Everything left is feed-derived, and the feed cannot tell a
    // collection from a swap router. This was the hole a real Swap Router came
    // through: inspection threw, every contract check was skipped, and it
    // qualified on velocity alone.
    checks.push({
      name: 'is an NFT',
      passed: false,
      actual: 'could not read the contract',
      required: 'ERC-721 or ERC-1155',
      why:
        'Nothing could be read from this address, so there is no evidence it is a ' +
        'collection rather than any other busy contract. Velocity alone cannot tell ' +
        'them apart.',
      score: 0,
      weight: 4,
      blocking: true,
    });
  } else {
    if (info.isNft !== undefined) {
      checks.push({
        name: 'is an NFT',
        passed: info.isNft,
        actual: info.isNft ? 'ERC-721 or ERC-1155' : 'neither, by its own answer',
        required: 'ERC-721 or ERC-1155',
        why: 'The contract was asked directly, over ERC-165.',
        score: info.isNft ? 1 : 0,
        weight: 4,
        blocking: true,
      });
    } else {
      // No ERC-165. Fall back to the shape of what it exposes, which is weaker
      // but still separates a collection from a pool.
      checks.push({
        name: 'is an NFT',
        passed: info.looksLikeNft,
        actual: info.looksLikeNft
          ? 'no ERC-165, but has a name and a supply'
          : 'no ERC-165, no name or supply either',
        required: 'looks like a collection',
        why:
          'This contract does not answer ERC-165, so it was judged on whether it ' +
          'exposes the metadata and supply an NFT normally would.',
        score: info.looksLikeNft ? 1 : 0,
        weight: 4,
        blocking: true,
      });
    }
  }

  if (info?.soldOut) {
    checks.push({
      name: 'not sold out',
      passed: false,
      actual: 'sold out',
      required: 'supply remaining',
      why: 'Nothing left to mint.',
      score: 0,
      weight: 4,
      blocking: true,
    });
  } else if (info?.progressPct !== undefined) {
    checks.push({
      name: 'supply left',
      passed: info.progressPct <= criteria.maxSupplyProgressPct,
      actual: `${info.progressPct.toFixed(1)}% minted`,
      required: `<= ${criteria.maxSupplyProgressPct}%`,
      why: 'Past this point you will probably lose the race and pay gas for a revert.',
      score: headroom(info.progressPct, criteria.maxSupplyProgressPct),
      weight: 2,
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
          score: atMost(projectedSelloutSec, criteria.maxSelloutSec),
          weight: 3,
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
      score: 1,
      weight: 0,
    });
  }

  if (criteria.requireSaleOpen && info?.saleOpen) {
    checks.push({
      name: 'sale open',
      passed: info.saleOpen.value,
      actual: info.saleOpen.value ? 'open' : 'closed',
      required: 'open',
      why: `The contract's ${info.saleOpen.source} says whether minting is allowed.`,
      score: info.saleOpen.value ? 1 : 0,
      weight: 3,
      blocking: true,
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
      score: owned === 0n ? 1 : 0,
      weight: 4,
      blocking: true,
    });
  }

  const failed = checks.filter((c) => !c.passed && !c.skipped);
  const passed = failed.length === 0;

  return {
    contract: collection.contract,
    passed,
    checks,
    projectedSelloutSec,
    score: scoreOf(checks),
    reason: passed
      ? `qualified: ${collection.attemptsPerMinute}/min from ${collection.uniqueMinters} wallets` +
        (projectedSelloutSec !== undefined
          ? `, ~${formatDuration(projectedSelloutSec)} to sell out`
          : '')
      : // Weakest first: with a score attached, the useful thing to lead with
        // is the rule furthest from passing, since that is the one to loosen.
        `${scoreOf(checks)}/100 — short on ${[...failed]
          .sort((a, b) => a.score - b.score)
          .map((c) => c.name)
          .join(', ')}`,
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
