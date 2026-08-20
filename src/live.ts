import { formatEther, type Address, type Hex } from 'viem';
import { loadHuntRuntime, loadTrackerConfig } from './config.js';
import { RpcClient } from './rpc.js';
import { FeedConsumer } from './feed.js';
import { MintTracker, type TrackedCollection } from './tracker.js';
import { parseExtraSelectors } from './mintdetect.js';
import { inspectContract, type ContractInfo } from './inspect.js';
import { projectSelloutSec, formatDuration } from './criteria.js';
import { errorMessage } from './http.js';
import { log } from './logger.js';

/**
 * What is minting right now.
 *
 * A different question from the hunter's. The hunter asks "should I buy this",
 * applies seven rules, and mostly answers no — which is correct for spending
 * money automatically and useless as a view of the chain. This asks only "is
 * this a real drop, and is it happening", and then reports everything known
 * about it so a person can decide for themselves.
 *
 * The bias is deliberately toward showing things. This is a window on the
 * chain, not a shortlist — a person can dismiss a row in a second, but cannot
 * see one that was filtered away. So the volume floor is low, contracts that
 * cannot be identified are shown and labelled rather than dropped, and sold-out
 * collections stay because "it went in ninety seconds" is information after the
 * fact.
 *
 * Only one thing is removed outright: a contract that answers, directly, that
 * it is not an NFT. Those are swap routers and tokens, and they are not a
 * judgement call.
 *
 * When rows do get held back, the board says how many and why. "Loosen the
 * filter" is not an explanation; "38 seen, 31 below the floor, 4 not NFT
 * contracts, 3 shown" is.
 */

export interface LiveEvent {
  /** Machine tag, so the UI can pick an animation. */
  kind: 'minting-out' | 'sold-out' | 'fast' | 'crowd' | 'fresh' | 'steady';
  /** The same thing in words: "60 wallets in 2 minutes". */
  text: string;
}

export interface LiveMint {
  contract: string;
  name?: string;
  symbol?: string;
  imageUrl?: string;

  /** Seconds since the first mint was seen on the feed. */
  ageSec: number;
  status: 'live' | 'slowing' | 'quiet';

  mints: number;
  mintsPerMinute: number;
  uniqueMinters: number;
  mintsInWindow: number;

  totalSupply?: string;
  maxSupply?: string;
  /** Percent of max supply minted, when both are readable. */
  progressPct?: number;
  remaining?: string;
  soldOut: boolean;

  /** Mint price in wei, as a decimal string. '0' for a free mint. */
  priceWei: string;
  priceEth: string;
  isFree: boolean;

  /** Which round the contract says is running. */
  phase?: 'public' | 'allowlist' | 'closed';
  maxPerWallet?: string;

  /**
   * How sure we are this is a collection.
   *
   *   'confirmed'  — ERC-165 says ERC-721 or ERC-1155.
   *   'likely'     — no ERC-165, but it has the shape: a token URI, or a name
   *                  and a supply.
   *   'unverified' — nothing readable either way. Shown and labelled rather
   *                  than hidden, because hiding it is a judgement the reader
   *                  should get to make.
   */
  kind: 'confirmed' | 'likely' | 'unverified';

  projectedSelloutSec?: number;
  /** Headline events, most interesting first. */
  events: LiveEvent[];

  /** Enough to mint it from the board without another feed sample. */
  entrypoint?: Hex;
  sampleCalldata?: Hex;
  sampleRaw?: Hex;
}

export interface LiveBoard {
  startedAt: string;
  sampledSeconds: number;
  feedConnected: boolean;
  observed: { feedTxSeen: number; mintsSeen: number; contractsTracked: number };
  /** The volume floor that was applied. */
  minMints: number;
  /** What was held back, and why. Shown instead of "loosen the filter". */
  excluded: LiveExclusions;
  mints: LiveMint[];
  note: string;
}

export interface LiveOptions {
  /** Seconds to sample the feed. */
  windowSec: number;
  /** Mints a contract needs since it started before it is worth showing. */
  minMints: number;
  /** How many to spend contract reads on. */
  inspectTop: number;
  /** Include artwork. Costs a metadata fetch per collection. */
  withArt: boolean;
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = {
  windowSec: 20,
  /**
   * Low on purpose.
   *
   * A high floor turns a window on the chain into a shortlist, and the whole
   * point of this page is that the judgement belongs to the person reading it.
   * Three is enough to exclude a single stray call without excluding a drop
   * that is only ten seconds old.
   */
  minMints: 3,
  // Every row costs a handful of contract reads, run in parallel. Two dozen
  // fits comfortably inside the request budget.
  inspectTop: 24,
  withArt: true,
};

/** Why a contract that was seen minting did not make it onto the board. */
export interface LiveExclusions {
  /** Contracts observed in the window, before any filtering. */
  seen: number;
  /** Fewer mints than the floor asked for. */
  belowFloor: number;
  /** Answered that they are not an ERC-721 or ERC-1155. */
  notNft: number;
  /** Beyond the inspection budget for this request. */
  notInspected: number;
  /** The contract read failed, so nothing could be said about them. */
  unreadable: number;
}

/**
 * Turn the numbers into the one or two things worth saying out loud.
 *
 * Ordered by how much they should pull the eye: a collection about to sell out
 * beats a fast one, which beats a crowded one. The UI animates on `kind`, so
 * this decides what moves on screen.
 */
export function describeEvents(m: {
  soldOut: boolean;
  progressPct?: number;
  projectedSelloutSec?: number;
  uniqueMinters: number;
  ageSec: number;
  mintsPerMinute: number;
  mints: number;
  status: string;
}): LiveEvent[] {
  const events: LiveEvent[] = [];

  if (m.soldOut) {
    events.push({ kind: 'sold-out', text: 'Minted out' });
    // Nothing else matters once it is gone, except how fast it went.
    if (m.ageSec > 0 && m.ageSec < 3600) {
      events.push({ kind: 'fast', text: `Gone in ${formatDuration(m.ageSec)}` });
    }
    return events;
  }

  if (m.projectedSelloutSec !== undefined && m.projectedSelloutSec <= 300 && m.status === 'live') {
    events.push({
      kind: 'minting-out',
      text: `Minting out — about ${formatDuration(m.projectedSelloutSec)} left`,
    });
  }

  if (m.uniqueMinters >= 20 && m.ageSec > 0) {
    // The line the whole board exists for: "60 wallets in 2 minutes".
    events.push({
      kind: 'crowd',
      text: `${m.uniqueMinters} wallets in ${formatDuration(m.ageSec)}`,
    });
  }

  if (m.mintsPerMinute >= 120) {
    events.push({ kind: 'fast', text: `${Math.round(m.mintsPerMinute)} a minute` });
  }

  if (m.ageSec <= 120 && m.mints >= 10) {
    events.push({ kind: 'fresh', text: `Just started — ${formatDuration(m.ageSec)} ago` });
  }

  if (events.length === 0) {
    events.push({ kind: 'steady', text: `${m.mints} minted so far` });
  }
  return events;
}

/**
 * Account for every contract the window saw.
 *
 * The version of this that just said "0 collections, loosen the filter" was
 * useless twice over: it did not say what had been dropped, and it blamed the
 * reader's settings for what was usually something else entirely.
 */
export function describeBoard(
  windowSec: number,
  shown: number,
  excluded: LiveExclusions,
): string {
  if (excluded.seen === 0) {
    return `Watched ${windowSec}s and saw no contracts being called at all.`;
  }

  const parts = [`Watched ${windowSec}s. ${excluded.seen} contract(s) seen, ${shown} shown.`];
  const held: string[] = [];
  if (excluded.belowFloor > 0) held.push(`${excluded.belowFloor} under the mint floor`);
  if (excluded.notNft > 0) held.push(`${excluded.notNft} not NFT contracts`);
  if (excluded.notInspected > 0) held.push(`${excluded.notInspected} past the read budget`);
  if (held.length > 0) parts.push(`Held back: ${held.join(', ')}.`);
  if (excluded.unreadable > 0) {
    parts.push(`${excluded.unreadable} could not be read and are shown unverified.`);
  }
  return parts.join(' ');
}

/** Build one board row from a tracked collection plus its contract reads. */
export function toLiveMint(c: TrackedCollection, info?: ContractInfo): LiveMint {
  // The contract's own price is authoritative; what the feed saw people paying
  // is the fallback, and for a free mint the two agree at zero.
  const priceWei = info?.priceWei ? BigInt(info.priceWei.value) : BigInt(c.observedValueWei);
  const remaining = info?.remaining;
  const projectedSelloutSec =
    remaining !== undefined ? projectSelloutSec(BigInt(remaining), c.attemptsPerMinute) : undefined;

  const base = {
    soldOut: info?.soldOut === true,
    progressPct: info?.progressPct,
    projectedSelloutSec,
    uniqueMinters: c.uniqueMinters,
    ageSec: c.ageSec,
    mintsPerMinute: c.attemptsPerMinute,
    mints: c.attempts,
    status: c.status,
  };

  return {
    contract: c.contract,
    name: info?.name,
    symbol: info?.symbol,
    imageUrl: info?.preview?.imageUrl,
    ageSec: c.ageSec,
    status: c.status,
    mints: c.attempts,
    mintsPerMinute: c.attemptsPerMinute,
    uniqueMinters: c.uniqueMinters,
    mintsInWindow: c.attemptsInWindow,
    totalSupply: info?.totalSupply?.value,
    maxSupply: info?.maxSupply?.value,
    progressPct: info?.progressPct,
    remaining,
    soldOut: info?.soldOut === true,
    priceWei: priceWei.toString(),
    priceEth: formatEther(priceWei),
    isFree: priceWei === 0n,
    phase: info?.phase,
    maxPerWallet: info?.maxPerWallet?.value,
    kind:
      info?.isNft === true ? 'confirmed' : info?.looksLikeNft ? 'likely' : 'unverified',
    projectedSelloutSec,
    events: describeEvents(base),
    entrypoint: c.topSelector,
    sampleCalldata: c.sampleCalldata,
    sampleRaw: c.sampleRaw,
  };
}

/**
 * Sample the feed and describe everything minting.
 *
 * Deliberately reads no wallet and signs nothing — this runs for anyone
 * looking at the board, including someone who has not funded anything yet.
 */
export async function runLiveBoard(
  options: Partial<LiveOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
  rpcUrls?: string[],
): Promise<LiveBoard> {
  const opts = { ...DEFAULT_LIVE_OPTIONS, ...options };
  const startedAt = new Date().toISOString();
  const trackerCfg = loadTrackerConfig(env);

  const tracker = new MintTracker({
    velocityWindowSec: trackerCfg.velocityWindowSec,
    minAttempts: trackerCfg.minAttempts,
    minUniqueMinters: 0,
    maxContractAgeSec: trackerCfg.maxContractAgeSec,
    // The board shows paid drops too; that is the point of a price column.
    freeOnly: false,
    trackUniqueMinters: true,
    maxContracts: trackerCfg.maxContracts,
    evictAfterSec: trackerCfg.evictAfterSec,
    extraSelectors: parseExtraSelectors(trackerCfg.extraSelectorsRaw),
    // Lower than the hunter's, for the same reason the floor is: a contract
    // that never gets promoted never appears at all, and this page is supposed
    // to show what is happening rather than decide what is worth happening.
    promoteAfter: 3,
  });

  const feed = new FeedConsumer({ url: trackerCfg.feedUrl });
  let feedConnected = false;
  feed.on('open', () => {
    feedConnected = true;
  });
  feed.on('error', () => {
    /* the consumer logs and reconnects; sampling continues */
  });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  feed.start();

  await new Promise((r) => setTimeout(r, opts.windowSec * 1000));
  feed.stop();

  const observed = {
    feedTxSeen: tracker.totalSeen,
    mintsSeen: tracker.totalMints,
    contractsTracked: tracker.size(),
  };

  const all = tracker.snapshot(200);
  const passedFloor = all.filter((c) => c.attempts >= opts.minMints);
  const shortlist = passedFloor.slice(0, opts.inspectTop);

  const excluded: LiveExclusions = {
    seen: all.length,
    belowFloor: all.length - passedFloor.length,
    notNft: 0,
    notInspected: passedFloor.length - shortlist.length,
    unreadable: 0,
  };

  // Reads only — no keys needed, so the board works before anyone signs up.
  const config = loadHuntRuntime(env, false);
  const clients = (rpcUrls ?? config.rpcUrls).map((u) => new RpcClient(u, { maxSockets: 16 }));
  const primary = clients[0];

  const mints: LiveMint[] = [];
  try {
    // Inspected together rather than in series: a dozen collections at four
    // round trips each is most of the request if done one at a time.
    const inspected = await Promise.all(
      shortlist.map(async (c) => {
        try {
          return await inspectContract(primary, c.contract as Address, undefined, opts.withArt);
        } catch (err) {
          log.debug('live inspect failed', { contract: c.contract, error: errorMessage(err) });
          return undefined;
        }
      }),
    );

    for (let i = 0; i < shortlist.length; i += 1) {
      const info = inspected[i];

      // The only thing removed outright: a contract that says, directly, that
      // it is not a collection. Swap routers and tokens land here, and that is
      // not a judgement call.
      if (info?.isNft === false) {
        excluded.notNft += 1;
        continue;
      }

      // A failed read is not evidence of anything. It gets a row marked
      // 'unverified' rather than disappearing, and is counted so the board can
      // say how much it could not see.
      if (!info) excluded.unreadable += 1;

      mints.push(toLiveMint(shortlist[i], info));
    }
  } finally {
    for (const c of clients) c.destroy();
  }

  // Still minting first, then by how close to gone.
  mints.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut ? 1 : -1;
    const aOut = a.projectedSelloutSec ?? Number.MAX_SAFE_INTEGER;
    const bOut = b.projectedSelloutSec ?? Number.MAX_SAFE_INTEGER;
    if (aOut !== bOut) return aOut - bOut;
    return b.mintsPerMinute - a.mintsPerMinute;
  });

  return {
    startedAt,
    sampledSeconds: opts.windowSec,
    feedConnected,
    observed,
    minMints: opts.minMints,
    excluded,
    mints,
    note: feedConnected
      ? describeBoard(opts.windowSec, mints.length, excluded)
      : 'Could not reach the sequencer feed, so nothing could be observed.',
  };
}
