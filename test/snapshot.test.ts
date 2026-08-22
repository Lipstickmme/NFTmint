import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectSnapshot, upstreamConfigured } from '../src/snapshot.js';

/**
 * Where "what is minting right now" comes from.
 *
 * This is the switch the whole host move is for. Sampling the sequencer feed
 * inside a serverless function bills every second of the window as active CPU,
 * and the hunter and the board each do it on a 45-second loop — which is what
 * put the account over its limit in the first place. A machine that stays on
 * holds that feed anyway, so pointing at one turns a 15-second socket into a
 * single HTTP request.
 *
 * The cases that matter: an upstream answer must actually replace the sampling
 * rather than happen alongside it, the token must be sent, and a tracker that
 * has gone down must not silently put the bill back.
 */

const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface StubOptions {
  status?: number;
  body?: unknown;
  onRequest?: (req: http.IncomingMessage) => void;
}

/** A stand-in for a machine running `nftmint serve`. */
async function stubTracker(options: StubOptions = {}): Promise<string> {
  const server = http.createServer((req, res) => {
    options.onRequest?.(req);
    res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        options.body ?? {
          generatedAt: '2026-08-21T12:00:00.000Z',
          config: { velocityWindowSec: 15 },
          stats: { feedTxSeen: 9100, mintsSeen: 412, contractsTracked: 7 },
          collections: [
            { contract: '0x00000000000000000000000000000000000000aa', attempts: 31 },
            { contract: '0x00000000000000000000000000000000000000bb', attempts: 12 },
          ],
        },
      ),
    );
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A window long enough that sampling it would be obvious in the timings. */
const LONG_WINDOW = 30;

describe('reading from a persistent tracker', () => {
  it('answers from upstream instead of holding the feed open', async () => {
    const url = await stubTracker();

    const started = Date.now();
    const snap = await collectSnapshot(
      { windowSec: LONG_WINDOW, limit: 50, tracker: {} },
      { TRACKER_UPSTREAM_URL: url },
    );

    // The point of the whole exercise: a 30-second window cost no seconds.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(snap.source).toBe('upstream');
    expect(snap.collections).toHaveLength(2);
    expect(snap.observed).toEqual({ feedTxSeen: 9100, mintsSeen: 412, contractsTracked: 7 });
    expect(snap.feedConnected).toBe(true);
    expect(snap.upstream?.velocityWindowSec).toBe(15);
  });

  it('sends the tracker token, and asks for the rows the caller wanted', async () => {
    let seen: http.IncomingMessage | undefined;
    const url = await stubTracker({ onRequest: (req) => void (seen = req) });

    await collectSnapshot(
      { windowSec: 1, limit: 25, freeOnly: true, tracker: {} },
      { TRACKER_UPSTREAM_URL: url, TRACKER_UPSTREAM_TOKEN: 'secret-token' },
    );

    expect(seen?.headers.authorization).toBe('Bearer secret-token');
    expect(seen?.url).toContain('limit=25');
    expect(seen?.url).toContain('free=true');
  });

  it('does not ask upstream for free-only rows unless the caller did', async () => {
    let seen: http.IncomingMessage | undefined;
    const url = await stubTracker({ onRequest: (req) => void (seen = req) });

    await collectSnapshot({ windowSec: 1, limit: 10, tracker: {} }, { TRACKER_UPSTREAM_URL: url });

    expect(seen?.url).not.toContain('free=true');
  });
});

describe('when the tracker is not answering', () => {
  it('fails loudly rather than quietly costing what it was meant to save', async () => {
    const url = await stubTracker({ status: 503, body: { error: 'tracker restarting' } });

    await expect(
      collectSnapshot(
        { windowSec: LONG_WINDOW, limit: 50, tracker: {} },
        { TRACKER_UPSTREAM_URL: url },
      ),
    ).rejects.toThrow(/not answering.*tracker restarting/s);
  });

  it('names the setting that would let it sample here instead', async () => {
    const url = await stubTracker({ status: 401, body: { error: 'unauthorized' } });

    await expect(
      collectSnapshot({ windowSec: 1, limit: 50, tracker: {} }, { TRACKER_UPSTREAM_URL: url }),
    ).rejects.toThrow(/TRACKER_UPSTREAM_FALLBACK=true/);
  });

  it('mentions the token when the answer was a refusal', async () => {
    const url = await stubTracker({ status: 401, body: { error: 'unauthorized' } });

    await expect(
      collectSnapshot({ windowSec: 1, limit: 50, tracker: {} }, { TRACKER_UPSTREAM_URL: url }),
    ).rejects.toThrow(/TRACKER_UPSTREAM_TOKEN/);
  });

  it('rejects an answer that is not a collections listing', async () => {
    const url = await stubTracker({ body: { hello: 'world' } });

    await expect(
      collectSnapshot({ windowSec: 1, limit: 50, tracker: {} }, { TRACKER_UPSTREAM_URL: url }),
    ).rejects.toThrow(/did not return a collections array/);
  });

  it('falls back to sampling when that trade has been chosen deliberately', async () => {
    const url = await stubTracker({ status: 503, body: { error: 'down' } });

    const snap = await collectSnapshot(
      // Zero window: this asserts the fallback path runs, not what it observes.
      { windowSec: 0, limit: 50, tracker: {} },
      {
        TRACKER_UPSTREAM_URL: url,
        TRACKER_UPSTREAM_FALLBACK: 'true',
        NETWORK: 'testnet',
      },
    );

    expect(snap.source).toBe('feed');
    expect(snap.upstreamError).toMatch(/down/);
  });

  it('refuses a URL that is not http(s), fallback or not', async () => {
    await expect(
      collectSnapshot(
        { windowSec: 0, limit: 50, tracker: {} },
        {
          TRACKER_UPSTREAM_URL: 'tracker.example.com',
          TRACKER_UPSTREAM_FALLBACK: 'true',
          NETWORK: 'testnet',
        },
      ),
    ).rejects.toThrow(/must be an http\(s\) URL/);
  });
});

describe('with no tracker configured', () => {
  it('samples the feed, as a Vercel-only deployment always has', async () => {
    const snap = await collectSnapshot(
      { windowSec: 0, limit: 50, tracker: {} },
      { NETWORK: 'testnet' },
    );

    expect(snap.source).toBe('feed');
    expect(snap.upstream).toBeUndefined();
  });

  it('reports whether one is configured', () => {
    expect(upstreamConfigured({})).toBe(false);
    expect(upstreamConfigured({ TRACKER_UPSTREAM_URL: '   ' })).toBe(false);
    expect(upstreamConfigured({ TRACKER_UPSTREAM_URL: 'https://tracker.example.com' })).toBe(true);
  });
});

describe('nothing in a serverless request opens its own feed', () => {
  /**
   * A structural guard, not a behavioural one.
   *
   * Every module here runs inside a Vercel function, where holding a WebSocket
   * is billed as active CPU for the whole wait. Three of them used to open one
   * directly, and between them that was ~46% duty cycle per open tab — the
   * thing that paused the account. Routing them through collectSnapshot is what
   * lets a tracker absorb it, and a future `new FeedConsumer(...)` added back
   * into any of them would silently undo that: everything would still work, and
   * the bill would come back.
   */
  const REQUEST_PATH_MODULES = ['hunt.ts', 'live.ts', 'service.ts'];

  it.each(REQUEST_PATH_MODULES)('%s goes through collectSnapshot', async (file) => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');

    expect(source).not.toMatch(/new FeedConsumer/);
    expect(source).toContain('collectSnapshot');
  });

  it('leaves the always-on paths alone', async () => {
    // The CLI is the persistent host: there, holding the feed open is the
    // entire point and costs nothing extra.
    const { readFile } = await import('node:fs/promises');
    const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');

    expect(cli).toMatch(/new FeedConsumer/);
  });
});
