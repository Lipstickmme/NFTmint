import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * A deliberately thin JSON-RPC client tuned for submission latency.
 *
 * Robinhood Chain orders transactions first-come-first-served, so the only
 * lever a mint bot has is how fast bytes reach the sequencer. A general purpose
 * RPC client is the wrong tool on that path: it re-serializes payloads,
 * allocates transports, and often opens a fresh TCP+TLS connection per call
 * (a full handshake can cost more than the mint window itself).
 *
 * This client instead:
 *   - holds sockets open with a keep-alive agent, so the TLS handshake is paid
 *     once during warmup rather than at fire time;
 *   - disables Nagle's algorithm, so a small transaction payload leaves the
 *     host immediately instead of waiting to be coalesced;
 *   - accepts a PRE-SERIALIZED request body, so firing is a single socket
 *     write with no JSON encoding in the critical section.
 */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(err: RpcError, endpoint: string) {
    super(`${err.message} (code ${err.code}) [${endpoint}]`);
    this.name = 'JsonRpcError';
    this.code = err.code;
    this.data = err.data;
  }
}

export interface RpcClientOptions {
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum concurrent sockets held open to this endpoint. */
  maxSockets?: number;
  /** Extra headers, e.g. an API key for a private endpoint. */
  headers?: Record<string, string>;
}

let requestId = 0;
function nextId(): number {
  requestId += 1;
  return requestId;
}

/**
 * Serialize a JSON-RPC request body ahead of time.
 *
 * Doing this during preparation rather than at fire time removes JSON encoding
 * from the critical path. The returned string is handed straight to `sendRaw`.
 */
export function encodeRpcBody(method: string, params: unknown[]): string {
  return JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params });
}

export class RpcClient {
  readonly endpoint: string;
  private readonly url: URL;
  private readonly agent: http.Agent | https.Agent;
  private readonly transport: typeof http | typeof https;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(endpoint: string, opts: RpcClientOptions = {}) {
    this.endpoint = endpoint;
    this.url = new URL(endpoint);
    const secure = this.url.protocol === 'https:';
    this.transport = secure ? https : http;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.headers = opts.headers ?? {};

    const agentOptions: https.AgentOptions = {
      keepAlive: true,
      // Keep the socket alive aggressively; an idle-closed socket means a cold
      // handshake exactly when we can least afford one.
      keepAliveMsecs: 1_000,
      maxSockets: opts.maxSockets ?? 8,
      maxFreeSockets: opts.maxSockets ?? 8,
      timeout: this.timeoutMs,
    };
    this.agent = secure
      ? new https.Agent(agentOptions)
      : new http.Agent(agentOptions);
  }

  /**
   * Send a pre-serialized JSON-RPC body. This is the hot path: it performs no
   * serialization, no validation, and no allocation beyond what Node requires
   * to write the request.
   */
  sendRaw(body: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = this.transport.request(
        {
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          port: this.url.port || undefined,
          path: this.url.pathname + this.url.search,
          method: 'POST',
          agent: this.agent,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...this.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: { result?: unknown; error?: RpcError };
            try {
              parsed = JSON.parse(text);
            } catch {
              reject(
                new Error(
                  `Non-JSON response from ${this.endpoint} (HTTP ${res.statusCode}): ${text.slice(0, 300)}`,
                ),
              );
              return;
            }
            if (parsed.error) {
              reject(new JsonRpcError(parsed.error, this.endpoint));
              return;
            }
            resolve(parsed.result);
          });
        },
      );

      // Nagle's algorithm would buffer a small payload waiting for more data to
      // coalesce. For a lone transaction that is pure added latency.
      req.on('socket', (socket) => {
        if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`RPC timeout after ${this.timeoutMs}ms [${this.endpoint}]`));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Convenience wrapper that serializes then sends. Not for the hot path. */
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return (await this.sendRaw(encodeRpcBody(method, params))) as T;
  }

  /**
   * Open and hold sockets before the race starts, so the TLS handshake and any
   * DNS resolution are already done when the mint window opens.
   *
   * Returns the observed round-trip time per warmed socket, which doubles as a
   * cheap latency probe for ranking endpoints.
   */
  async warm(sockets = 2): Promise<number[]> {
    const probes = Array.from({ length: sockets }, async () => {
      const started = performance.now();
      await this.call('eth_chainId');
      return performance.now() - started;
    });
    return Promise.all(probes);
  }

  /** Median round-trip time over `samples` sequential probes. */
  async measureLatency(samples = 5): Promise<number> {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      await this.call('eth_chainId');
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }

  destroy(): void {
    this.agent.destroy();
  }
}

export interface RaceResult {
  endpoint: string;
  /** Milliseconds from race start to response. */
  elapsedMs: number;
  result?: unknown;
  error?: Error;
}

/**
 * Broadcast the same pre-serialized body to every endpoint at once and resolve
 * as soon as one succeeds.
 *
 * Submitting to several providers in parallel is the standard hedge against a
 * single endpoint being slow, rate limited, or momentarily unhealthy. It is
 * safe for `eth_sendRawTransaction` specifically because the transaction is
 * already signed and carries a fixed nonce: whichever copy the sequencer sees
 * first wins, and the rest are rejected as duplicates rather than producing a
 * second on-chain effect.
 */
export async function raceSubmit(
  clients: RpcClient[],
  body: string,
): Promise<{ winner: RaceResult; all: Promise<RaceResult[]> }> {
  if (clients.length === 0) throw new Error('raceSubmit called with no endpoints');
  const started = performance.now();

  const attempts = clients.map(async (client): Promise<RaceResult> => {
    try {
      const result = await client.sendRaw(body);
      return { endpoint: client.endpoint, elapsedMs: performance.now() - started, result };
    } catch (err) {
      return {
        endpoint: client.endpoint,
        elapsedMs: performance.now() - started,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  });

  // Settle all of them regardless, so late failures never surface as unhandled
  // rejections, but hand back the first success immediately.
  const all = Promise.all(attempts);

  const winner = await new Promise<RaceResult>((resolve) => {
    let outstanding = attempts.length;
    let firstFailure: RaceResult | undefined;
    for (const attempt of attempts) {
      void attempt.then((res) => {
        outstanding -= 1;
        if (!res.error) {
          resolve(res);
        } else {
          firstFailure ??= res;
          if (outstanding === 0) resolve(firstFailure);
        }
      });
    }
  });

  return { winner, all };
}
