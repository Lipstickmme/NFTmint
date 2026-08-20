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
 * The one filter that matters is volume since the drop began. A contract with
 * four mints is not a drop; it is somebody testing. Everything past that
 * threshold is shown, sold out included, because "it went in ninety seconds"
 * is information even after the fact.
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
  // Below this it is not a drop, it is somebody testing their own contract.
  minMints: 12,
  inspectTop: 12,
  withArt: true,
};

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

  const shortlist = tracker
    .snapshot(100)
    .filter((c) => c.attempts >= opts.minMints)
    .slice(0, opts.inspectTop);

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
      // Same gate the hunter uses: on the feed a busy router is shaped exactly
      // like a hot drop, and only the contract can tell them apart.
      if (!info || info.isNft === false || (info.isNft === undefined && !info.looksLikeNft)) {
        continue;
      }
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
    mints,
    note: feedConnected
      ? `Watched ${opts.windowSec}s. ${mints.length} collection(s) minting with at least ` +
        `${opts.minMints} mints since they started.`
      : 'Could not reach the sequencer feed, so nothing could be observed.',
  };
}
