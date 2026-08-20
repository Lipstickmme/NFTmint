import { EventEmitter } from 'node:events';
import { recoverTransactionAddress, type Address, type Hex } from 'viem';
import { classifyMint, mintTarget, PROXY_MINT_SELECTORS } from './mintdetect.js';
import { log } from './logger.js';
import type { FeedTx } from './feed.js';

/**
 * Mint tracker.
 *
 * Consumes the sequencer feed, groups mint attempts by contract, and measures
 * how fast each collection is being minted. The premise: on a chain where
 * everyone sees the same FCFS queue, the clearest signal that a drop is sought
 * after is how many distinct people pile into it in its first seconds.
 *
 * Two counts matter, and they mean different things:
 *   - attempts  — raw demand, but one bot spamming 200 transactions inflates it.
 *   - unique minters — the honest signal. 200 attempts from 3 addresses is a
 *     bot fight; 200 from 150 addresses is a real drop.
 *
 * Sender recovery is ECDSA work (~1ms per transaction), far too slow to do
 * inline on a busy feed. It runs in a bounded background queue that drops work
 * under pressure rather than falling behind the feed — an approximate unique
 * count that stays current beats an exact one that lags.
 */

export interface TrackerConfig {
  /** Window, in seconds, over which "mints in the first N seconds" is measured. */
  velocityWindowSec: number;
  /** Attempts within the window required to call a collection hot. */
  minAttempts: number;
  /** Distinct minters required. 0 disables the check. */
  minUniqueMinters: number;
  /** Ignore contracts first seen longer ago than this; we only want fresh drops. */
  maxContractAgeSec: number;
  /** Only flag collections whose mints carry no ETH. */
  freeOnly: boolean;
  /** Extra mint selectors beyond the built-in set. */
  extraSelectors?: ReadonlySet<Hex>;
  /** Recover sender addresses to count unique minters. */
  trackUniqueMinters: boolean;
  /** Max contracts held in memory before the coldest are evicted. */
  maxContracts: number;
  /** Drop a contract that has seen no activity for this long. */
  evictAfterSec: number;
  /**
   * Calls needed before an unrecognised entrypoint is tracked in full.
   *
   * Recognised mint selectors skip this. Everything else is held in a cheap
   * counting state first, so widening detection past a hardcoded list does not
   * mean paying for sender recovery on every transfer on the chain.
   */
  promoteAfter: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  velocityWindowSec: 15,
  minAttempts: 25,
  minUniqueMinters: 10,
  maxContractAgeSec: 900,
  freeOnly: false,
  trackUniqueMinters: true,
  maxContracts: 5_000,
  evictAfterSec: 3_600,
  promoteAfter: 6,
};

interface Sample {
  at: number;
  free: boolean;
}

export interface ContractStats {
  contract: Address;
  firstSeenAt: number;
  firstSeenSeq: number;
  lastSeenAt: number;
  attempts: number;
  freeAttempts: number;
  paidAttempts: number;
  totalValueWei: bigint;
  uniqueMinters: Set<Address>;
  selectors: Map<Hex, number>;
  /**
   * A representative calldata payload per selector, taken from a real minter.
   *
   * This is what makes auto-minting an unknown collection tractable: rather
   * than guessing quantity and argument order, we start from calldata that
   * demonstrably works. It must never be replayed verbatim when the function
   * takes a recipient address — see `buildAutoMintCall`.
   */
  sampleCalldata: Map<Hex, Hex>;
  /**
   * The signed transaction each sample came from.
   *
   * Kept so the sample's sender can be recovered later. That address is what
   * makes ABI-free replay possible: find it inside the calldata and the
   * recipient position is located without knowing the function at all.
   */
  sampleRaw: Map<Hex, Hex>;
  samples: Sample[];
  /** Set once the contract has been reported hot, so it fires only once. */
  flagged: boolean;
  /**
   * False while an unrecognised entrypoint is still just being counted.
   *
   * Unpromoted contracts cost one map entry and nothing else — no samples, no
   * sender recovery, no snapshot row.
   */
  promoted: boolean;
  /** True when the entrypoint is one we recognise outright. */
  knownSelector: boolean;
  /**
   * The address mints were actually sent to, when that is not the collection.
   *
   * Kept because replaying the calldata means sending it back to the drop
   * contract, not to the collection the row is named after.
   */
  mintVia?: Address;
}

export interface HotCollection {
  contract: Address;
  /** Attempts inside the velocity window measured from first sighting. */
  attemptsInWindow: number;
  uniqueMinters: number;
  ageSec: number;
  isFree: boolean;
  topSelector?: Hex;
  /** Calldata observed from a real minter using `topSelector`. */
  sampleCalldata?: Hex;
  /** The signed transaction that calldata came from. */
  sampleRaw?: Hex;
  /** Median-ish ETH attached, so the autopilot knows what to send. */
  observedValueWei: bigint;
  attempts: number;
  firstSeenAt: number;
}

/**
 * How lively a collection is right now.
 *
 * The question a user actually has when they see a contract in the list is
 * "is this still minting?", which raw counts do not answer — a collection with
 * 400 attempts might have finished ten minutes ago.
 */
export type ActivityStatus = 'live' | 'slowing' | 'quiet';

/**
 * Classify liveness from how long ago the last mint attempt was seen.
 *
 * A mint in progress produces attempts continuously, so a gap is the clearest
 * evidence it has stopped — either sold out or the window closed.
 */
export function activityStatus(lastSeenSecAgo: number): ActivityStatus {
  if (lastSeenSecAgo <= 15) return 'live';
  if (lastSeenSecAgo <= 90) return 'slowing';
  return 'quiet';
}

/** Public snapshot shape, safe to serialize for the dashboard API. */
export interface TrackedCollection {
  contract: Address;
  firstSeenAt: number;
  lastSeenAt: number;
  ageSec: number;
  /** Seconds since the last observed mint attempt. */
  lastSeenSecAgo: number;
  /** Plain answer to "is this still minting?". */
  status: ActivityStatus;
  attempts: number;
  freeAttempts: number;
  paidAttempts: number;
  uniqueMinters: number;
  attemptsInWindow: number;
  attemptsPerMinute: number;
  totalValueWei: string;
  /** Average ETH attached per observed mint — effectively the mint price. */
  observedValueWei: string;
  isFree: boolean;
  topSelector?: Hex;
  /**
   * Calldata from a transaction that a real minter actually sent.
   *
   * This is what spares the user from hand-writing calldata: it is known to
   * work against this contract right now. The UI offers it as a one-click
   * fill; `buildAutoMintCall` handles rewriting any recipient address.
   */
  sampleCalldata?: Hex;
  /** The signed transaction that calldata came from, for ABI-free replay. */
  sampleRaw?: Hex;
  /** The drop contract mints go through, when they do not go direct. */
  mintVia?: Address;
  /**
   * Whether the entrypoint was recognised outright, or learned from the fact
   * that a lot of distinct wallets were calling it. Surfaced so the UI can be
   * honest about which it is.
   */
  entrypoint: 'known' | 'observed';
  /** True once the tracker's own thresholds flagged this as hot. */
  flagged: boolean;
}

export class MintTracker extends EventEmitter {
  readonly config: TrackerConfig;
  private readonly contracts = new Map<Address, ContractStats>();
  private readonly recoveryQueue: Array<{ contract: Address; raw: Hex }> = [];
  private recovering = false;
  private droppedRecoveries = 0;

  /** Feed transactions seen, whether or not they were mints. */
  totalSeen = 0;
  totalMints = 0;

  constructor(config: Partial<TrackerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
  }

  /**
   * Ingest one feed transaction. Kept cheap: classification is a set lookup,
   * and anything expensive is deferred.
   */
  ingest(tx: FeedTx, sequenceNumber = -1, now = Date.now()): void {
    this.totalSeen += 1;

    const classification = classifyMint(
      { to: tx.to, selector: tx.selector, value: tx.value, data: tx.data },
      this.config.extraSelectors,
    );
    if (!classification.isMint || !tx.to) return;

    // A mint made through a shared drop contract belongs to the collection it
    // was for, not to the drop contract. Without this, OpenSea's SeaDrop shows
    // up as one impossibly busy address with no NFT interface, and every
    // collection minting through it is invisible.
    const target = mintTarget({ to: tx.to, selector: tx.selector, data: tx.data });
    if (!target) return;

    this.totalMints += 1;
    const viaProxy =
      tx.selector !== undefined &&
      PROXY_MINT_SELECTORS.has(tx.selector.toLowerCase() as Hex);
    const contract = target.toLowerCase() as Address;

    let stats = this.contracts.get(contract);
    if (!stats) {
      stats = {
        contract,
        firstSeenAt: now,
        firstSeenSeq: sequenceNumber,
        lastSeenAt: now,
        attempts: 0,
        freeAttempts: 0,
        paidAttempts: 0,
        totalValueWei: 0n,
        uniqueMinters: new Set(),
        selectors: new Map(),
        sampleCalldata: new Map(),
        sampleRaw: new Map(),
        samples: [],
        flagged: false,
        // A recognised selector is trusted from the first sighting; anything
        // else has to be called `promoteAfter` times before it costs anything.
        promoted: classification.confidence === 'known',
        knownSelector: classification.confidence === 'known',
        mintVia: viaProxy ? (tx.to.toLowerCase() as Address) : undefined,
      };
      this.contracts.set(contract, stats);
      this.emit('discovered', contract, now);
      this.evictIfNeeded(now);
    }

    stats.lastSeenAt = now;
    stats.attempts += 1;
    stats.totalValueWei += tx.value;
    if (classification.isFree) stats.freeAttempts += 1;
    else stats.paidAttempts += 1;
    if (classification.confidence === 'known') stats.knownSelector = true;
    if (viaProxy) stats.mintVia = tx.to.toLowerCase() as Address;

    if (tx.selector) {
      stats.selectors.set(tx.selector, (stats.selectors.get(tx.selector) ?? 0) + 1);
    }

    // Enough people have called this to be worth the expensive half.
    if (!stats.promoted && stats.attempts >= this.config.promoteAfter) {
      stats.promoted = true;
    }

    // Everything below costs real work — memory, or ECDSA — so it waits for
    // promotion. An unrecognised selector called twice is noise; the same one
    // called by a crowd is a drop nobody hardcoded.
    if (!stats.promoted) return;

    if (tx.selector && !stats.sampleCalldata.has(tx.selector)) {
      stats.sampleCalldata.set(tx.selector, tx.data);
      if (tx.raw) stats.sampleRaw.set(tx.selector, tx.raw);
    }

    // Only samples inside the velocity window can ever affect the decision, so
    // there is no reason to retain more than that.
    stats.samples.push({ at: now, free: classification.isFree });
    const cutoff = now - this.config.velocityWindowSec * 1000;
    if (stats.samples.length > 512) {
      stats.samples = stats.samples.filter((s) => s.at >= cutoff);
    }

    if (this.config.trackUniqueMinters && tx.raw) {
      this.enqueueRecovery(contract, tx.raw);
    }

    this.evaluate(stats, now);
  }

  /**
   * Queue a sender recovery. Bounded: under a burst we would rather lose some
   * unique-minter precision than build an unbounded backlog.
   */
  private enqueueRecovery(contract: Address, raw: Hex): void {
    if (this.recoveryQueue.length >= 256) {
      this.droppedRecoveries += 1;
      return;
    }
    this.recoveryQueue.push({ contract, raw });
    if (!this.recovering) void this.drainRecoveries();
  }

  private async drainRecoveries(): Promise<void> {
    this.recovering = true;
    try {
      while (this.recoveryQueue.length > 0) {
        const job = this.recoveryQueue.shift()!;
        try {
          // viem narrows this parameter to its typed-transaction union; feed
          // bytes are only known to be hex until parsed.
          const from = await recoverTransactionAddress({
            serializedTransaction: job.raw as Parameters<
              typeof recoverTransactionAddress
            >[0]['serializedTransaction'],
          });
          const stats = this.contracts.get(job.contract);
          if (stats) {
            stats.uniqueMinters.add(from.toLowerCase() as Address);
            // A newly distinct minter can be what tips a collection over the
            // threshold, so re-check rather than waiting for the next mint.
            this.evaluate(stats, Date.now());
          }
        } catch {
          // Unparseable signature; not worth failing the tracker over.
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  /** Count attempts inside the velocity window measured from first sighting. */
  private attemptsInWindow(stats: ContractStats, now: number): number {
    const windowMs = this.config.velocityWindowSec * 1000;
    // For a fresh contract this is "mints in the first N seconds". Once the
    // contract is older than the window, it becomes a rolling recent-rate,
    // which is the right generalization: a collection that heats up late is
    // still worth catching.
    const from = Math.max(stats.firstSeenAt, now - windowMs);
    return stats.samples.reduce((n, s) => (s.at >= from ? n + 1 : n), 0);
  }

  private evaluate(stats: ContractStats, now: number): void {
    if (stats.flagged) return;

    const ageSec = (now - stats.firstSeenAt) / 1000;
    if (ageSec > this.config.maxContractAgeSec) return;

    const isFree = stats.freeAttempts > stats.paidAttempts;
    if (this.config.freeOnly && !isFree) return;

    const attemptsInWindow = this.attemptsInWindow(stats, now);
    if (attemptsInWindow < this.config.minAttempts) return;

    if (
      this.config.minUniqueMinters > 0 &&
      stats.uniqueMinters.size < this.config.minUniqueMinters
    ) {
      return;
    }

    stats.flagged = true;

    const topSelector = [...stats.selectors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    const hot: HotCollection = {
      contract: stats.contract,
      attemptsInWindow,
      uniqueMinters: stats.uniqueMinters.size,
      ageSec,
      isFree,
      topSelector,
      sampleCalldata: topSelector ? stats.sampleCalldata.get(topSelector) : undefined,
      sampleRaw: topSelector ? stats.sampleRaw.get(topSelector) : undefined,
      // Average attached value across observed attempts. For a free mint this
      // is zero; for a paid one it is what real minters are actually paying.
      observedValueWei:
        stats.attempts > 0 ? stats.totalValueWei / BigInt(stats.attempts) : 0n,
      attempts: stats.attempts,
      firstSeenAt: stats.firstSeenAt,
    };

    log.info('HOT COLLECTION', {
      contract: hot.contract,
      attemptsInWindow: hot.attemptsInWindow,
      windowSec: this.config.velocityWindowSec,
      uniqueMinters: hot.uniqueMinters,
      ageSec: hot.ageSec.toFixed(1),
      free: hot.isFree,
      selector: hot.topSelector,
    });

    this.emit('hot', hot);
  }

  /** Evict cold contracts so a long-running tracker cannot grow without bound. */
  private evictIfNeeded(now: number): void {
    if (this.contracts.size <= this.config.maxContracts) return;

    const staleBefore = now - this.config.evictAfterSec * 1000;
    for (const [address, stats] of this.contracts) {
      if (stats.lastSeenAt < staleBefore) this.contracts.delete(address);
    }

    if (this.contracts.size > this.config.maxContracts) {
      // Still over budget: drop the least recently active.
      const sorted = [...this.contracts.entries()].sort(
        (a, b) => a[1].lastSeenAt - b[1].lastSeenAt,
      );
      const excess = this.contracts.size - this.config.maxContracts;
      for (let i = 0; i < excess; i++) this.contracts.delete(sorted[i][0]);
    }
  }

  get(contract: Address): ContractStats | undefined {
    return this.contracts.get(contract.toLowerCase() as Address);
  }

  size(): number {
    return this.contracts.size;
  }

  /** Ranked snapshot for the dashboard/API, hottest first. */
  snapshot(limit = 50, now = Date.now()): TrackedCollection[] {
    const rows: TrackedCollection[] = [];
    for (const stats of this.contracts.values()) {
      // Unpromoted contracts have no samples and no recovered senders, so a
      // row for one would be a line of zeroes pretending to be a candidate.
      if (!stats.promoted) continue;
      const ageSec = (now - stats.firstSeenAt) / 1000;
      const lastSeenSecAgo = (now - stats.lastSeenAt) / 1000;
      const attemptsInWindow = this.attemptsInWindow(stats, now);
      const topSelector = [...stats.selectors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

      rows.push({
        contract: stats.contract,
        firstSeenAt: stats.firstSeenAt,
        lastSeenAt: stats.lastSeenAt,
        ageSec: Number(ageSec.toFixed(1)),
        lastSeenSecAgo: Number(lastSeenSecAgo.toFixed(1)),
        status: activityStatus(lastSeenSecAgo),
        attempts: stats.attempts,
        freeAttempts: stats.freeAttempts,
        paidAttempts: stats.paidAttempts,
        uniqueMinters: stats.uniqueMinters.size,
        attemptsInWindow,
        attemptsPerMinute: Number((stats.attempts / Math.max(ageSec / 60, 1 / 60)).toFixed(1)),
        totalValueWei: stats.totalValueWei.toString(),
        observedValueWei: (stats.attempts > 0
          ? stats.totalValueWei / BigInt(stats.attempts)
          : 0n
        ).toString(),
        isFree: stats.freeAttempts > stats.paidAttempts,
        topSelector,
        sampleCalldata: topSelector ? stats.sampleCalldata.get(topSelector) : undefined,
        sampleRaw: topSelector ? stats.sampleRaw.get(topSelector) : undefined,
        mintVia: stats.mintVia,
        entrypoint: stats.knownSelector ? 'known' : 'observed',
        flagged: stats.flagged,
      });
    }
    rows.sort((a, b) => b.attemptsInWindow - a.attemptsInWindow || b.attempts - a.attempts);
    return rows.slice(0, limit);
  }

  stats(): Record<string, unknown> {
    let promoted = 0;
    for (const c of this.contracts.values()) if (c.promoted) promoted += 1;
    return {
      contractsTracked: promoted,
      contractsWatched: this.contracts.size - promoted,
      feedTxSeen: this.totalSeen,
      mintsSeen: this.totalMints,
      droppedSenderRecoveries: this.droppedRecoveries,
    };
  }
}
