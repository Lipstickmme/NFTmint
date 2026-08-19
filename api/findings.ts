import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { getStore } from '../src/store.js';

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
 * Authenticated like every other route. The history names contracts the bot
 * bought and the wallets' outcomes, which is not something to hand out to
 * anyone who finds the URL.
 *
 * Query parameters:
 *   filter — `passed` (bought or qualified), `near` (missed by one or two
 *            rules), or `all` (default)
 *   limit  — how many rows to return, 1..200 (default 100)
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['GET', 'DELETE'], limit: 'read' }, async (_body, query) => {
    const store = getStore();

    if ((req.method ?? 'GET').toUpperCase() === 'DELETE') {
      await store.clear();
      return { cleared: true, storage: store.kind };
    }

    const limit = clamp(Number.parseInt(query.get('limit') ?? '', 10), 1, 200, 100);
    const filter = query.get('filter') ?? 'all';

    let rows = await store.list(limit);
    if (filter === 'passed') rows = rows.filter((r) => r.passed);
    else if (filter === 'near') rows = rows.filter((r) => !r.passed);

    return {
      storage: store.kind,
      // Named so the UI can say plainly whether history outlives the process.
      durable: store.kind !== 'memory',
      count: rows.length,
      passed: rows.filter((r) => r.passed).length,
      nearMisses: rows.filter((r) => !r.passed).length,
      findings: rows,
    };
  });
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
