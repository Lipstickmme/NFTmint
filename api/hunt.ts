import {
  handleApi,
  authorize,
  jsonSafe,
  constantTimeEquals,
  type ApiRequest,
  type ApiResponse,
} from '../src/http.js';
import { loadHuntConfig } from '../src/config.js';
import { runHuntCycle } from '../src/hunt.js';
import { mergeCriteria } from '../src/criteria.js';
import { withSingleFlight } from '../src/ratelimit.js';

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
  const bearer = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;

  // `x-vercel-cron` is a hint that a request came from the scheduler, NOT proof
  // of it: any client can set that header. Treating its presence as authority
  // would leave a money-spending endpoint wide open, so it only ever unlocks
  // the request when paired with a matching CRON_SECRET. If CRON_SECRET is not
  // configured, a cron-shaped request gets no special treatment and must
  // authenticate like anything else — this endpoint is never open.
  const cronSecret = process.env.CRON_SECRET?.trim();
  const claimsCron = req.headers['x-vercel-cron'] !== undefined;

  if (claimsCron && cronSecret) {
    const provided = bearer?.replace(/^Bearer\s+/i, '').trim();
    if (provided && constantTimeEquals(provided, cronSecret)) {
      await runAndRespond(req, res);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.status(401).send(jsonSafe({ error: 'invalid cron secret' }));
    return;
  }

  // Everything else — including a request merely claiming to be cron — needs
  // the API token.
  const auth = authorize(req.headers.authorization);
  if (!auth.ok) {
    res.setHeader('content-type', 'application/json');
    res.status(auth.status).send(
      jsonSafe({
        error: claimsCron
          ? 'CRON_SECRET is not set, so scheduled requests cannot be verified. ' +
            'Set CRON_SECRET in your environment to enable cron-triggered hunting.'
          : auth.error,
      }),
    );
    return;
  }
  await runAndRespond(req, res);
}

async function runAndRespond(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(
    req,
    res,
    // Authentication already happened above, for both entry paths.
    { methods: ['GET', 'POST'], publicRoute: true, limit: 'hunt' },
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

      // Only one cycle at a time. Two overlapping hunts would each prime nonces
      // from the same wallets and then broadcast conflicting transactions, so
      // the second batch would be rejected as "nonce too low". A cron firing
      // while the browser is already hunting is exactly that case.
      const outcome = await withSingleFlight('hunt', () =>
        runHuntCycle({
          windowSec: Math.min(
            Math.max(Number.isFinite(windowSec) ? windowSec : cfg.windowSec, 5),
            50,
          ),
          inspectTop: cfg.inspectTop,
          maxMintsPerCycle: cfg.maxMintsPerCycle,
          // An operator can force practice mode server-side with
          // HUNT_DRY_RUN=true, and then the browser cannot turn it live.
          dryRun: cfg.dryRun ? true : dryRun,
          criteria,
        }),
      );

      if (!outcome.ran) {
        return {
          skipped: true,
          reason: 'A hunt cycle is already running; this request was skipped.',
          candidates: [],
          qualified: 0,
          mintedCollections: 0,
          observed: { feedTxSeen: 0, mintsSeen: 0, contractsTracked: 0 },
          dryRun: cfg.dryRun,
          feedConnected: false,
          note: 'Skipped to avoid two cycles competing for the same wallet nonces.',
        };
      }

      return {
        ...outcome.value,
        appliedOverrides: applied,
        serverForcesDryRun: cfg.dryRun,
      };
    },
  );
}
