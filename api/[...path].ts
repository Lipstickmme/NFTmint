/**
 * The single serverless function. Every /api/* request lands here.
 *
 * Two problems solved by one file, both of them structural rather than
 * cosmetic:
 *
 * 1. **The build used to crash.** Vercel scans every entrypoint with ts-morph
 *    to look for an exported `config`, and ts-morph bundles TypeScript 4.4.4.
 *    Walking an entrypoint's types eventually reaches abitype's declarations,
 *    which use syntax 4.4 cannot parse; 4.4 then tries to report
 *    "Type alias name cannot be '{0}'", omits the argument, and its own message
 *    formatter asserts — surfacing as a bare `Error: Debug Failure.` with no
 *    file, line, or clue. Nothing in this file's *static* types reaches src/,
 *    so there is nothing for that parser to trip over.
 *
 * 2. **Hobby deployments cap serverless functions at twelve.** One dispatcher
 *    is one function no matter how many routes exist, so adding a route is no
 *    longer a step toward a ceiling.
 *
 * `src/devserver.ts` keeps the same table for local development, so a route
 * that works locally works deployed. `test/server.test.ts` asserts the two
 * tables agree.
 */

/** The subset of the platform's request/response objects handlers rely on. */
interface Request {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface Response {
  status: (code: number) => Response;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
}

type Handler = (req: Request, res: Response) => Promise<void>;

/**
 * Route name to module.
 *
 * An allowlist, and it has to stay one: these are `import()` targets, so
 * deriving a specifier from the request path instead would let a caller load
 * any file on disk.
 *
 * Written as literal specifiers rather than a string variable because Vercel's
 * tracer follows literals — a variable would keep the modules out of the
 * deployment bundle and every request would 500 on a missing file. Being
 * *dynamic* imports is what keeps them out of the static type graph and away
 * from the parser described above; being *literal* is what gets them shipped.
 */
const ROUTES: Record<string, () => Promise<unknown>> = {
  health: () => import('../src/routes/health.js'),
  status: () => import('../src/routes/status.js'),
  preflight: () => import('../src/routes/preflight.js'),
  mint: () => import('../src/routes/mint.js'),
  mintnow: () => import('../src/routes/mintnow.js'),
  scan: () => import('../src/routes/scan.js'),
  live: () => import('../src/routes/live.js'),
  hunt: () => import('../src/routes/hunt.js'),
  plan: () => import('../src/routes/plan.js'),
  inspect: () => import('../src/routes/inspect.js'),
  collections: () => import('../src/routes/collections.js'),
  findings: () => import('../src/routes/findings.js'),
  account: () => import('../src/routes/account.js'),
  subscribe: () => import('../src/routes/subscribe.js'),
  billing: () => import('../src/routes/billing.js'),
  origin: () => import('../src/routes/origin.js'),
};

export default async function handler(req: Request, res: Response): Promise<void> {
  const name = routeName(req.url);
  const load = name ? ROUTES[name] : undefined;

  if (!load) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.status(404).send(
      JSON.stringify({
        error: `No API route named "${name ?? ''}".`,
        routes: Object.keys(ROUTES).sort(),
      }),
    );
    return;
  }

  const mod = (await load()) as { default: Handler };
  await mod.default(req, res);
}

/** The first path segment after /api, ignoring the query string. */
function routeName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const path = url.split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean);
  const apiAt = segments.indexOf('api');
  const name = apiAt >= 0 ? segments[apiAt + 1] : segments[0];
  // Only ever a bare name; anything else is not a route we have.
  return name && /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
}
