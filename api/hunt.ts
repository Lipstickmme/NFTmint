import { handleApi, authorize, jsonSafe, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadHuntConfig } from '../src/config.js';
import { runHuntCycle } from '../src/hunt.js';
import { mergeCriteria } from '../src/criteria.js';

/**
 * /api/hunt — one full cycle: sample the feed, judge every candidate, and mint
 * the ones that qualify.
 *
 * Called on a schedule (Vercel Cron) this gives continuous hunting without any
 * process staying alive between runs. Each cycle stands alone, and re-buying is
 * prevented by an on-chain balance check rather than stored state.
 *
 * Two ways in:
 *   - `Authorization: Bearer <API_TOKEN>` — how the UI calls it.
 *   - Vercel Cron, which cannot send custom headers. Cron requests carry
 *     `x-vercel-cron`, and are accepted when CRON_SECRET matches the
 *     `Authorization` header Vercel sends, or when no CRON_SECRET is set and
 *     the request genuinely originates from Cron.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const isCron = req.headers['x-vercel-cron'] !== undefined;

  if (isCron) {
    // Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
    const secret = process.env.CRON_SECRET?.trim();
    if (secret) {
      const header = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;
      if (header?.replace(/^Bearer\s+/i, '').trim() !== secret) {
        res.setHeader('content-type', 'application/json');
        res.status(401).send(jsonSafe({ error: 'invalid cron secret' }));
        return;
      }
    }
    await runAndRespond(req, res);
    return;
  }

  // Interactive call — must present the API token.
  const auth = authorize(req.headers.authorization);
  if (!auth.ok) {
    res.setHeader('content-type', 'application/json');
    res.status(auth.status).send(jsonSafe({ error: auth.error }));
    return;
  }
  await runAndRespond(req, res);
}

async function runAndRespond(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(
    req,
    res,
    // Authentication already happened above, for both entry paths.
    { methods: ['GET', 'POST'], publicRoute: true },
    async (_body, query) => {
      const cfg = loadHuntConfig();

      const windowSec = Number(query.get('seconds') ?? cfg.windowSec);
      const dryRun = query.get('dryRun') === null ? cfg.dryRun : query.get('dryRun') === 'true';

      // Quality thresholds are adjustable from the Settings panel. Money limits
      // are not: the per-cycle mint cap, the price ceiling, and the overall
      // spend ceiling all come from the environment and ignore the query string.
      const overrides: Record<string, string | undefined> = {};
      for (const [key, value] of query.entries()) {
        if (key !== 'seconds' && key !== 'dryRun') overrides[key] = value;
      }
      const { criteria, applied } = mergeCriteria(cfg.criteria, overrides);

      const report = await runHuntCycle({
        windowSec: Math.min(Math.max(Number.isFinite(windowSec) ? windowSec : cfg.windowSec, 5), 50),
        inspectTop: cfg.inspectTop,
        maxMintsPerCycle: cfg.maxMintsPerCycle,
        // An operator can force practice mode server-side with HUNT_DRY_RUN=true,
        // and then the browser cannot turn it live.
        dryRun: cfg.dryRun ? true : dryRun,
        criteria,
      });

      return { ...report, appliedOverrides: applied, serverForcesDryRun: cfg.dryRun };
    },
  );
}
