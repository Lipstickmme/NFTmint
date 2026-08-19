import type { Candidate } from './hunt.js';

/**
 * A collection worth remembering, flattened for storage.
 *
 * Deliberately not the whole `Candidate`: that carries every probed field and
 * every check, which is far more than a history list needs and would bloat
 * whatever store sits behind it. This keeps what answers "what did it find,
 * and why did it or did it not buy".
 */
export interface Finding {
  contract: string;
  name?: string;
  imageUrl?: string;

  firstSeenAt: string;
  lastSeenAt: string;
  /** How many rounds this collection has been recorded in. */
  timesSeen: number;

  /** Demand at the moment it was recorded. */
  mintsPerMinute: number;
  uniqueMinters: number;
  remaining?: string;
  progressPct?: number;
  projectedSelloutSec?: number;
  isFree: boolean;

  /** True when every rule passed. */
  passed: boolean;
  /** Rules it failed, so a near miss shows what to loosen. */
  failedChecks: string[];
  /** One-line verdict from the criteria engine. */
  reason: string;

  /** What happened when a buy was attempted, when one was. */
  outcome?: string;
  minted?: number;
  txUrls?: string[];
}

/**
 * How close a collection came to qualifying.
 *
 * A near miss is the useful signal for tuning: it says "this would have been
 * bought if one threshold were slightly looser", which is exactly the decision
 * an operator makes. Anything failing more than a couple of rules is not a near
 * miss, it is simply not a candidate.
 */
export function isNearMiss(failedCount: number, maxFailures = 2): boolean {
  return failedCount > 0 && failedCount <= maxFailures;
}

/** Flatten a hunt candidate into a storable record. */
export function toFinding(candidate: Candidate, now = new Date()): Finding {
  const { collection, info, evaluation, minted } = candidate;
  const failed = evaluation.checks
    .filter((c) => !c.passed && !c.skipped)
    .map((c) => c.name);

  const iso = now.toISOString();
  return {
    contract: collection.contract,
    name: info?.name,
    imageUrl: info?.preview?.imageUrl,
    firstSeenAt: iso,
    lastSeenAt: iso,
    timesSeen: 1,
    mintsPerMinute: collection.attemptsPerMinute,
    uniqueMinters: collection.uniqueMinters,
    remaining: info?.remaining,
    progressPct: info?.progressPct,
    projectedSelloutSec: evaluation.projectedSelloutSec,
    isFree: collection.isFree,
    passed: evaluation.passed,
    failedChecks: failed,
    reason: evaluation.reason,
    outcome: minted?.error ?? (minted && minted.confirmed > 0 ? 'bought' : undefined),
    minted: minted?.confirmed,
    txUrls: minted?.txs?.map((t) => t.url),
  };
}

/**
 * Fold a new sighting into an existing record.
 *
 * Collections reappear across rounds, and keeping one row per sighting would
 * bury the list in duplicates. The first sighting time is preserved because
 * "when did this drop start" is the interesting half; everything else reflects
 * the latest observation.
 */
export function mergeFinding(existing: Finding, incoming: Finding): Finding {
  return {
    ...incoming,
    firstSeenAt: existing.firstSeenAt,
    timesSeen: existing.timesSeen + 1,
    // Never lose the fact that it was once bought, or once passed.
    passed: existing.passed || incoming.passed,
    minted: incoming.minted ?? existing.minted,
    txUrls: incoming.txUrls?.length ? incoming.txUrls : existing.txUrls,
    imageUrl: incoming.imageUrl ?? existing.imageUrl,
    name: incoming.name ?? existing.name,
  };
}
