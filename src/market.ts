import { log } from './logger.js';

/**
 * What a free mint turned out to be worth.
 *
 * The reason this exists: a hunt that skips a collection is a decision, and
 * without a price attached there is no way to tell a good skip from a costly
 * one. "Missed on unique minters" reads the same whether the collection later
 * floored at 0.002 or at 2 ETH — but only one of those means the threshold is
 * wrong. Attaching the floor turns the close list from a log into feedback.
 *
 * There is no marketplace API baked in, on purpose. Hardcoding one would mean
 * shipping a URL that has not been verified against this chain, and a made-up
 * price is worse than an absent one — it would be acted on. So the source is
 * configured, the response shapes of the common marketplace APIs are accepted,
 * and with nothing configured every price reads as unknown rather than zero.
 *
 * Configure with:
 *   MARKET_API_URL    a URL template containing {contract}, e.g.
 *                     https://api.example.com/v1/collections/{contract}
 *   MARKET_API_TOKEN  optional, sent as a bearer token
 *   MARKET_CURRENCY   label for the returned figure (default ETH)
 */

export interface FloorPrice {
  /** Floor in the chain's native unit, as a decimal string. */
  floor: string;
  currency: string;
  checkedAt: string;
  source: string;
}

/** How long a looked-up floor is trusted before it is fetched again. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { value: FloorPrice | null; at: number }>();

export function marketConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MARKET_API_URL?.trim());
}

/**
 * Pull a number out of whichever shape the configured API returns.
 *
 * The marketplaces that matter all express a floor differently, and requiring
 * one exact shape would mean this only works with a single provider. These are
 * the four common ones; anything else reports unknown rather than guessing at
 * a field.
 */
export function extractFloor(body: unknown): string | undefined {
  const seen = new Set<unknown>();

  /**
   * The first usable number under a node.
   *
   * Reservoir nests the figure three levels below the key that names it
   * (floorAsk.price.amount.native), so finding the key is only half the job.
   */
  const firstNumber = (node: unknown, depth: number): string | undefined => {
    if (typeof node === 'number') return Number.isFinite(node) ? String(node) : undefined;
    if (typeof node === 'string') {
      const text = node.trim();
      return text !== '' && Number.isFinite(Number(text)) ? text : undefined;
    }
    if (depth > 5 || node === null || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);

    // Preferred field names first, so a node carrying both a native amount and
    // a USD one yields the native figure.
    const obj = node as Record<string, unknown>;
    for (const key of ['native', 'decimal', 'amount', 'value', 'price']) {
      if (key in obj) {
        const found = firstNumber(obj[key], depth + 1);
        if (found !== undefined) return found;
      }
    }
    for (const value of Object.values(obj)) {
      const found = firstNumber(value, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const findFloor = (node: unknown, depth: number): string | undefined => {
    if (depth > 6 || node === null || typeof node !== 'object' || seen.has(node)) return undefined;
    seen.add(node);
    const obj = node as Record<string, unknown>;

    for (const [key, value] of Object.entries(obj)) {
      if (/^floor/i.test(key) || /^floor_/i.test(key)) {
        const found = firstNumber(value, depth + 1);
        if (found !== undefined) return found;
      }
    }
    // Not at this level; the marketplaces wrap it in data/stats/collection.
    for (const value of Object.values(obj)) {
      const found = findFloor(value, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return findFloor(body, 0);
}

/**
 * Look up one collection's floor.
 *
 * Never throws: an unreachable or unconfigured marketplace is missing
 * information, not a failure — the history has to render either way.
 */
export async function fetchFloor(
  contract: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FloorPrice | undefined> {
  const template = env.MARKET_API_URL?.trim();
  if (!template) return undefined;
  // Interpolated into a URL, so it has to be an address and nothing else.
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) return undefined;

  const cached = cache.get(contract.toLowerCase());
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? undefined;
  }

  const url = template.includes('{contract}')
    ? template.replace('{contract}', contract)
    : `${template.replace(/\/$/, '')}/${contract}`;

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = env.MARKET_API_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const floor = extractFloor(await res.json());
    if (floor === undefined) {
      // Remember the miss too, so an API that never carries a floor is not
      // re-queried for every row on every page load.
      cache.set(contract.toLowerCase(), { value: null, at: Date.now() });
      return undefined;
    }

    const value: FloorPrice = {
      floor,
      currency: env.MARKET_CURRENCY?.trim() || 'ETH',
      checkedAt: new Date().toISOString(),
      source: new URL(url).hostname,
    };
    cache.set(contract.toLowerCase(), { value, at: Date.now() });
    return value;
  } catch (err) {
    log.debug('floor lookup failed', {
      contract,
      error: err instanceof Error ? err.message : String(err),
    });
    cache.set(contract.toLowerCase(), { value: null, at: Date.now() });
    return undefined;
  }
}

/**
 * What skipping this one cost.
 *
 * Multiplied by the wallets that would have minted, because that is the actual
 * counterfactual: ten funded wallets against a one-per-wallet mint is ten
 * tokens, not one.
 */
export function missedValue(floor: string, wallets: number): string {
  const each = Number(floor);
  if (!Number.isFinite(each) || each <= 0 || wallets <= 0) return '0';
  const total = each * wallets;
  // Trimmed rather than fixed-width: 0.05 should not render as 0.050000.
  return total.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** Drop the cache. For tests, and after changing the configured source. */
export function resetMarketCache(): void {
  cache.clear();
}
