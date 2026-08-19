/**
 * Rate limiting and single-flight locking.
 *
 * Two distinct protections, often confused:
 *
 *   - **Rate limiting** bounds how fast the spending endpoints can be driven,
 *     so a leaked token drains a wallet slowly enough to notice and revoke
 *     rather than in one burst.
 *   - **Single-flight locking** stops two cycles running at once. That is a
 *     correctness matter, not abuse: two concurrent hunts prime nonces from the
 *     same wallets independently and then broadcast conflicting transactions,
 *     so the second set is rejected as "nonce too low". A cron firing while the
 *     browser is already hunting hits exactly this.
 *
 * Both are per-process. On serverless each instance keeps its own counters, so
 * this is a meaningful speed bump rather than a distributed guarantee — the
 * hard bound on losses remains MAX_MINT_VALUE_ETH, which is enforced per run
 * and cannot be widened by any request.
 */

export interface RateLimitRule {
  /** Requests allowed in a burst. */
  capacity: number;
  /** Steady-state refill, in tokens per second. */
  refillPerSec: number;
}

/**
 * Defaults are chosen so ordinary use never notices.
 *
 * A hunt cycle takes ~35s, so 6/minute is already far more than back-to-back
 * hunting needs. Minting is bounded tighter because it is the direct spend.
 */
export const DEFAULT_LIMITS = {
  hunt: { capacity: 6, refillPerSec: 6 / 60 },
  mint: { capacity: 10, refillPerSec: 10 / 60 },
  read: { capacity: 60, refillPerSec: 1 },
  /**
   * Sign-up is the one route anyone can reach without a credential, and each
   * call generates ten keypairs and writes a row. Tight on purpose: nobody
   * legitimately needs a fourth account in an hour.
   */
  signup: { capacity: 3, refillPerSec: 3 / 3600 },
  /** Reading your own account is cheap, but it opens sealed keys. */
  account: { capacity: 30, refillPerSec: 0.5 },
} as const satisfies Record<string, RateLimitRule>;

export type LimitName = keyof typeof DEFAULT_LIMITS;

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next token is available, when denied. */
  retryAfterSec: number;
  remaining: number;
}

/**
 * Consume one token from a bucket, refilling it for elapsed time first.
 *
 * A token bucket rather than a fixed window: it allows a short burst (the UI
 * firing a couple of requests as a page loads) while still holding the average
 * down, and it has no window boundary for a caller to game.
 */
export function checkRateLimit(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: rule.capacity, lastRefill: now };
    buckets.set(key, bucket);
  }

  const elapsedSec = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(rule.capacity, bucket.tokens + elapsedSec * rule.refillPerSec);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfterSec: 0, remaining: Math.floor(bucket.tokens) };
  }

  const needed = 1 - bucket.tokens;
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil(needed / rule.refillPerSec)),
    remaining: 0,
  };
}

/** Clear all buckets and locks. For tests, and for a clean restart. */
export function resetRateLimits(): void {
  buckets.clear();
  locks.clear();
}

/**
 * Identify the caller for bucketing.
 *
 * Every authenticated request carries the same token, so keying on it would
 * lump all traffic together. The forwarded client address separates callers
 * where a proxy provides one, and falls back to a shared bucket otherwise —
 * which still bounds total throughput, the thing that actually protects the
 * wallet.
 */
export function clientKey(headers: Record<string, string | string[] | undefined>): string {
  // Platform-set headers first. Vercel writes x-real-ip and x-vercel-forwarded-for
  // itself and a client cannot forge them, whereas x-forwarded-for is merely
  // *appended* to and its leftmost entry is whatever the caller claimed.
  //
  // Worth being plain about the residual: behind no proxy at all — a bare
  // `npm run serve` — every one of these is client-supplied, so the limit
  // becomes a courtesy rather than a control. The hard bound on losses stays
  // MAX_MINT_VALUE_ETH, which no request can widen.
  for (const name of ['x-real-ip', 'x-vercel-forwarded-for', 'x-forwarded-for']) {
    const value = headers[name];
    const raw = Array.isArray(value) ? value[0] : value;
    const ip = raw?.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return 'shared';
}

const locks = new Set<string>();

/**
 * Run `fn` only if nothing else holds `name`, otherwise return `busy`.
 *
 * Deliberately non-blocking: a caller that waited would just queue up work that
 * is already stale by the time it runs, and on a serverless function it would
 * burn the invocation's whole time budget waiting.
 */
export async function withSingleFlight<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (locks.has(name)) return { ran: false };
  locks.add(name);
  try {
    return { ran: true, value: await fn() };
  } finally {
    locks.delete(name);
  }
}

export function isLocked(name: string): boolean {
  return locks.has(name);
}
