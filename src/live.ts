import { formatEther, type Address, type Hex } from 'viem';
import { loadHuntRuntime, loadTrackerConfig } from './config.js';
import { RpcClient } from './rpc.js';
import { collectSnapshot } from './snapshot.js';
import type { TrackedCollection } from './tracker.js';
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
  /** Whether this is a reason to act or a reason not to. */
  tone: Tone;
}

/**
 * Whether a number is encouraging, discouraging, or neither.
 *
 * Decided here rather than in the page so the judgement is in one place and can
 * be tested. A colour on a screen is an opinion, and opinions belong somewhere
 * they can be argued with.
 */
export type Tone = 'good' | 'bad' | 'neutral';

export interface LiveMetric {
  label: string;
  value: string;
  /**
   * The same number with the label folded in: `60w`, `×3`, `82%`.
   *
   * A one-line row on a phone has room for the figures or the words, not both,
   * and truncating mid-strip hides exactly the metrics at the end. These are
   * chosen to be self-describing without their label.
   */
  short: string;
  tone: Tone;
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
  /** The row's numbers, each with a verdict, ready to render. */
  metrics: LiveMetric[];
  /** Seconds since the last mint was seen. Drives "is this still moving". */
  lastSeenSecAgo: number;

  /** Enough to mint it from the board without another feed sample. */
  entrypoint?: Hex;
  sampleCalldata?: Hex;
  sampleRaw?: Hex;
  /** The shared drop contract mints go through, when they do not go direct. */
  mintVia?: string;
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
  /**
   * Where the rows came from: a persistent tracker, or a feed sampled inside
   * this request. Surfaced because the two are not the same age — an upstream
   * answer describes a window that host has been watching continuously, and a
   * sampled one describes the last few seconds only.
   */
  source: 'upstream' | 'feed';
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
  /**
   * Seconds spent listening to the feed.
   *
   * Billed as active CPU for every one of them — a serverless function waiting
   * on a WebSocket costs the same as one doing work. At twenty seconds, with
   * the page refreshing every twenty-four, this ran at a ~100% duty cycle for
   * as long as the tab was open. Six seconds refreshed every forty-five is
   * about a seventh of the cost and still shows what is happening.
   */
  windowSec: 6,
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
    // Too late is the plainest bad news there is.
    events.push({ kind: 'sold-out', text: 'Minted out', tone: 'bad' });
    if (m.ageSec > 0 && m.ageSec < 3600) {
      events.push({ kind: 'fast', text: `Gone in ${formatDuration(m.ageSec)}`, tone: 'neutral' });
    }
    return events;
  }

  if (m.projectedSelloutSec !== undefined && m.projectedSelloutSec <= 300 && m.status === 'live') {
    events.push({
      kind: 'minting-out',
      text: `Minting out — about ${formatDuration(m.projectedSelloutSec)} left`,
      tone: 'good',
    });
  }

  if (m.uniqueMinters >= 20 && m.ageSec > 0) {
    // The line the whole board exists for: "60 wallets in 2 minutes".
    events.push({
      kind: 'crowd',
      text: `${m.uniqueMinters} wallets in ${formatDuration(m.ageSec)}`,
      tone: 'good',
    });
  }

  if (m.mintsPerMinute >= 120) {
    events.push({
      kind: 'fast', text: `${Math.round(m.mintsPerMinute)} a minute`, tone: 'good',
    });
  }

  if (m.ageSec <= 120 && m.mints >= 10) {
    events.push({
      kind: 'fresh', text: `Just started — ${formatDuration(m.ageSec)} ago`, tone: 'good',
    });
  }

  if (events.length === 0) {
    events.push({ kind: 'steady', text: `${m.mints} minted so far`, tone: 'neutral' });
  }
  return events;
}

/**
 * The row's numbers, each with a verdict.
 *
 * The thresholds are the same ones the hunter's criteria use, so a row that
 * reads green here is a row the automatic side would look at twice. Deliberately
 * coarse: a colour is a glance, not a measurement.
 */
export function describeMetrics(m: LiveMint): LiveMetric[] {
  const price = m.isFree ? 'free' : `${trimEth(m.priceEth)} ETH`;

  const metrics: LiveMetric[] = [
    {
      label: 'speed',
      value: `${m.mintsPerMinute}/min`,
      short: `${compact(m.mintsPerMinute)}/min`,
      tone: m.mintsPerMinute >= 60 ? 'good' : m.mintsPerMinute < 10 ? 'bad' : 'neutral',
    },
    {
      label: 'wallets',
      // Few wallets behind many mints is one bot, not demand.
      value: String(m.uniqueMinters),
      short: `${compact(m.uniqueMinters)}w`,
      tone: m.uniqueMinters >= 25 ? 'good' : m.uniqueMinters < 5 ? 'bad' : 'neutral',
    },
    {
      label: 'price',
      value: price,
      short: m.isFree ? 'free' : `${trimEth(m.priceEth)}Ξ`,
      tone: m.isFree ? 'good' : 'neutral',
    },
  ];

  if (m.progressPct !== undefined) {
    metrics.push({
      label: 'minted',
      value: `${m.progressPct.toFixed(0)}% minted`,
      short: `${m.progressPct.toFixed(0)}%`,
      // Past ninety per cent you are racing for what is left and will mostly
      // pay gas to lose.
      tone: m.soldOut || m.progressPct >= 90 ? 'bad' : m.progressPct < 70 ? 'good' : 'neutral',
    });
  }

  if (m.maxPerWallet) {
    metrics.push({
      label: 'max each',
      value: `${m.maxPerWallet} each`,
      short: `×${m.maxPerWallet}`,
      tone: Number(m.maxPerWallet) > 1 ? 'good' : 'neutral',
    });
  }

  if (m.projectedSelloutSec !== undefined && !m.soldOut) {
    const left = formatDuration(m.projectedSelloutSec);
    metrics.push({
      label: 'gone in',
      value: `gone in ${left}`,
      // Words rather than a symbol: a glyph that does not exist in the reader's
      // font renders as a stray letter, and "34s" alone is indistinguishable
      // from the idle time two metrics along.
      short: `~${left} left`,
      tone: m.projectedSelloutSec <= 900 ? 'good' : 'neutral',
    });
  }

  if (m.phase) {
    metrics.push({
      label: 'round',
      value: `${m.phase} round`,
      short: m.phase === 'allowlist' ? 'allowlist' : m.phase,
      // An allowlist round is a closed door unless you are on the list.
      tone: m.phase === 'public' ? 'good' : 'bad',
    });
  }

  const idle = Math.round(m.lastSeenSecAgo);
  metrics.push({
    label: 'last mint',
    value: idle <= 1 ? 'minting now' : `last mint ${idle}s ago`,
    short: idle <= 1 ? 'minting now' : `${idle}s idle`,
    tone: m.lastSeenSecAgo <= 15 ? 'good' : m.lastSeenSecAgo > 90 ? 'bad' : 'neutral',
  });

  return metrics;
}

/** 1200 → 1.2k, so a busy number does not push the row wider than the screen. */
function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 0.005000000000000000 → 0.005. */
function trimEth(eth: string): string {
  return eth.includes('.') ? eth.replace(/0+$/, '').replace(/\.$/, '') : eth;
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
  source: 'upstream' | 'feed' = 'feed',
): string {
  // The two sources describe different spans of time, and saying "watched 6s"
  // about a host that has been listening for a week would be wrong in the
  // direction that makes an empty board look like a broken one.
  if (excluded.seen === 0) {
    return source === 'upstream'
      ? 'The tracker is watching continuously and has seen no contracts being called at all.'
      : `Watched ${windowSec}s and saw no contracts being called at all.`;
  }

  const watched =
    source === 'upstream' ? 'From the tracker, watching continuously.' : `Watched ${windowSec}s.`;
  const parts = [`${watched} ${excluded.seen} contract(s) seen, ${shown} shown.`];
  const held: string[] = [];
  if (excluded.belowFloor > 0) held.push(`${excluded.belowFloor} under the mint floor`);
  if (excluded.notNft > 0) held.push(`${excluded.notNft} not NFT contracts`);
  if (excluded.unreadable > 0) held.push(`${excluded.unreadable} unreadable`);
  if (excluded.notInspected > 0) held.push(`${excluded.notInspected} past the read budget`);
  if (held.length > 0) parts.push(`Held back: ${held.join(', ')}.`);
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

  const row: LiveMint = {
    contract: c.contract,
    name: info?.name,
    symbol: info?.symbol,
    imageUrl: info?.preview?.imageUrl,
    ageSec: c.ageSec,
    lastSeenSecAgo: c.lastSeenSecAgo,
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
    metrics: [],
    entrypoint: c.topSelector,
    sampleCalldata: c.sampleCalldata,
    sampleRaw: c.sampleRaw,
    mintVia: c.mintVia,
  };

  // Needs the finished row, so it is filled in rather than passed in.
  row.metrics = describeMetrics(row);
  return row;
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

  // A persistent tracker answers this in one request; without one, the feed is
  // held open here for the window. src/snapshot.ts has the cost argument.
  const sampled = await collectSnapshot(
    {
      windowSec: opts.windowSec,
      limit: 200,
      tracker: {
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
        // that never gets promoted never appears at all, and this page is
        // supposed to show what is happening rather than decide what is worth
        // happening.
        promoteAfter: 3,
      },
    },
    env,
  );

  const feedConnected = sampled.feedConnected;
  const observed = sampled.observed;
  const all = sampled.collections;
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
      const row = toLiveMint(shortlist[i], info);

      // A board of collections has to be collections. Anything that cannot show
      // positive evidence of being one — an ERC-165 answer, or a token URI, or a
      // name and a supply — is counted and left off.
      //
      // Being permissive here is what put a shared drop contract on the board
      // with three thousand mints a minute and no NFT interface. Attributing
      // those mints to the collection they were for is the fix; showing the
      // proxy itself never was.
      if (row.kind === 'unverified') {
        if (info) excluded.notNft += 1;
        else excluded.unreadable += 1;
        continue;
      }

      mints.push(row);
    }
  } finally {
    for (const c of clients) c.destroy();
  }

  // Newest at the top.
  //
  // A drop is worth knowing about while there is still supply left, so the
  // thing that should catch the eye is the one that just started — not the one
  // that has been grinding for an hour. Anything finished sinks, and anything
  // that has gone quiet sinks behind what is still moving, so the top of the
  // list is always somewhere worth looking.
  mints.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut ? 1 : -1;
    const aLive = a.status === 'live' ? 0 : 1;
    const bLive = b.status === 'live' ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    // Youngest drop first; ties broken by whichever is minting harder.
    if (a.ageSec !== b.ageSec) return a.ageSec - b.ageSec;
    return b.mintsPerMinute - a.mintsPerMinute;
  });

  return {
    startedAt,
    // Zero when a tracker answered: no seconds were spent sampling here, which
    // is the entire reason for pointing at one.
    sampledSeconds: sampled.source === 'upstream' ? 0 : opts.windowSec,
    feedConnected,
    observed,
    minMints: opts.minMints,
    excluded,
    mints,
    source: sampled.source,
    note: feedConnected
      ? describeBoard(opts.windowSec, mints.length, excluded, sampled.source)
      : 'Could not reach the sequencer feed, so nothing could be observed.',
  };
}
