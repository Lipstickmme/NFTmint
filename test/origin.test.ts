import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeEndpoint, describeOrigin } from '../src/origin.js';
import { extractFloor, fetchFloor, missedValue, resetMarketCache } from '../src/market.js';

/**
 * Where mints leave from, and what the missed ones were worth.
 *
 * The recurring risk in both of these is inventing information. A guessed
 * region would get a deployment relocated; a guessed floor price would get a
 * threshold loosened. So the tests here mostly assert the *absence* of a
 * confident answer where none is available.
 */

describe('describeEndpoint', () => {
  it('recognises a provider from its hostname', () => {
    const e = describeEndpoint('https://arb-mainnet.g.alchemy.com/v2/secret-key', 'read');
    expect(e.provider).toBe('Alchemy');
  });

  it('never reports the path, which carries the API key', () => {
    // The report is rendered in a browser and copied into issues; an endpoint
    // URL with its key in it must not be one of the things on screen.
    const e = describeEndpoint('https://arb-mainnet.g.alchemy.com/v2/secret-key', 'read');
    expect(e.url).not.toContain('secret-key');
    expect(JSON.stringify(e)).not.toContain('secret-key');
  });

  it('reads a region when the host encodes one', () => {
    expect(describeEndpoint('https://eu-central.rpc.example.com', 'read').region).toBe('EU Central');
    expect(describeEndpoint('https://foo.us-east-1.example.com', 'read').region).toBe('US East');
  });

  it('says unknown rather than guessing', () => {
    // A wrong region is worse than no region: someone would move a deployment
    // on the strength of it.
    const e = describeEndpoint('https://rpc.some-host.xyz', 'read');
    expect(e.provider).toBe('unknown');
    expect(e.region).toBeUndefined();
  });

  it('survives a string that is not a URL', () => {
    expect(describeEndpoint('not a url', 'read').host).toBe('not a url');
  });
});

describe('describeOrigin', () => {
  let nodes: http.Server[] = [];

  async function startNode(delayMs = 0): Promise<string> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0xb626' }));
        }, delayMs);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    nodes.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(nodes.map((s) => new Promise<void>((r) => {
      s.closeAllConnections?.();
      s.close(() => r());
    })));
    nodes = [];
  });

  it('measures every endpoint and names the fastest', async () => {
    const fast = await startNode(0);
    const slow = await startNode(90);

    const report = await describeOrigin({
      network: 'testnet', chainId: 46630, rpcUrls: [slow, fast], submitOnlyUrls: [],
    });

    expect(report.endpoints).toHaveLength(2);
    // Submission races every endpoint at once, so the one that matters is
    // whichever answers first — not whichever is listed first.
    expect(report.submitsThrough?.host).toBe(new URL(fast).hostname);
    expect(report.summary).toMatch(/Mints leave through/);
  }, 20_000);

  it('reports an unreachable endpoint instead of pretending', async () => {
    const report = await describeOrigin({
      network: 'testnet', chainId: 46630,
      rpcUrls: ['http://127.0.0.1:1'], submitOnlyUrls: [],
    });
    expect(report.endpoints[0].rttMs).toBeUndefined();
    expect(report.endpoints[0].error).toBeDefined();
    expect(report.summary).toMatch(/did not answer|nothing can be minted/i);
  }, 20_000);

  it('always states that other minters cannot be located', async () => {
    // The tempting feature here is a world map of rival minters. Nothing in a
    // signed transaction carries a location, so that map would be fabricated —
    // and the page has to keep saying so through any redesign.
    const report = await describeOrigin({
      network: 'testnet', chainId: 46630, rpcUrls: ['http://127.0.0.1:1'], submitOnlyUrls: [],
    });
    expect(report.note).toMatch(/never where they are minting from/i);
  }, 20_000);

  it('warns when the nearest endpoint is a long way off', async () => {
    const slow = await startNode(300);
    const report = await describeOrigin({
      network: 'testnet', chainId: 46630, rpcUrls: [slow], submitOnlyUrls: [],
    });
    // On first-come-first-served ordering, distance is the entire race.
    expect(report.summary).toMatch(/first-come-first-served/);
  }, 25_000);
});

describe('extractFloor', () => {
  it('reads a flat floor field', () => {
    expect(extractFloor({ floorPrice: '0.05' })).toBe('0.05');
    expect(extractFloor({ floor_price: 0.07 })).toBe('0.07');
  });

  it('reads the nested shapes the big marketplaces use', () => {
    // Requiring one exact shape would tie this to a single provider.
    expect(extractFloor({ floorAsk: { price: { amount: { native: 0.12 } } } })).toBe('0.12');
    expect(extractFloor({ stats: { floor_price: 1.5 } })).toBe('1.5');
    expect(extractFloor({ collection: { floorPrice: '2' } })).toBe('2');
  });

  it('returns nothing when there is no floor to read', () => {
    expect(extractFloor({ name: 'Cats', volume: 10 })).toBeUndefined();
    expect(extractFloor(null)).toBeUndefined();
    expect(extractFloor('0.05')).toBeUndefined();
  });

  it('ignores a floor that is not a number', () => {
    expect(extractFloor({ floorPrice: 'unlisted' })).toBeUndefined();
  });

  it('does not hang on a self-referencing response', () => {
    const loop: Record<string, unknown> = { data: {} };
    (loop.data as Record<string, unknown>).data = loop;
    expect(() => extractFloor(loop)).not.toThrow();
  });
});

describe('fetchFloor', () => {
  let server: http.Server;
  let url: string;
  let hits: string[] = [];

  beforeEach(async () => {
    resetMarketCache();
    hits = [];
    server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ floorPrice: '0.042' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    resetMarketCache();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const CONTRACT = '0x00000000000000000000000000000000000000aa';

  it('returns nothing when no marketplace is configured', async () => {
    // A made-up price would be acted on. Unknown has to stay unknown.
    expect(await fetchFloor(CONTRACT, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('fills the contract into the template', async () => {
    const env = { MARKET_API_URL: `${url}/c/{contract}/stats` } as NodeJS.ProcessEnv;
    const price = await fetchFloor(CONTRACT, env);
    expect(price?.floor).toBe('0.042');
    expect(hits[0]).toBe(`/c/${CONTRACT}/stats`);
  });

  it('appends the contract when the template has no placeholder', async () => {
    const env = { MARKET_API_URL: `${url}/collections/` } as NodeJS.ProcessEnv;
    await fetchFloor(CONTRACT, env);
    expect(hits[0]).toBe(`/collections/${CONTRACT}`);
  });

  it('refuses anything that is not an address', async () => {
    // The value is interpolated into a URL, so it has to be an address only.
    const env = { MARKET_API_URL: `${url}/{contract}` } as NodeJS.ProcessEnv;
    expect(await fetchFloor('../../admin', env)).toBeUndefined();
    expect(hits).toEqual([]);
  });

  it('caches, so opening the list does not re-query every row', async () => {
    const env = { MARKET_API_URL: `${url}/{contract}` } as NodeJS.ProcessEnv;
    await fetchFloor(CONTRACT, env);
    await fetchFloor(CONTRACT, env);
    expect(hits).toHaveLength(1);
  });

  it('caches a miss too', async () => {
    // An API that never carries a floor should be asked once, not once per row
    // per page load.
    const env = { MARKET_API_URL: 'http://127.0.0.1:1/{contract}' } as NodeJS.ProcessEnv;
    expect(await fetchFloor(CONTRACT, env)).toBeUndefined();
    expect(await fetchFloor(CONTRACT, env)).toBeUndefined();
  });

  it('never throws when the marketplace is down', async () => {
    const env = { MARKET_API_URL: 'http://127.0.0.1:1/{contract}' } as NodeJS.ProcessEnv;
    await expect(fetchFloor(CONTRACT, env)).resolves.toBeUndefined();
  });
});

describe('missedValue', () => {
  it('multiplies by the wallets that would have minted', () => {
    // The counterfactual is ten tokens, not one: that is the whole reason for
    // generating ten wallets.
    expect(missedValue('0.05', 10)).toBe('0.5');
  });

  it('trims trailing zeros rather than padding', () => {
    expect(missedValue('0.1', 3)).toBe('0.3');
  });

  it('is zero when there is nothing to multiply', () => {
    expect(missedValue('0', 10)).toBe('0');
    expect(missedValue('nonsense', 10)).toBe('0');
    expect(missedValue('0.05', 0)).toBe('0');
  });
});
