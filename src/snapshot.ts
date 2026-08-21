import { MintTracker, type TrackerConfig, type TrackedCollection } from './tracker.js';
import { FeedConsumer } from './feed.js';
import { loadProxyConfig, proxyRequest, ProxyConfigError } from './proxy.js';
import { log } from './logger.js';

/**
 * "What is minting right now" — from a tracker that is already listening, or
 * by listening here.
 *
 * Both the hunter and the live board start the same way: open the sequencer
 * feed, hold it for a window, rank what came through. On a machine that stays
 * on, that is free — the connection is open anyway. Inside a serverless
 * function it is the single most expensive thing the app does, because a
 * function awaiting a socket is billed for every second it waits. Sampling for
 * 15 seconds every 45 is a third of the wall clock, per user, forever.
 *
 * So when TRACKER_UPSTREAM_URL points at a host running `nftmint serve`, that
 * host has already done the listening and this becomes one HTTP request. The
 * callers do not change: they get the same ranked rows either way.
 *
 * When upstream is configured and unreachable, this fails rather than quietly
 * falling back to sampling. Falling back would be friendlier right up until it
 * restored the exact bill the upstream host was set up to remove — and it would
 * do it silently, at the worst moment, on every request. Set
 * TRACKER_UPSTREAM_FALLBACK=true to choose the other trade.
 */

export interface SnapshotRequest {
  /** How long to hold the feed when sampling locally. Ignored upstream. */
  windowSec: number;
  /** Rows wanted, before the caller's own filtering. */
  limit: number;
  /** Tracker settings for local sampling. Upstream uses its own. */
  tracker: Partial<TrackerConfig>;
  /** Ask upstream for free mints only. Local sampling uses tracker.freeOnly. */
  freeOnly?: boolean;
}

export interface Snapshot {
  collections: TrackedCollection[];
  observed: {
    feedTxSeen: number;
    mintsSeen: number;
    contractsTracked: number;
  };
  /** Whether the feed was reachable. Always true for an upstream answer. */
  feedConnected: boolean;
  source: 'upstream' | 'feed';
  /** Present on an upstream answer, so a report can say where data came from. */
  upstream?: {
    url: string;
    generatedAt?: string;
    /** The upstream tracker's own window, which is not necessarily this one. */
    velocityWindowSec?: number;
  };
  /** Set when upstream was configured, failed, and fallback was allowed. */
  upstreamError?: string;
}

/** Shape of GET /api/collections on a host running `nftmint serve`. */
interface UpstreamBody {
  generatedAt?: string;
  config?: { velocityWindowSec?: number };
  stats?: Record<string, unknown>;
  collections?: TrackedCollection[];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Is a persistent tracker configured? Cheap enough to ask on every call. */
export function upstreamConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TRACKER_UPSTREAM_URL?.trim());
}

function fallbackAllowed(env: NodeJS.ProcessEnv): boolean {
  return env.TRACKER_UPSTREAM_FALLBACK?.trim().toLowerCase() === 'true';
}

async function fromUpstream(req: SnapshotRequest, env: NodeJS.ProcessEnv): Promise<Snapshot> {
  const config = loadProxyConfig(env);
  const search = `?limit=${req.limit}${req.freeOnly ? '&free=true' : ''}`;
  const { status, body } = await proxyRequest(config, '/api/collections', search);

  if (status >= 400) {
    const detail =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`;
    throw new Error(detail);
  }

  const parsed = (body ?? {}) as UpstreamBody;
  if (!Array.isArray(parsed.collections)) {
    throw new Error('upstream did not return a collections array');
  }

  const stats = parsed.stats ?? {};
  return {
    collections: parsed.collections,
    observed: {
      feedTxSeen: num(stats.feedTxSeen),
      mintsSeen: num(stats.mintsSeen),
      contractsTracked: num(stats.contractsTracked),
    },
    feedConnected: true,
    source: 'upstream',
    upstream: {
      url: config.upstreamUrl,
      generatedAt: parsed.generatedAt,
      velocityWindowSec: parsed.config?.velocityWindowSec,
    },
  };
}

async function fromFeed(req: SnapshotRequest, env: NodeJS.ProcessEnv): Promise<Snapshot> {
  const { loadTrackerConfig } = await import('./config.js');
  const feedUrl = loadTrackerConfig(env).feedUrl;

  const tracker = new MintTracker(req.tracker);
  const feed = new FeedConsumer({ url: feedUrl });
  let feedConnected = false;

  feed.on('open', () => {
    feedConnected = true;
  });
  feed.on('error', () => {
    /* the consumer logs and reconnects; sampling continues */
  });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  feed.start();

  try {
    await new Promise((r) => setTimeout(r, req.windowSec * 1000));
  } finally {
    // In a finally so an aborted request does not leave the socket open. A leaked
    // feed in a serverless function keeps being billed after the response is sent.
    feed.stop();
  }

  return {
    collections: tracker.snapshot(req.limit),
    observed: {
      feedTxSeen: tracker.totalSeen,
      mintsSeen: tracker.totalMints,
      contractsTracked: tracker.size(),
    },
    feedConnected,
    source: 'feed',
  };
}

export async function collectSnapshot(
  req: SnapshotRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Snapshot> {
  if (!upstreamConfigured(env)) return fromFeed(req, env);

  try {
    return await fromUpstream(req, env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    // A misconfigured URL is worth failing on either way: falling back would
    // hide a typo behind a bill.
    if (err instanceof ProxyConfigError) throw err;

    if (!fallbackAllowed(env)) {
      throw new Error(
        `The tracker at ${env.TRACKER_UPSTREAM_URL?.trim()} is not answering (${reason}). ` +
          'Check that it is running and that TRACKER_UPSTREAM_TOKEN matches its ' +
          'TRACKER_AUTH_TOKEN. To sample the feed here instead while it is down — which ' +
          'costs serverless CPU for every second of every request — set ' +
          'TRACKER_UPSTREAM_FALLBACK=true.',
      );
    }

    log.warn('tracker upstream unreachable, sampling locally', { reason });
    return { ...(await fromFeed(req, env)), upstreamError: reason };
  }
}
