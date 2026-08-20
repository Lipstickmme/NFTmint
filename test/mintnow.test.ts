import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFunctionData, type Abi, type Hex } from 'viem';
import { parseFunction, selectorOf } from '../src/calldata.js';
import { rememberLiveMint } from '../src/liveCache.js';
import { resetKv } from '../src/kv.js';
import { resetRateLimits } from '../src/ratelimit.js';
import mintNowHandler from '../api/mintnow.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';

/**
 * The Mint button on the live board.
 *
 * A spending route driven by one press, so the tests are about the guards: it
 * must refuse a contract that is not an NFT, refuse one that is sold out,
 * refuse a price above the deployment's ceiling, and never invent calldata for
 * a collection the board is no longer showing.
 */

const CONTRACT = '0x00000000000000000000000000000000000000aa';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TOKEN = 'test-token-that-is-long-enough';

function word(v: bigint): string {
  return v.toString(16).padStart(64, '0');
}

function encodeString(text: string): string {
  const hex = Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0');
  return '0x' + word(32n) + word(BigInt(text.length)) + hex;
}

interface NodeState {
  isNft: boolean;
  totalSupply: bigint;
  maxSupply: bigint;
  maxPerWallet: bigint;
}

let servers: http.Server[] = [];
let broadcast: string[] = [];

async function startNode(state: NodeState): Promise<string> {
  const supports = selectorOf('supportsInterface(bytes4)');
  const answers: Record<string, string> = {
    [selectorOf('name()')]: encodeString('Solar Cats'),
    [selectorOf('totalSupply()')]: '0x' + word(state.totalSupply),
    [selectorOf('maxSupply()')]: '0x' + word(state.maxSupply),
    [selectorOf('maxPerWallet()')]: '0x' + word(state.maxPerWallet),
    [selectorOf('balanceOf(address)')]: '0x' + word(0n),
  };

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
        case 'eth_getTransactionCount': return ok('0x0');
        case 'eth_getBalance': return ok('0xde0b6b3a7640000');
        case 'eth_estimateGas': return ok('0x30d40');
        case 'eth_getBlockByNumber': return ok({ number: '0x2a', baseFeePerGas: '0x5f5e100' });
        case 'eth_call': {
          const data = String(params[0]?.data ?? '');
          const selector = data.slice(0, 10);
          if (selector === supports) return ok('0x' + word(state.isNft ? 1n : 0n));
          return ok(answers[selector] ?? '0x');
        }
        case 'eth_sendRawTransaction':
          broadcast.push(params[0] as string);
          return ok('0x' + broadcast.length.toString(16).padStart(64, '0'));
        case 'eth_getTransactionReceipt':
          return ok({ transactionHash: params[0], blockNumber: '0x2a', status: '0x1' });
        default: return ok('0x');
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const res: ApiResponse = {
    status(code) { captured.status = code; return this; },
    setHeader() {},
    send(text) {
      try { captured.body = JSON.parse(text) as Record<string, unknown>; }
      catch { captured.body = { raw: text }; }
    },
  };
  const req: ApiRequest = {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body,
  };
  await mintNowHandler(req, res);
  return captured;
}

let dir: string;
let saved: NodeJS.ProcessEnv;

beforeEach(async () => {
  resetRateLimits();
  resetKv();
  broadcast = [];
  saved = { ...process.env };
  dir = await mkdtemp(path.join(tmpdir(), 'nftmint-mintnow-'));
  Object.assign(process.env, {
    NETWORK: 'testnet',
    PRIVATE_KEYS: KEY,
    API_TOKEN: TOKEN,
    SEQUENCER_URLS: '',
    DATA_DIR: dir,
    MAX_FEE_GWEI: '0.5',
    PRIORITY_FEE_GWEI: '0',
    HUNT_FREE_ONLY: 'true',
    HUNT_MAX_PRICE_ETH: '0',
  });
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
});

afterEach(async () => {
  process.env = saved;
  resetKv();
  await Promise.all(servers.map((s) => new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  })));
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

/** Put a row in the cache exactly as a board request would have. */
async function cacheRow(over: Partial<Parameters<typeof rememberLiveMint>[0]> = {}): Promise<void> {
  const fn = parseFunction('mint(uint256)');
  await rememberLiveMint({
    contract: CONTRACT,
    name: 'Solar Cats',
    entrypoint: selectorOf('mint(uint256)'),
    sampleCalldata: encodeFunctionData({ abi: [fn] as Abi, functionName: 'mint', args: [1n] }),
    priceWei: '0',
    maxPerWallet: '3',
    isFree: true,
    ...over,
  } as never);
}

describe('/api/mintnow', () => {
  it('mints a collection the board is showing', async () => {
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 820n, maxSupply: 1000n, maxPerWallet: 3n,
    });
    await cacheRow();

    const res = await call({ contract: CONTRACT });
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(1);
    expect(broadcast).toHaveLength(1);
  }, 20_000);

  it('takes the whole per-wallet allowance on a free mint', async () => {
    // The point of reading maxPerWallet at all: three tokens for one gas fee
    // instead of the single one the copied transaction asked for.
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 10n, maxSupply: 1000n, maxPerWallet: 3n,
    });
    await cacheRow();

    const res = await call({ contract: CONTRACT });
    expect(String(res.body.how)).toMatch(/3/);
    expect(String(res.body.strategy)).toBeDefined();
  }, 20_000);

  it('signs everything and sends nothing in practice mode', async () => {
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 10n, maxSupply: 1000n, maxPerWallet: 1n,
    });
    await cacheRow();

    const res = await call({ contract: CONTRACT, dryRun: true });
    expect(res.body.attempted).toBe(1);
    expect(broadcast).toEqual([]);
  }, 20_000);

  it('refuses a contract that is not an NFT', async () => {
    // The board applies this gate too, but a request can name any address.
    process.env.RPC_URLS = await startNode({
      isNft: false, totalSupply: 0n, maxSupply: 0n, maxPerWallet: 0n,
    });
    await cacheRow();

    const res = await call({ contract: CONTRACT });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/does not look like an NFT/);
    expect(broadcast).toEqual([]);
  }, 20_000);

  it('refuses a sold-out collection', async () => {
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 1000n, maxSupply: 1000n, maxPerWallet: 3n,
    });
    await cacheRow();

    const res = await call({ contract: CONTRACT });
    expect(String(res.body.error)).toMatch(/sold out/);
    expect(broadcast).toEqual([]);
  }, 20_000);

  it('refuses a price above the deployment ceiling', async () => {
    // A person pressing a button has decided *what* to mint, not how much the
    // operator is willing to lose.
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 10n, maxSupply: 1000n, maxPerWallet: 1n,
    });
    await cacheRow({ priceWei: '50000000000000000', isFree: false });

    const res = await call({ contract: CONTRACT });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/ceiling/);
    expect(broadcast).toEqual([]);
  }, 20_000);

  it('refuses a collection the board is no longer showing', async () => {
    // No cached transaction means nothing proven to work, and inventing one is
    // exactly what this whole approach exists to avoid.
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 10n, maxSupply: 1000n, maxPerWallet: 1n,
    });

    const res = await call({ contract: CONTRACT });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/no longer on the board/);
  }, 20_000);

  it('refuses anything that is not an address', async () => {
    process.env.RPC_URLS = await startNode({
      isNft: true, totalSupply: 10n, maxSupply: 1000n, maxPerWallet: 1n,
    });
    const res = await call({ contract: 'not-an-address' });
    expect(res.status).toBe(400);
  }, 20_000);
});
