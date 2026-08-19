import { CLOSE_SCORE } from '../src/criteria.js';
import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { getStore } from '../src/store.js';
import { authenticateAccount } from '../src/accountstore.js';
import { fetchFloor, marketConfigured, missedValue } from '../src/market.js';
import { WALLETS_PER_ACCOUNT } from '../src/accounts.js';
import type { Finding } from '../src/findings.js';
import type { FindingStore } from '../src/store.js';

/**
 * GET /api/findings — collections the hunter kept, newest first.
 * DELETE /api/findings — clear the history.
 *
 * The hunt report itself only describes the round that just ran, so anything
 * found ten minutes ago is gone from the UI the moment the next round lands.
 * This is the durable half: passers and near misses survive rounds, restarts,
 * and page reloads, which is what makes "did it ever see anything good?"
 * answerable after the fact.
 *
 * Authenticated either by an account's own credentials — in which case it sees
 * only that account's history — or by the operator's API_TOKEN, which sees the
 * deployment's own. What the chain was doing is shared, but the outcome of a
 * mint is not: it names the wallets that tried and the transactions that
 * landed, and those belong to whoever made them.
 *
 * Query parameters:
 *   filter   — `passed` (qualified on every rule), `close` (scored at or above
 *              the cut but did not qualify), or `all` (default)
 *   minScore — the cut for `close`, 0..99 (default 70)
 *   limit    — how many rows to return, 1..200 (default 100)
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const accountId = header(req, 'x-account-id');
  const accountToken = header(req, 'x-account-token');
  const asAccount = Boolean(accountId && accountToken);

  await handleApi(req, res, {
    methods: ['GET', 'DELETE'],
    // An account authenticates with its own credentials below; the operator
    // path still goes through the shared API_TOKEN check.
    publicRoute: asAccount,
    limit: 'read',
  }, async (_body, query) => {
    const namespace = asAccount
      ? (await authenticateAccount(accountId, accountToken)).id
      : undefined;
    const store = getStore(process.env, namespace);

    if ((req.method ?? 'GET').toUpperCase() === 'DELETE') {
      await store.clear();
      return { cleared: true, storage: store.kind };
    }

    const limit = clamp(Number.parseInt(query.get('limit') ?? '', 10), 1, 200, 100);
    const minScore = clamp(
      Number.parseInt(query.get('minScore') ?? '', 10), 0, 99, CLOSE_SCORE,
    );
    const filter = query.get('filter') ?? 'all';

    const all = await store.list(limit);
    // Counts describe the whole history, not the filtered slice, so the tab
    // labels stay still when you switch between them.
    const passed = all.filter((r) => r.passed);
    const close = all.filter((r) => !r.passed && (r.score ?? 0) >= minScore);

    const rows =
      filter === 'passed' ? passed : filter === 'close' ? close : all;

    // Prices are looked up here rather than during a round: a hunt cycle has a
    // hard time budget and every millisecond spent on a marketplace call is a
    // millisecond not spent racing. Reading the list has no such deadline.
    const priced = await priceMissedMints(store, rows);

    return {
      storage: store.kind,
      // Named so the UI can say plainly whether history outlives the process.
      durable: store.kind !== 'memory',
      minScore,
      marketConfigured: marketConfigured(),
      count: priced.length,
      passed: passed.length,
      close: close.length,
      findings: priced,
    };
  });
}

/** How many floors to look up per request, so a long history stays fast. */
const PRICE_LOOKUPS_PER_REQUEST = 8;
/** Re-check a floor after this long; a fresh drop's price moves. */
const PRICE_STALE_MS = 30 * 60 * 1000;

/**
 * Fill in what the ones that got away turned out to be worth.
 *
 * Only for free mints that were not bought — the whole question is "what did
 * skipping this cost", and a collection already in the wallet has no answer to
 * give. Newest first and capped per request, so a two-hundred-row history does
 * not turn one page load into two hundred marketplace calls.
 */
async function priceMissedMints(store: FindingStore, rows: Finding[]): Promise<Finding[]> {
  if (!marketConfigured()) return rows;

  const stale = (f: Finding): boolean =>
    f.isFree &&
    !f.minted &&
    (!f.floorCheckedAt || Date.now() - Date.parse(f.floorCheckedAt) > PRICE_STALE_MS);

  const targets = rows.filter(stale).slice(0, PRICE_LOOKUPS_PER_REQUEST);
  if (targets.length === 0) return rows;

  const found = new Map<string, Finding>();
  await Promise.all(
    targets.map(async (row) => {
      const price = await fetchFloor(row.contract);
      if (!price) return;
      const updated: Finding = {
        ...row,
        floor: price.floor,
        floorCurrency: price.currency,
        floorCheckedAt: price.checkedAt,
        missedValue: missedValue(price.floor, WALLETS_PER_ACCOUNT),
      };
      found.set(row.contract, updated);
      // update, not put: a price lookup is not a new sighting, and put would
      // count one — inflating the round counter every time the list is opened.
      await store.update(updated).catch(() => undefined);
    }),
  );

  return found.size === 0 ? rows : rows.map((r) => found.get(r.contract) ?? r);
}

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
