import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { RpcClient } from '../src/rpc.js';
import { submitOne, submitAll, summarizeOutcomes, waitForReceipts } from '../src/submit.js';
import { signOne } from '../src/presign.js';
import { loadWallets } from '../src/wallet.js';
import type { BotConfig } from '../src/config.js';

const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;

const config = {
  network: 'testnet',
  chainId: 46630,
  rpcUrls: [],
  feedUrl: '',
  privateKeys: [TEST_KEY],
  mint: {
    contract: '0x00000000000000000000000000000000000000aa',
    functionSignature: 'mint(uint256)',
    args: ['1'],
    value: 0n,
  },
  gas: {
    gasLimit: 250_000n,
    gasLimitMultiplier: 1.3,
    maxFeePerGas: 500_000_000n,
    maxPriorityFeePerGas: 0n,
  },
  trigger: { mode: 'now', leadMs: 0, pollIntervalMs: 250 },
  txPerWallet: 1,
  requireSimulation: false,
  dryRun: false,
} as unknown as BotConfig;

type Responder = (method: string, params: unknown[]) => unknown;

const cleanups: Array<() => Promise<void>> = [];

async function serverWith(responder: Responder): Promise<{ url: string; hits: number }> {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.hits += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let payload: Record<string, unknown>;
      try {
        payload = { jsonrpc: '2.0', id: body.id, result: responder(body.method, body.params) };
      } catch (err) {
        payload = {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  );
  return Object.assign(state, { url: `http://127.0.0.1:${port}` });
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function makeTx(nonce = 0) {
  const [wallet] = loadWallets([TEST_KEY]);
  return signOne({ wallet, nonce, gasLimit: 250_000n, config });
}

describe('submitOne', () => {
  it('accepts a successful broadcast and records the node hash', async () => {
    const tx = await makeTx();
    const srv = await serverWith((method) => {
      if (method === 'eth_sendRawTransaction') return tx.hash;
      return '0x';
    });
    const client = new RpcClient(srv.url);

    const outcome = await submitOne([client], tx);
    expect(outcome.accepted).toBe(true);
    expect(outcome.returnedHash).toBe(tx.hash);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    client.destroy();
  });

  it('treats "already known" as success, because the tx did reach the sequencer', async () => {
    const tx = await makeTx();
    const srv = await serverWith(() => {
      throw new Error('already known');
    });
    const client = new RpcClient(srv.url);

    const outcome = await submitOne([client], tx);
    expect(outcome.accepted).toBe(true);
    expect(outcome.alreadyKnown).toBe(true);
    client.destroy();
  });

  it('treats "nonce too low" as success, since a same-nonce tx already landed', async () => {
    const tx = await makeTx();
    const srv = await serverWith(() => {
      throw new Error('nonce too low');
    });
    const client = new RpcClient(srv.url);

    const outcome = await submitOne([client], tx);
    expect(outcome.accepted).toBe(true);
    client.destroy();
  });

  it('reports a genuine rejection as failure', async () => {
    const tx = await makeTx();
    const srv = await serverWith(() => {
      throw new Error('insufficient funds for gas * price + value');
    });
    const client = new RpcClient(srv.url);

    const outcome = await submitOne([client], tx);
    expect(outcome.accepted).toBe(false);
    expect(outcome.error).toMatch(/insufficient funds/);
    client.destroy();
  });

  it('sends the exact pre-signed payload the bot built', async () => {
    const tx = await makeTx(9);
    let seen: unknown;
    const srv = await serverWith((method, params) => {
      if (method === 'eth_sendRawTransaction') {
        seen = params[0];
        return tx.hash;
      }
      return '0x';
    });
    const client = new RpcClient(srv.url);

    await submitOne([client], tx);
    expect(seen).toBe(tx.serialized);
    client.destroy();
  });
});

describe('submitAll', () => {
  it('broadcasts every transaction and summarizes the batch', async () => {
    const txs = await Promise.all([makeTx(0), makeTx(1), makeTx(2)]);
    const srv = await serverWith((method, params) => {
      if (method === 'eth_sendRawTransaction') {
        const match = txs.find((t) => t.serialized === params[0]);
        if (!match) throw new Error('unknown payload');
        return match.hash;
      }
      return '0x';
    });
    const client = new RpcClient(srv.url, { maxSockets: 8 });

    const outcomes = await submitAll([client], txs);
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.accepted)).toBe(true);
    expect(srv.hits).toBe(3);

    const summary = summarizeOutcomes(outcomes);
    expect(summary.submitted).toBe(3);
    expect(summary.accepted).toBe(3);
    expect(summary.rejected).toBe(0);
    client.destroy();
  });

  it('reports partial failure without losing the successes', async () => {
    const txs = await Promise.all([makeTx(0), makeTx(1)]);
    const srv = await serverWith((method, params) => {
      if (params[0] === txs[1].serialized) throw new Error('insufficient funds');
      return txs[0].hash;
    });
    const client = new RpcClient(srv.url);

    const outcomes = await submitAll([client], txs);
    const summary = summarizeOutcomes(outcomes);
    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(1);
    client.destroy();
  });
});

describe('waitForReceipts', () => {
  it('returns receipts once the node reports them', async () => {
    const tx = await makeTx();
    let polls = 0;
    const srv = await serverWith((method) => {
      if (method === 'eth_getTransactionReceipt') {
        polls += 1;
        // Simulate the receipt not being ready on the first look.
        if (polls < 2) return null;
        return {
          transactionHash: tx.hash,
          blockNumber: '0x10',
          status: '0x1',
          gasUsed: '0x5208',
        };
      }
      return '0x';
    });
    const client = new RpcClient(srv.url);

    const receipts = await waitForReceipts(client, [tx.hash], 5_000, 20);
    expect(receipts.get(tx.hash)?.status).toBe('0x1');
    client.destroy();
  });

  it('gives up at the timeout and marks the hash unresolved', async () => {
    const tx = await makeTx();
    const srv = await serverWith(() => null);
    const client = new RpcClient(srv.url);

    const receipts = await waitForReceipts(client, [tx.hash], 120, 20);
    expect(receipts.has(tx.hash)).toBe(true);
    expect(receipts.get(tx.hash)).toBeUndefined();
    client.destroy();
  });
});
