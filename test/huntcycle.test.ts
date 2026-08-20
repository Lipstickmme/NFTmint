import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { selectorOf } from '../src/calldata.js';
import { runHuntCycle, type HuntConfig } from '../src/hunt.js';
import { getStore, resetStore } from '../src/store.js';

/**
 * A complete hunt cycle against a fake sequencer feed and a mock node.
 *
 * The unit tests cover the store and the record shape; this covers the wiring
 * between them, which is the part that silently does nothing when it breaks.
 * A round that hunts perfectly but records nothing looks identical to a round
 * that found nothing, so the only way to know the history is being written is
 * to run a real cycle and read the store afterwards.
 */

const MINT_SELECTOR = '0xa0712d68' as Hex; // mint(uint256)
const MINT_CALLDATA =
  '0xa0712d680000000000000000000000000000000000000000000000000000000000000001' as Hex;
const CONTRACT = '0x00000000000000000000000000000000000000aa';
const BOT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const L2_KIND_SIGNED_TX = 4;
const L2_KIND_BATCH = 3;

function wrapSignedTx(serialized: Hex): Uint8Array {
  return new Uint8Array(
    Buffer.concat([Buffer.from([L2_KIND_SIGNED_TX]), Buffer.from(serialized.slice(2), 'hex')]),
  );
}

function wrapBatch(messages: Uint8Array[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from([L2_KIND_BATCH])];
  for (const msg of messages) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(msg.length));
    parts.push(len, Buffer.from(msg));
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** A burst of free mints from distinct wallets, as a real rush looks on the feed. */
async function mintBurst(minters: number): Promise<string> {
  const signed: Uint8Array[] = [];
  for (let i = 0; i < minters; i += 1) {
    const account = privateKeyToAccount(generatePrivateKey());
    const tx = await account.signTransaction({
      to: CONTRACT,
      value: 0n,
      data: MINT_CALLDATA,
      nonce: 0,
      gas: 250_000n,
      maxFeePerGas: 500_000_000n,
      maxPriorityFeePerGas: 0n,
      chainId: 46630,
      type: 'eip1559',
    } as never);
    signed.push(wrapSignedTx(tx as Hex));
  }

  return JSON.stringify({
    version: 1,
    messages: [{
      sequenceNumber: 1000,
      message: {
        message: { header: { kind: 3 }, l2Msg: Buffer.from(wrapBatch(signed)).toString('base64') },
        delayedMessagesRead: 0,
      },
    }],
  });
}

/** Serves one burst to whoever connects, then stays open. */
function startFakeFeed(frame: string): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket) => socket.send(frame));

  return new Promise((resolve) => {
    wss.on('listening', () => {
      resolve({
        url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => r());
        }),
      });
    });
  });
}

function word(v: bigint): string {
  return v.toString(16).padStart(64, '0');
}

interface ContractState {
  totalSupply: bigint;
  maxSupply: bigint;
  saleOpen: boolean;
  ownedByBot: bigint;
}

interface MockNode {
  url: string;
  broadcast: string[];
  close: () => Promise<void>;
}

/** A node that answers only the reads a hunt cycle actually makes. */
async function startMockNode(state: ContractState): Promise<MockNode> {
  const broadcast: string[] = [];
  const answers = new Map<string, string>([
    [selectorOf('totalSupply()'), '0x' + word(state.totalSupply)],
    [selectorOf('maxSupply()'), '0x' + word(state.maxSupply)],
    [selectorOf('price()'), '0x' + word(0n)],
    [selectorOf('saleIsActive()'), '0x' + word(state.saleOpen ? 1n : 0n)],
    [selectorOf('balanceOf(address)'), '0x' + word(state.ownedByBot)],
    // ERC-165: yes, this is an ERC-721.
    [selectorOf('supportsInterface(bytes4)'), '0x' + word(1n)],
  ]);

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
        case 'eth_getBalance': return ok('0xde0b6b3a7640000'); // 1 ETH
        case 'eth_estimateGas': return ok('0x30d40');
        case 'eth_getBlockByNumber': return ok({ number: '0x2a', baseFeePerGas: '0x5f5e100' });
        case 'eth_call': {
          const data = String(params[0]?.data ?? '');
          // The mint simulation must succeed; an unknown read must not.
          return ok(answers.get(data.slice(0, 10)) ?? '0x');
        }
        case 'eth_sendRawTransaction':
          broadcast.push(params[0] as string);
          return ok('0x' + broadcast.length.toString(16).padStart(64, '0'));
        case 'eth_getTransactionReceipt':
          return ok({ transactionHash: params[0], blockNumber: '0x2a', status: '0x1', gasUsed: '0x1d4c0' });
        default: return ok('0x');
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    broadcast,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

function huntConfig(over: Partial<HuntConfig['criteria']> = {}, dryRun = true): HuntConfig {
  return {
    windowSec: 1,
    inspectTop: 3,
    maxMintsPerCycle: 2,
    dryRun,
    criteria: {
      minMintsPerMinute: 30,
      minUniqueMinters: 8,
      minAttemptsInWindow: 5,
      maxAgeSec: 300,
      requireLive: true,
      maxSelloutSec: 900,
      maxSupplyProgressPct: 90,
      freeOnly: true,
      maxPriceWei: 0n,
      requireSaleOpen: true,
      skipIfOwned: true,
      ...over,
    },
  };
}

describe('a hunt cycle records what it found', () => {
  let feed: Awaited<ReturnType<typeof startFakeFeed>>;
  let node: MockNode;
  let dir: string;
  let env: NodeJS.ProcessEnv;

  async function setup(state: Partial<ContractState> = {}): Promise<void> {
    feed = await startFakeFeed(await mintBurst(12));
    node = await startMockNode({
      totalSupply: 800n, maxSupply: 1000n, saleOpen: true, ownedByBot: 0n, ...state,
    });
    env = {
      NETWORK: 'testnet',
      FEED_URL: feed.url,
      RPC_URLS: node.url,
      PRIVATE_KEYS: BOT_KEY,
      SEQUENCER_URLS: '',
      MAX_FEE_GWEI: '0.5',
      PRIORITY_FEE_GWEI: '0',
      TRACKER_MIN_ATTEMPTS: '5',
      TRACKER_MIN_UNIQUE_MINTERS: '5',
      FINDINGS_FILE: path.join(dir, 'findings.json'),
    } as NodeJS.ProcessEnv;
  }

  beforeEach(async () => {
    resetStore();
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-hunt-'));
  });

  afterEach(async () => {
    await feed?.close();
    await node?.close();
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  it('saves a collection that passed, with why it was not bought', async () => {
    await setup();
    const report = await runHuntCycle(huntConfig(), env);

    expect(report.feedConnected).toBe(true);
    expect(report.observed.mintsSeen).toBe(12);
    expect(report.qualified).toBe(1);

    const kept = await getStore(env).list();
    expect(kept).toHaveLength(1);
    expect(kept[0].contract.toLowerCase()).toBe(CONTRACT);
    expect(kept[0].passed).toBe(true);
    expect(kept[0].uniqueMinters).toBe(12);
    expect(kept[0].remaining).toBe('200');
    // Dry run signs everything and sends nothing; the record has to say so.
    expect(kept[0].outcome).toMatch(/Practice mode/);
    expect(kept[0].score).toBe(100);
  }, 20_000);

  it('saves a completed buy with its transactions', async () => {
    await setup();
    await runHuntCycle(huntConfig({}, false), env);

    const kept = await getStore(env).list();
    expect(node.broadcast).toHaveLength(1);
    expect(kept[0].outcome).toBe('bought');
    expect(kept[0].minted).toBe(1);
    expect(kept[0].txUrls?.[0]).toContain('/tx/0x');
  }, 20_000);

  it('saves a near miss, naming the rule it failed', async () => {
    // This is the tuning signal: one number away from a buy.
    await setup();
    const report = await runHuntCycle(huntConfig({ maxSupplyProgressPct: 50 }), env);

    expect(report.qualified).toBe(0);
    const kept = await getStore(env).list();
    expect(kept).toHaveLength(1);
    expect(kept[0].passed).toBe(false);
    expect(kept[0].failedChecks).toEqual(['supply left']);
    // One tunable rule short, so it lands high enough to show in the close list.
    expect(kept[0].score).toBeGreaterThanOrEqual(70);
    expect(kept[0].score).toBeLessThan(100);
  }, 20_000);

  it('refuses to re-buy a collection the wallet already holds', async () => {
    // The on-chain dedupe, and the only thing making a looping hunt safe to
    // run without a database. It was dead for a while: the balanceOf signature
    // failed to parse, the failure was swallowed, and the check silently never
    // ran — so this asserts the balance is actually read, not just configured.
    await setup({ ownedByBot: 1n });
    const report = await runHuntCycle(huntConfig({}, false), env);

    expect(report.qualified).toBe(0);
    expect(node.broadcast).toEqual([]);

    const failed = report.candidates[0].evaluation.checks
      .filter((c) => !c.passed && !c.skipped)
      .map((c) => c.name);
    expect(failed).toContain('not already held');

    // Unbuyable, not nearly buyable — so it scores zero and is not kept at all.
    expect(report.candidates[0].evaluation.score).toBe(0);
    expect(await getStore(env).list()).toEqual([]);
  }, 20_000);

  it('does not save a collection nothing could rescue', async () => {
    // Sold out, sale closed, already held: no threshold makes any of these
    // buyable, so they score zero and stay out of the close list entirely.
    await setup({ totalSupply: 990n, saleOpen: false, ownedByBot: 3n });
    const report = await runHuntCycle(huntConfig(), env);

    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.qualified).toBe(0);
    expect(await getStore(env).list()).toEqual([]);
  }, 20_000);

  it('still mints when the history cannot be written', async () => {
    // A round must never lose a buy because a log write failed.
    await setup();
    const broken = {
      ...env,
      FINDINGS_FILE: undefined,
      KV_REST_API_URL: 'http://127.0.0.1:1',
      KV_REST_API_TOKEN: 'unreachable',
    } as NodeJS.ProcessEnv;

    const report = await runHuntCycle(huntConfig({}, false), broken);
    expect(report.qualified).toBe(1);
    expect(node.broadcast).toHaveLength(1);
  }, 20_000);
});
