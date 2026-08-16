import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NODE_INTERFACE_ADDRESS } from '../src/chain.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';

import healthHandler from '../api/health.js';
import statusHandler from '../api/status.js';
import preflightHandler from '../api/preflight.js';
import mintHandler from '../api/mint.js';

/**
 * Drives the real Vercel route handlers against a mock Robinhood Chain node.
 * These are the same modules deployed to production — only the request/response
 * adapter is a test double.
 */

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SECOND_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const CONTRACT = '0x00000000000000000000000000000000000000aa';
const TOKEN = 'test-token-that-is-long-enough';

function word(v: bigint): string {
  return v.toString(16).padStart(64, '0');
}

interface Mock {
  url: string;
  broadcast: string[];
  close: () => Promise<void>;
}

async function startMockNode(): Promise<Mock> {
  const broadcast: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { method, params, id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ok = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };

      switch (method) {
        case 'eth_chainId': return ok('0xb626');
        case 'eth_getCode': return ok('0x6080604052');
        case 'eth_getBlockByNumber':
          return ok({ number: '0x2a', baseFeePerGas: '0x5f5e100' });
        case 'eth_getTransactionCount': return ok('0x0');
        case 'eth_getBalance': return ok('0xde0b6b3a7640000');
        case 'eth_call': {
          const to = String(params[0]?.to ?? '').toLowerCase();
          if (to === NODE_INTERFACE_ADDRESS.toLowerCase()) {
            return ok('0x' + word(120_000n) + word(20_000n) + word(100_000_000n) + word(10n ** 9n));
          }
          return ok('0x');
        }
        case 'eth_sendRawTransaction':
          broadcast.push(params[0] as string);
          return ok('0x' + broadcast.length.toString(16).padStart(64, '0'));
        case 'eth_getTransactionReceipt':
          return ok({
            transactionHash: params[0], blockNumber: '0x2a',
            status: '0x1', gasUsed: '0x1d4c0',
          });
        default: return ok('0x');
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    broadcast,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

interface Captured {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function call(
  handler: (req: ApiRequest, res: ApiResponse) => Promise<void>,
  init: Partial<ApiRequest> = {},
): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined, headers: {} };
  const res: ApiResponse = {
    status(code) { captured.status = code; return this; },
    setHeader(name, value) { captured.headers[name] = value; },
    send(body) {
      try { captured.body = JSON.parse(body); }
      catch { captured.body = body; }
    },
  };
  await handler({ method: 'GET', headers: {}, ...init }, res);
  return captured;
}

const auth = { authorization: `Bearer ${TOKEN}` };

let mock: Mock;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  savedEnv = { ...process.env };
  mock = await startMockNode();
  Object.assign(process.env, {
    NETWORK: 'testnet',
    RPC_URLS: mock.url,
    PRIVATE_KEYS: TEST_KEY,
    CONTRACT_ADDRESS: CONTRACT,
    MINT_FUNCTION: 'mint(uint256)',
    MINT_ARGS: '1',
    MINT_PRICE_ETH: '0',
    MINT_QUANTITY: '1',
    API_TOKEN: TOKEN,
    MAX_MINT_VALUE_ETH: '0.05',
    TX_PER_WALLET: '1',
    DRY_RUN: 'false',
    // Disable the real sequencer endpoint; tests broadcast to the mock only.
    SEQUENCER_URLS: '',
  });
  delete process.env.TRACKER_UPSTREAM_URL;
  delete process.env.GAS_LIMIT;
});

afterEach(async () => {
  await mock.close();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await call(statusHandler);
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/missing bearer token/);
  });

  it('rejects a wrong token', async () => {
    const res = await call(statusHandler, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('fails closed when API_TOKEN is unset, rather than allowing the request', async () => {
    delete process.env.API_TOKEN;
    const res = await call(statusHandler, { headers: auth });
    // 503, not 200: an unconfigured deployment must never be an open one.
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/API_TOKEN is not set/);
  });

  it('refuses a token short enough to brute force', async () => {
    process.env.API_TOKEN = 'short';
    const res = await call(statusHandler, { headers: { authorization: 'Bearer short' } });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toMatch(/shorter than 16/);
  });

  it('accepts a correct token', async () => {
    const res = await call(statusHandler, { headers: auth });
    expect(res.status).toBe(200);
  });

  it('rejects a disallowed method', async () => {
    const res = await call(mintHandler, { method: 'GET', headers: auth });
    expect(res.status).toBe(405);
  });
});

describe('GET /api/health', () => {
  it('is public and reports configuration without leaking values', async () => {
    const res = await call(healthHandler);
    expect(res.status).toBe(200);

    const body = res.body as { ok: boolean; configured: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.configured.apiToken).toBe(true);
    expect(body.configured.privateKeys).toBe(true);
    // The values themselves must never appear.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain(TEST_KEY);
  });

  it('names what is missing', async () => {
    delete process.env.API_TOKEN;
    delete process.env.PRIVATE_KEYS;
    const res = await call(healthHandler);

    const body = res.body as { ok: boolean; problems: string[] };
    expect(body.ok).toBe(false);
    expect(body.problems.join(' ')).toMatch(/API_TOKEN/);
    expect(body.problems.join(' ')).toMatch(/PRIVATE_KEYS/);
  });
});

describe('GET /api/status', () => {
  it('reports chain state and wallet balances', async () => {
    const res = await call(statusHandler, { headers: auth });
    const body = res.body as {
      chainId: number; observedChainId: number; blockNumber: string;
      wallets: Array<{ address: string; balanceEth: string }>;
      rpcEndpoints: Array<{ url: string; medianRttMs?: number }>;
    };

    expect(body.chainId).toBe(46630);
    expect(body.observedChainId).toBe(46630);
    expect(body.blockNumber).toBe('42');
    expect(body.wallets).toHaveLength(1);
    expect(body.wallets[0].address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(body.wallets[0].balanceEth).toBe('1');
    expect(body.rpcEndpoints[0].medianRttMs).toBeGreaterThanOrEqual(0);
  });

  it('never returns private key material', async () => {
    const res = await call(statusHandler, { headers: auth });
    expect(JSON.stringify(res.body)).not.toContain(TEST_KEY);
  });

  it('works before a contract has been configured', async () => {
    // Checking wallets and chain reachability is something you do while still
    // deciding what to mint, so it must not require CONTRACT_ADDRESS.
    delete process.env.CONTRACT_ADDRESS;
    delete process.env.MINT_FUNCTION;

    const res = await call(statusHandler, { headers: auth });
    expect(res.status).toBe(200);
    expect((res.body as { wallets: unknown[] }).wallets).toHaveLength(1);
  });
});

describe('POST /api/preflight', () => {
  it('simulates and reports gas without broadcasting', async () => {
    const res = await call(preflightHandler, { method: 'POST', headers: auth, body: '{}' });
    const body = res.body as {
      ok: boolean; simulationOk: boolean; gasLimit: string;
      gasSource: string; withinCeiling: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.simulationOk).toBe(true);
    expect(body.gasSource).toBe('nodeInterface');
    expect(body.gasLimit).toBe('156000');
    expect(body.withinCeiling).toBe(true);
    expect(mock.broadcast).toHaveLength(0);
  });

  it('applies request overrides over the environment', async () => {
    const res = await call(preflightHandler, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contract: '0x00000000000000000000000000000000000000bb' }),
    });
    expect((res.body as { contract: string }).contract).toBe(
      '0x00000000000000000000000000000000000000bb',
    );
  });

  it('reports an invalid contract address as a client error', async () => {
    const res = await call(preflightHandler, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ contract: 'not-an-address' }),
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/not a valid address/);
  });
});

describe('POST /api/mint', () => {
  it('broadcasts and confirms', async () => {
    const res = await call(mintHandler, { method: 'POST', headers: auth, body: '{}' });
    const body = res.body as {
      ok: boolean; minted: number; submitted: number;
      transactions: Array<{ hash: string; url: string; accepted: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.minted).toBe(1);
    expect(body.submitted).toBe(1);
    expect(mock.broadcast).toHaveLength(1);
    expect(body.transactions[0].accepted).toBe(true);
    expect(body.transactions[0].url).toContain('/tx/');
  });

  it('signs but does not broadcast on a dry run', async () => {
    const res = await call(mintHandler, {
      method: 'POST', headers: auth, body: JSON.stringify({ dryRun: 'true' }),
    });
    const body = res.body as { dryRun: boolean; transactions: unknown[] };

    expect(body.dryRun).toBe(true);
    expect(body.transactions).toHaveLength(1);
    expect(mock.broadcast).toHaveLength(0);
  });

  it('mints once per wallet, so N wallets give N mints', async () => {
    process.env.PRIVATE_KEYS = `${TEST_KEY},${SECOND_KEY}`;
    const res = await call(mintHandler, { method: 'POST', headers: auth, body: '{}' });

    const body = res.body as { submitted: number; minted: number };
    expect(body.submitted).toBe(2);
    expect(body.minted).toBe(2);
    expect(mock.broadcast).toHaveLength(2);
  });

  it('refuses a run that would exceed the spend ceiling', async () => {
    process.env.MAX_MINT_VALUE_ETH = '0.001';
    const res = await call(mintHandler, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ priceEth: '1', quantity: '5', gasLimit: '250000' }),
    });

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/above the .* ceiling/);
    expect(mock.broadcast).toHaveLength(0);
  });

  it('cannot be tricked into overriding the keys or endpoints', async () => {
    const attackerKey =
      '0x1111111111111111111111111111111111111111111111111111111111111111';
    const res = await call(mintHandler, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        PRIVATE_KEYS: attackerKey,
        privateKeys: attackerKey,
        RPC_URLS: 'http://evil.invalid',
        MAX_MINT_VALUE_ETH: '9999',
      }),
    });

    // Overrides are a fixed allowlist, so these fields are simply ignored and
    // the run proceeds with the configured wallet.
    expect(res.status).toBe(200);
    expect((res.body as { minted: number }).minted).toBe(1);
    expect(process.env.PRIVATE_KEYS).toBe(TEST_KEY);
  });

  it('forces immediate firing regardless of a requested trigger mode', async () => {
    process.env.TRIGGER_MODE = 'poll';
    process.env.READY_FUNCTION = 'saleIsActive() (bool)';
    // Would otherwise poll forever and exhaust the function's duration.
    const res = await call(mintHandler, { method: 'POST', headers: auth, body: '{}' });
    expect(res.status).toBe(200);
    expect((res.body as { minted: number }).minted).toBe(1);
  });
});
