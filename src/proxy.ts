/**
 * Upstream proxy used by the Vercel dashboard routes.
 *
 * A serverless function cannot hold the sequencer-feed WebSocket open, so it
 * does not own tracker state. Instead it forwards to the durable process that
 * does (`nftmint serve`). Keeping this logic here rather than inside `api/`
 * means it is typechecked and unit-tested along with everything else.
 */

export interface ProxyConfig {
  /** Base URL of the durable tracker, e.g. https://tracker.example.com */
  upstreamUrl: string;
  /** Bearer token the tracker requires, if any. */
  upstreamToken?: string;
  /** Token this endpoint requires from its own callers, if any. */
  publicToken?: string;
  timeoutMs: number;
}

export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

export function loadProxyConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const upstreamUrl = env.TRACKER_UPSTREAM_URL?.trim();
  if (!upstreamUrl) {
    throw new ProxyConfigError(
      'TRACKER_UPSTREAM_URL is not set. Point it at the machine running ' +
        '`nftmint serve` — a serverless function cannot hold the feed open itself.',
    );
  }
  if (!/^https?:\/\//.test(upstreamUrl)) {
    throw new ProxyConfigError(`TRACKER_UPSTREAM_URL must be an http(s) URL: ${upstreamUrl}`);
  }

  return {
    upstreamUrl: upstreamUrl.replace(/\/+$/, ''),
    upstreamToken: env.TRACKER_UPSTREAM_TOKEN?.trim() || undefined,
    publicToken: env.DASHBOARD_TOKEN?.trim() || undefined,
    timeoutMs: Number(env.PROXY_TIMEOUT_MS ?? 8_000),
  };
}

export interface ProxyResult {
  status: number;
  body: unknown;
}

/** Check a caller-supplied Authorization header against the configured token. */
export function checkAuth(
  config: ProxyConfig,
  authorizationHeader: string | undefined,
): boolean {
  if (!config.publicToken) return true;
  const provided = authorizationHeader?.replace(/^Bearer\s+/i, '');
  return provided === config.publicToken;
}

/**
 * Forward a request upstream and normalize every failure into a JSON body.
 *
 * A dashboard that renders "upstream unreachable" is far more useful than one
 * that shows a serverless stack trace, so no error escapes as a throw.
 */
export async function proxyRequest(
  config: ProxyConfig,
  path: string,
  search = '',
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyResult> {
  const url = `${config.upstreamUrl}${path}${search}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await fetchImpl(url, {
      headers: config.upstreamToken
        ? { authorization: `Bearer ${config.upstreamToken}` }
        : {},
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return {
        status: 502,
        body: {
          error: 'upstream returned non-JSON',
          status: res.status,
          preview: text.slice(0, 200),
        },
      };
    }
    return { status: res.status, body };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      status: aborted ? 504 : 502,
      body: {
        error: aborted ? 'upstream timed out' : 'upstream unreachable',
        upstream: config.upstreamUrl,
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
