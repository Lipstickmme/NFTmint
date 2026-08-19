import { CLOSE_SCORE } from './criteria.js';
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
  /**
   * Weighted match score out of 100, so "close" is a number rather than a
   * count of failures. 100 means it qualified.
   */
  score: number;
  /** Rules it failed, weakest first, so the dial to loosen leads. */
  failedChecks: string[];
  /** One-line verdict from the criteria engine. */
  reason: string;

  /** What happened when a buy was attempted, when one was. */
  outcome?: string;
  minted?: number;
  txUrls?: string[];

  /**
   * What it turned out to be worth, filled in later from the configured
   * marketplace. Absent when no source is configured — an unknown floor is
   * left unknown rather than shown as zero.
   */
  floor?: string;
  floorCurrency?: string;
  floorCheckedAt?: string;
  /** Floor times the wallets that would have minted: the cost of the skip. */
  missedValue?: string;
}

/**
 * Worth keeping even though it did not qualify.
 *
 * Scored rather than counted, because the count of failed rules says nothing
 * about distance: missing the mint rate by one is a different thing from
 * missing it by a factor of thirty, and only the first is worth a second look.
 * Anything at or above the cut goes in the "close" list, which is the tuning
 * surface — it answers "was anything nearly good enough, and which dial was in
 * the way".
 */
export function isClose(score: number, min = CLOSE_SCORE): boolean {
  return score >= min && score < 100;
}

/** Flatten a hunt candidate into a storable record. */
export function toFinding(candidate: Candidate, now = new Date()): Finding {
  const { collection, info, evaluation, minted } = candidate;
  // Weakest first: the rule furthest from passing is the one to loosen.
  const failed = [...evaluation.checks]
    .filter((c) => !c.passed && !c.skipped)
    .sort((a, b) => a.score - b.score)
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
    score: evaluation.score,
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
    // Never lose the fact that it was once bought, or once passed. The score
    // keeps its best showing for the same reason: a collection that scored 96
    // and later cooled off was still a 96 at the moment that mattered.
    passed: existing.passed || incoming.passed,
    score: Math.max(existing.score, incoming.score),
    minted: incoming.minted ?? existing.minted,
    txUrls: incoming.txUrls?.length ? incoming.txUrls : existing.txUrls,
    imageUrl: incoming.imageUrl ?? existing.imageUrl,
    name: incoming.name ?? existing.name,
    // Price lookups happen on read, not during a round, so an incoming record
    // from a fresh sighting never carries one — keep whatever was found before.
    floor: incoming.floor ?? existing.floor,
    floorCurrency: incoming.floorCurrency ?? existing.floorCurrency,
    floorCheckedAt: incoming.floorCheckedAt ?? existing.floorCheckedAt,
    missedValue: incoming.missedValue ?? existing.missedValue,
  };
}
