import { timingSafeEqual } from 'node:crypto';
import {
  checkRateLimit,
  clientKey,
  DEFAULT_LIMITS,
  type LimitName,
} from './ratelimit.js';

/**
 * Shared HTTP concerns for the web API.
 *
 * The authentication here is not decoration. Once the mint endpoints run on a
 * host that holds `PRIVATE_KEYS`, the token is the only thing standing between
 * an attacker who finds the URL and every wallet the bot controls. So it fails
 * closed: with no token configured, the spending endpoints refuse to run at
 * all rather than defaulting to open.
 */

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Check a request's bearer token against `API_TOKEN`.
 *
 * Returns 503 rather than 401 when no token is configured, because an
 * unconfigured deployment is a broken one, not an unauthorized request — and
 * the distinction tells the operator what to fix.
 */
export function authorize(
  authorizationHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthResult {
  const expected = env.API_TOKEN?.trim();

  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        'API_TOKEN is not set. This endpoint can spend funds, so it refuses to run ' +
        'unauthenticated. Set API_TOKEN in your environment and send it as ' +
        '"Authorization: Bearer <token>".',
    };
  }

  if (expected.length < 16) {
    return {
      ok: false,
      status: 503,
      error: 'API_TOKEN is shorter than 16 characters. Use a long random value.',
    };
  }

  const header = Array.isArray(authorizationHeader)
    ? authorizationHeader[0]
    : authorizationHeader;
  const provided = header?.replace(/^Bearer\s+/i, '').trim();
  if (!provided) {
    return { ok: false, status: 401, error: 'missing bearer token' };
  }

  if (!constantTimeEquals(provided, expected)) {
    return { ok: false, status: 401, error: 'invalid token' };
  }

  return { ok: true };
}

/**
 * Compare two strings without leaking their similarity through timing.
 *
 * Lengths are compared first via a hash-free path that still runs
 * `timingSafeEqual` on equal-length buffers, since that function throws on a
 * length mismatch.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path is not obviously shorter.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** JSON body parsing that never throws, for handlers that must always answer. */
export function parseJsonBody(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Serialize a response body, rendering bigints as decimal strings.
 *
 * Every value that crosses this boundary — wei, gas, nonces — is a bigint
 * somewhere upstream, and `JSON.stringify` throws on them by default. One
 * replacer here beats remembering to convert at three dozen call sites.
 */
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === 'bigint' ? val.toString() : val,
  );
}

/** Normalize any thrown value into a message safe to return to a caller. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The subset of the Vercel request/response objects these handlers rely on. */
export interface ApiRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: (code: number) => ApiResponse;
  setHeader: (name: string, value: string) => void;
  send: (body: string) => void;
}

export interface HandlerOptions {
  /** Allowed HTTP methods. Anything else gets a 405. */
  methods: string[];
  /** Skip the token check. Only for endpoints that cannot spend or leak. */
  publicRoute?: boolean;
  /**
   * Rate-limit bucket to charge this route against.
   *
   * Applied after authentication, so a rejected caller cannot exhaust a
   * legitimate operator's allowance by hammering with a bad token.
   */
  limit?: LimitName;
}

/**
 * Wrap a route with method checking, authentication, and error handling.
 *
 * Centralizing this matters more than it looks: every one of these endpoints
 * runs somewhere holding private keys, and an auth check that has to be
 * remembered per file is one that eventually gets forgotten.
 */
export async function handleApi(
  req: ApiRequest,
  res: ApiResponse,
  options: HandlerOptions,
  work: (body: Record<string, unknown>, query: URLSearchParams) => Promise<unknown>,
): Promise<void> {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  // These endpoints are token-authenticated and meant to be called directly,
  // never embedded, so no cross-origin access is granted.
  res.setHeader('x-frame-options', 'DENY');

  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (!options.methods.includes(method)) {
    res.status(405).send(jsonSafe({ error: `method ${method} not allowed` }));
    return;
  }

  if (!options.publicRoute) {
    const auth = authorize(req.headers.authorization);
    if (!auth.ok) {
      res.status(auth.status).send(jsonSafe({ error: auth.error }));
      return;
    }
  }

  if (options.limit) {
    const rule = DEFAULT_LIMITS[options.limit];
    const result = checkRateLimit(`${options.limit}:${clientKey(req.headers)}`, rule);
    if (!result.allowed) {
      res.setHeader('retry-after', String(result.retryAfterSec));
      res.status(429).send(
        jsonSafe({
          error:
            `Too many requests to this endpoint. Try again in ${result.retryAfterSec}s. ` +
            `This limit exists so a leaked token cannot drain a wallet in one burst.`,
          retryAfterSec: result.retryAfterSec,
        }),
      );
      return;
    }
  }

  let query = new URLSearchParams();
  try {
    if (req.url) query = new URL(req.url, 'http://localhost').searchParams;
  } catch {
    /* malformed URL; treat as no query */
  }

  try {
    const result = await work(parseJsonBody(req.body), query);
    res.status(200).send(jsonSafe(result));
  } catch (err) {
    // Configuration and validation problems are the caller's to fix; anything
    // else is ours. Both are reported, never swallowed into a blank 500.
    const message = errorMessage(err);
    const clientFault =
      err instanceof Error &&
      ['ConfigError', 'CalldataError', 'SpendLimitError'].includes(err.name);
    res.status(clientFault ? 400 : 500).send(jsonSafe({ error: message }));
  }
}
