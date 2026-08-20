import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { RpcClient, JsonRpcError, encodeRpcBody, raceSubmit, redactEndpoint } from '../src/rpc.js';

/**
 * These run against a real local HTTP server rather than a mocked transport, so
 * they exercise the actual socket path the bot uses at fire time: keep-alive
 * reuse, pre-serialized bodies, error mapping, and endpoint racing.
 */

interface MockServer {
  server: http.Server;
  url: string;
  /** Sockets observed, to prove connection reuse. */
  sockets: Set<unknown>;
  requests: Array<{ method: string; params: unknown[] }>;
  /** Artificial delay before responding, in ms. */
  delayMs: number;
  handler?: (method: string, params: unknown[]) => unknown;
}

async function startMock(name: string): Promise<MockServer> {
  const state: Partial<MockServer> = {
    sockets: new Set(),
    requests: [],
    delayMs: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.requests!.push({ method: body.method, params: body.params });

      const respond = (): void => {
        let payload: Record<string, unknown>;
        try {
          const result = state.handler
            ? state.handler(body.method, body.params)
            : defaultResult(body.method, name);
          payload = { jsonrpc: '2.0', id: body.id, result };
        } catch (err) {
          payload = {
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32000,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (state.delayMs && state.delayMs > 0) setTimeout(respond, state.delayMs);
      else respond();
    });
  });

  server.on('connection', (socket) => state.sockets!.add(socket));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return Object.assign(state, {
    server,
    url: `http://127.0.0.1:${port}`,
  }) as MockServer;
}

function defaultResult(method: string, name: string): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0xb626'; // 46630
    case 'eth_sendRawTransaction':
      return `0x${name.padEnd(64, '0')}`;
    case 'eth_getTransactionCount':
      return '0x5';
    case 'eth_getBalance':
      return '0xde0b6b3a7640000'; // 1 ETH
    default:
      return '0x';
  }
}

async function stopMock(mock: MockServer): Promise<void> {
  await new Promise<void>((resolve) => {
    mock.server.closeAllConnections?.();
    mock.server.close(() => resolve());
  });
}

describe('RpcClient', () => {
  let mock: MockServer;
  let client: RpcClient;

  beforeAll(async () => {
    mock = await startMock('a');
    client = new RpcClient(mock.url);
  });

  afterAll(async () => {
    client.destroy();
    await stopMock(mock);
  });

  it('performs a JSON-RPC call and returns the result', async () => {
    const chainId = await client.call<string>('eth_chainId');
    expect(chainId).toBe('0xb626');
    expect(BigInt(chainId)).toBe(46630n);
  });

  it('sends a pre-serialized body verbatim', async () => {
    const body = encodeRpcBody('eth_sendRawTransaction', ['0xdeadbeef']);
    const result = await client.sendRaw(body);

    expect(typeof result).toBe('string');
    const last = mock.requests[mock.requests.length - 1];
    expect(last.method).toBe('eth_sendRawTransaction');
    expect(last.params).toEqual(['0xdeadbeef']);
  });

  it('reuses one keep-alive socket across sequential calls', async () => {
    const fresh = await startMock('reuse');
    const reuseClient = new RpcClient(fresh.url, { maxSockets: 1 });
    try {
      for (let i = 0; i < 5; i++) await reuseClient.call('eth_chainId');
      // Without keep-alive this would open five connections. Paying the TCP+TLS
      // handshake once is the whole point of warming.
      expect(fresh.sockets.size).toBe(1);
    } finally {
      reuseClient.destroy();
      await stopMock(fresh);
    }
  });

  it('surfaces a JSON-RPC error as JsonRpcError', async () => {
    const failing = await startMock('fail');
    failing.handler = () => {
      throw new Error('execution reverted');
    };
    const failClient = new RpcClient(failing.url);
    try {
      await expect(failClient.call('eth_call')).rejects.toThrow(JsonRpcError);
      await expect(failClient.call('eth_call')).rejects.toThrow(/execution reverted/);
    } finally {
      failClient.destroy();
      await stopMock(failing);
    }
  });

  it('rejects on a non-JSON response instead of hanging', async () => {
    const broken = http.createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>bad gateway</html>');
    });
    await new Promise<void>((r) => broken.listen(0, '127.0.0.1', r));
    const port = (broken.address() as AddressInfo).port;
    const brokenClient = new RpcClient(`http://127.0.0.1:${port}`);

    try {
      await expect(brokenClient.call('eth_chainId')).rejects.toThrow(/Non-JSON response/);
    } finally {
      brokenClient.destroy();
      await new Promise<void>((r) => broken.close(() => r()));
    }
  });

  it('times out rather than waiting forever', async () => {
    const slow = await startMock('slow');
    slow.delayMs = 500;
    const slowClient = new RpcClient(slow.url, { timeoutMs: 80 });
    try {
      await expect(slowClient.call('eth_chainId')).rejects.toThrow(/timeout/i);
    } finally {
      slowClient.destroy();
      await stopMock(slow);
    }
  });

  it('warms multiple sockets and reports round-trip times', async () => {
    const warm = await startMock('warm');
    const warmClient = new RpcClient(warm.url, { maxSockets: 3 });
    try {
      const rtts = await warmClient.warm(3);
      expect(rtts).toHaveLength(3);
      for (const rtt of rtts) expect(rtt).toBeGreaterThanOrEqual(0);
    } finally {
      warmClient.destroy();
      await stopMock(warm);
    }
  });

  it('measures median latency', async () => {
    const median = await client.measureLatency(3);
    expect(median).toBeGreaterThanOrEqual(0);
    expect(median).toBeLessThan(5_000);
  });
});

describe('raceSubmit', () => {
  it('resolves with the fastest endpoint and still settles the others', async () => {
    const fast = await startMock('fast');
    const slow = await startMock('slow');
    slow.delayMs = 200;

    const fastClient = new RpcClient(fast.url);
    const slowClient = new RpcClient(slow.url);

    try {
      const body = encodeRpcBody('eth_sendRawTransaction', ['0x01']);
      const { winner, all } = await raceSubmit([slowClient, fastClient], body);

      expect(winner.error).toBeUndefined();
      expect(winner.endpoint).toBe(redactEndpoint(fast.url));

      // The slow endpoint still received the broadcast — that redundancy is the
      // point, so one degraded provider cannot cost the mint.
      const results = await all;
      expect(results).toHaveLength(2);
      expect(slow.requests.length).toBe(1);
    } finally {
      fastClient.destroy();
      slowClient.destroy();
      await stopMock(fast);
      await stopMock(slow);
    }
  });

  it('returns a success even when another endpoint errors', async () => {
    const good = await startMock('good');
    const bad = await startMock('bad');
    bad.handler = () => {
      throw new Error('rate limit exceeded');
    };

    const goodClient = new RpcClient(good.url);
    const badClient = new RpcClient(bad.url);

    try {
      const body = encodeRpcBody('eth_sendRawTransaction', ['0x01']);
      const { winner } = await raceSubmit([badClient, goodClient], body);
      expect(winner.error).toBeUndefined();
      expect(winner.endpoint).toBe(redactEndpoint(good.url));
    } finally {
      goodClient.destroy();
      badClient.destroy();
      await stopMock(good);
      await stopMock(bad);
    }
  });

  it('reports a failure when every endpoint fails', async () => {
    const bad = await startMock('bad');
    bad.handler = () => {
      throw new Error('nonce too low');
    };
    const badClient = new RpcClient(bad.url);

    try {
      const { winner } = await raceSubmit([badClient], encodeRpcBody('eth_x', []));
      expect(winner.error).toBeDefined();
      expect(winner.error?.message).toMatch(/nonce too low/);
    } finally {
      badClient.destroy();
      await stopMock(bad);
    }
  });

  it('throws when given no endpoints', async () => {
    await expect(raceSubmit([], '{}')).rejects.toThrow(/no endpoints/);
  });
});

describe('endpoint redaction', () => {
  it('reduces an endpoint to its host', () => {
    // The leak this closes: an Alchemy key sitting in the path of an RPC URL
    // reached a "not minted" line rendered in the browser.
    expect(redactEndpoint('https://robinhood-mainnet.g.alchemy.com/v2/My-secret-key'))
      .toBe('robinhood-mainnet.g.alchemy.com');
  });

  it('keeps the port, so two local nodes stay distinguishable', () => {
    expect(redactEndpoint('http://127.0.0.1:8545/')).toBe('127.0.0.1:8545');
  });

  it('drops a key passed as a query parameter too', () => {
    expect(redactEndpoint('https://rpc.example.com/?apiKey=secret')).toBe('rpc.example.com');
  });

  it('says nothing at all rather than echoing an unparseable string', () => {
    expect(redactEndpoint('not a url')).toBe('endpoint');
  });

  it('never lets a key reach a JSON-RPC error message', async () => {
    const secret = 'My-fZX7gXMl8HspTl5Mq';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: 3, message: 'execution reverted' },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    const client = new RpcClient(`http://127.0.0.1:${port}/v2/${secret}`);
    const message = await client.call('eth_call', []).then(
      () => 'no error', (e: Error) => e.message,
    );

    expect(message).not.toContain(secret);
    expect(message).toContain('execution reverted');
    client.destroy();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('exposes the safe label on the client', () => {
    const client = new RpcClient('https://rpc.example.com/v2/secret');
    expect(client.label).toBe('rpc.example.com');
    expect(client.label).not.toContain('secret');
    client.destroy();
  });
});
