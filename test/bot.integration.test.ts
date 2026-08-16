import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseTransaction, type Hex } from 'viem';
import { run } from '../src/bot.js';
import { NODE_INTERFACE_ADDRESS } from '../src/chain.js';
import type { BotConfig } from '../src/config.js';

/**
 * End-to-end exercise of the whole pipeline against a mock Robinhood Chain
 * node: preflight, NodeInterface gas estimation, balance checks, nonce
 * priming, pre-signing, broadcast, and receipt confirmation.
 *
 * The mock asserts on what the bot actually puts on the wire, so a regression
 * in transaction construction fails here rather than during a live mint.
 */

const KEY_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const KEY_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const CONTRACT = '0x00000000000000000000000000000000000000aa';

interface MockNode {
  url: string;
  broadcast: Hex[];
  calls: string[];
  close: () => Promise<void>;
}

interface MockOptions {
  /** Make the mint simulation revert with this Solidity Error(string). */
  revertWith?: string;
  /** Receipt status returned for broadcast transactions. */
  receiptStatus?: '0x1' | '0x0';
  startingNonce?: number;
  balanceWei?: bigint;
}

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

/** abi.encodeWithSignature("Error(string)", reason) */
function encodeRevert(reason: string): string {
  const hex = Buffer.from(reason, 'utf8').toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return '0x08c379a0' + word(32n) + word(BigInt(reason.length)) + padded;
}

async function startNode(opts: MockOptions = {}): Promise<MockNode> {
  const broadcast: Hex[] = [];
  const calls: string[] = [];
  const receiptStatus = opts.receiptStatus ?? '0x1';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const { method, params, id } = body;
      calls.push(method);

      const ok = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      const fail = (message: string, data?: string): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message, data } }),
        );
      };

      switch (method) {
        case 'eth_chainId':
          return ok('0xb626'); // 46630
        case 'eth_getCode':
          return ok('0x6080604052'); // non-empty: contract exists
        case 'eth_getBlockByNumber':
          return ok({ baseFeePerGas: '0x5f5e100' }); // 0.1 gwei
        case 'eth_getTransactionCount':
          return ok(`0x${(opts.startingNonce ?? 0).toString(16)}`);
        case 'eth_getBalance':
          return ok(`0x${(opts.balanceWei ?? 10n ** 18n).toString(16)}`);

        case 'eth_call': {
          const to = String(params[0]?.to ?? '').toLowerCase();
          if (to === NODE_INTERFACE_ADDRESS.toLowerCase()) {
            // gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate
            return ok(
              '0x' + word(120_000n) + word(20_000n) + word(100_000_000n) + word(1_000_000_000n),
            );
          }
          if (opts.revertWith) {
            return fail('execution reverted', encodeRevert(opts.revertWith));
          }
          return ok('0x');
        }

        case 'eth_sendRawTransaction': {
          const raw = params[0] as Hex;
          broadcast.push(raw);
          // Echo a deterministic hash derived from position.
          return ok(`0x${broadcast.length.toString(16).padStart(64, '0')}`);
        }

        case 'eth_getTransactionReceipt':
          return ok({
            transactionHash: params[0],
            blockNumber: '0x2a',
            status: receiptStatus,
            gasUsed: '0x1d4c0',
          });

        default:
          return ok('0x');
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    broadcast,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function makeConfig(url: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    network: 'testnet',
    chainId: 46630,
    rpcUrls: [url],
    feedUrl: 'wss://unused.invalid',
    privateKeys: [KEY_A],
    mint: {
      contract: CONTRACT,
      functionSignature: 'mint(uint256)',
      args: ['2'],
      value: 20_000_000_000_000_000n, // 0.02 ETH
    },
    gas: {
      gasLimit: undefined,
      gasLimitMultiplier: 1.3,
      maxFeePerGas: 500_000_000n,
      maxPriorityFeePerGas: 0n,
    },
    trigger: { mode: 'now', leadMs: 0, pollIntervalMs: 50 },
    txPerWallet: 1,
    requireSimulation: true,
    dryRun: false,
    ...overrides,
  } as BotConfig;
}

const nodes: MockNode[] = [];
afterEach(async () => {
  while (nodes.length) await nodes.pop()!.close();
});

async function node(opts?: MockOptions): Promise<MockNode> {
  const n = await startNode(opts);
  nodes.push(n);
  return n;
}

describe('full mint run', () => {
  it('preflights, pre-signs, broadcasts, and confirms a mint', async () => {
    const n = await node();
    const result = await run({ config: makeConfig(n.url) });

    expect(result.minted).toBe(1);
    expect(result.failed).toBe(0);
    expect(n.broadcast).toHaveLength(1);

    // The broadcast payload must be exactly what was pre-signed.
    const sent = parseTransaction(n.broadcast[0]);
    expect(sent.to?.toLowerCase()).toBe(CONTRACT);
    expect(sent.value).toBe(20_000_000_000_000_000n);
    expect(sent.nonce).toBe(0);
    expect(sent.chainId).toBe(46630);
    // mint(uint256) with quantity 2
    expect(sent.data?.slice(0, 10)).toBe('0xa0712d68');
    expect(BigInt(`0x${sent.data?.slice(10)}`)).toBe(2n);
  });

  it('applies the multiplier to the NodeInterface estimate', async () => {
    const n = await node();
    const result = await run({ config: makeConfig(n.url) });

    // Mock returns 120000 total; 120000 * 1.3 = 156000.
    expect(result.preflight.gas.total).toBe(120_000n);
    expect(result.preflight.gas.forL1).toBe(20_000n);
    expect(result.preflight.gas.forL2).toBe(100_000n);
    expect(result.preflight.gasLimit).toBe(156_000n);
    expect(parseTransaction(n.broadcast[0]).gas).toBe(156_000n);
  });

  it('honours an explicit GAS_LIMIT over estimation', async () => {
    const n = await node();
    const config = makeConfig(n.url, {
      gas: {
        gasLimit: 300_000n,
        gasLimitMultiplier: 1.3,
        maxFeePerGas: 500_000_000n,
        maxPriorityFeePerGas: 0n,
      },
    });
    const result = await run({ config });

    expect(result.preflight.gasLimit).toBe(300_000n);
    expect(parseTransaction(n.broadcast[0]).gas).toBe(300_000n);
  });

  it('assigns consecutive nonces across multiple transactions and wallets', async () => {
    const n = await node({ startingNonce: 7 });
    const config = makeConfig(n.url, {
      privateKeys: [KEY_A, KEY_B],
      txPerWallet: 2,
    });
    const result = await run({ config });

    expect(result.minted).toBe(4);
    expect(n.broadcast).toHaveLength(4);

    // Both wallets start at the primed nonce (7) and increment independently,
    // so each contributes 7 and 8 rather than sharing one sequence.
    const nonces = n.broadcast.map((raw) => parseTransaction(raw).nonce).sort();
    expect(nonces).toEqual([7, 7, 8, 8]);

    const perWallet = new Map<number, number[]>();
    for (const tx of result.prepared) {
      const list = perWallet.get(tx.wallet.index) ?? [];
      list.push(tx.nonce);
      perWallet.set(tx.wallet.index, list);
    }
    expect(perWallet.get(0)).toEqual([7, 8]);
    expect(perWallet.get(1)).toEqual([7, 8]);
  });

  it('stops before broadcasting when DRY_RUN is set', async () => {
    const n = await node();
    const result = await run({ config: makeConfig(n.url, { dryRun: true }) });

    expect(result.prepared).toHaveLength(1);
    expect(n.broadcast).toHaveLength(0);
    expect(result.minted).toBe(0);
  });

  it('refuses to run when simulation reverts and REQUIRE_SIMULATION is on', async () => {
    const n = await node({ revertWith: 'Sale not active' });
    const config = makeConfig(n.url, {
      gas: {
        gasLimit: 250_000n, // supplied, so preflight gets past estimation
        gasLimitMultiplier: 1.3,
        maxFeePerGas: 500_000_000n,
        maxPriorityFeePerGas: 0n,
      },
    });

    await expect(run({ config })).rejects.toThrow(/Sale not active/);
    expect(n.broadcast).toHaveLength(0);
  });

  it('proceeds through a revert when REQUIRE_SIMULATION is off', async () => {
    const n = await node({ revertWith: 'Sale not active' });
    const config = makeConfig(n.url, {
      requireSimulation: false,
      gas: {
        gasLimit: 250_000n,
        gasLimitMultiplier: 1.3,
        maxFeePerGas: 500_000_000n,
        maxPriorityFeePerGas: 0n,
      },
    });

    const result = await run({ config });
    expect(n.broadcast).toHaveLength(1);
    expect(result.minted).toBe(1);
  });

  it('demands an explicit gas limit when the call reverts and none was given', async () => {
    const n = await node({ revertWith: 'Sale not active' });
    await expect(run({ config: makeConfig(n.url, { requireSimulation: false }) })).rejects.toThrow(
      /Cannot determine a gas limit/,
    );
  });

  it('aborts on an underfunded wallet instead of losing the race at broadcast', async () => {
    const n = await node({ balanceWei: 1_000n });
    await expect(run({ config: makeConfig(n.url) })).rejects.toThrow(
      /cannot cover value \+ worst-case gas/,
    );
    expect(n.broadcast).toHaveLength(0);
  });

  it('reports an on-chain revert as failed rather than minted', async () => {
    const n = await node({ receiptStatus: '0x0' });
    const result = await run({ config: makeConfig(n.url) });

    expect(result.minted).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('rejects a chain-ID mismatch before spending anything', async () => {
    const n = await node();
    await expect(run({ config: makeConfig(n.url, { chainId: 4663 }) })).rejects.toThrow(
      /reports chain 46630 but config expects 4663/,
    );
    expect(n.broadcast).toHaveLength(0);
  });

  it('never calls eth_estimateGas, which would add latency mid-race', async () => {
    const n = await node();
    await run({ config: makeConfig(n.url) });
    // Gas comes from NodeInterface during preflight, never from a live estimate.
    expect(n.calls).not.toContain('eth_estimateGas');
  });
});
