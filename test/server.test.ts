import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type { Address, Hex } from 'viem';
import { startStatusServer } from '../src/server.js';
import { MintTracker } from '../src/tracker.js';
import { selectorOf } from '../src/calldata.js';
import type { FeedTx } from '../src/feed.js';

const MINT_SEL = selectorOf('mint(uint256)');
const CONTRACT = '0x00000000000000000000000000000000000000aa' as Address;

function mintTx(to: Address = CONTRACT, value = 0n): FeedTx {
  return {
    hash: '0xhash' as Hex,
    to,
    selector: MINT_SEL,
    value,
    data: `${MINT_SEL}${'01'.padStart(64, '0')}` as Hex,
    raw: '0x02' as Hex,
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => {
      s.closeAllConnections?.();
      s.close(() => r());
    });
  }
});

async function serve(tracker: MintTracker, authToken?: string): Promise<string> {
  const server = startStatusServer(tracker, { port: 0, host: '127.0.0.1', authToken });
  servers.push(server);
  await new Promise<void>((r) => {
    if (server.listening) return r();
    server.once('listening', () => r());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function makeTracker(): MintTracker {
  const tracker = new MintTracker({ trackUniqueMinters: false, minAttempts: 10_000 });
  for (let i = 0; i < 4; i++) tracker.ingest(mintTx());
  tracker.ingest(mintTx('0x00000000000000000000000000000000000000bb' as Address, 10n ** 16n));
  return tracker;
}

describe('status server', () => {
  it('serves the collection snapshot as JSON', async () => {
    const base = await serve(makeTracker());
    const res = await fetch(`${base}/api/collections`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.collections).toHaveLength(2);
    expect(body.collections[0].contract).toBe(CONTRACT);
    expect(body.collections[0].attempts).toBe(4);
    expect(body.stats.mintsSeen).toBe(5);
    expect(body.config.velocityWindowSec).toBeGreaterThan(0);
  });

  it('filters to free mints on request', async () => {
    const base = await serve(makeTracker());
    const res = await fetch(`${base}/api/collections?free=true`);
    const body = await res.json();

    expect(body.collections).toHaveLength(1);
    expect(body.collections[0].isFree).toBe(true);
  });

  it('honours the limit parameter', async () => {
    const base = await serve(makeTracker());
    const body = await (await fetch(`${base}/api/collections?limit=1`)).json();
    expect(body.collections).toHaveLength(1);
  });

  it('reports health', async () => {
    const base = await serve(makeTracker());
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body.ok).toBe(true);
    expect(body.contractsTracked).toBe(2);
  });

  it('serves the dashboard HTML', async () => {
    const base = await serve(makeTracker());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Mint Tracker');
  });

  it('404s an unknown path', async () => {
    const base = await serve(makeTracker());
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('gates the API behind a bearer token when configured', async () => {
    const base = await serve(makeTracker(), 'secret');

    expect((await fetch(`${base}/api/collections`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/collections`, {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/collections`, {
          headers: { authorization: 'Bearer secret' },
        })
      ).status,
    ).toBe(200);
  });

  it('leaves the dashboard page reachable without a token', async () => {
    const base = await serve(makeTracker(), 'secret');
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('answers CORS preflight', async () => {
    const base = await serve(makeTracker());
    const res = await fetch(`${base}/api/collections`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('never serializes a bigint into the response', async () => {
    const base = await serve(makeTracker());
    const text = await (await fetch(`${base}/api/collections`)).text();
    // Would have thrown during JSON.stringify if a raw bigint leaked through.
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain('"totalValueWei"');
  });
});
