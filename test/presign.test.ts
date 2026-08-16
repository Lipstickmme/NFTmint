import { describe, it, expect } from 'vitest';
import {
  parseTransaction,
  recoverTransactionAddress,
  keccak256,
  type Hex,
} from 'viem';
import { signOne, presignAll, totalCommitment } from '../src/presign.js';
import { loadWallets, NonceManager } from '../src/wallet.js';
import type { BotConfig } from '../src/config.js';

const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const SECOND_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const CONTRACT = '0x00000000000000000000000000000000000000aa' as const;

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    network: 'testnet',
    chainId: 46630,
    rpcUrls: ['http://127.0.0.1:1'],
    feedUrl: 'wss://example.invalid',
    privateKeys: [TEST_KEY],
    mint: {
      contract: CONTRACT,
      functionSignature: 'mint(uint256)',
      args: ['1'],
      value: 10_000_000_000_000_000n, // 0.01 ETH
    },
    gas: {
      gasLimit: 250_000n,
      gasLimitMultiplier: 1.3,
      maxFeePerGas: 500_000_000n, // 0.5 gwei
      maxPriorityFeePerGas: 0n,
    },
    trigger: { mode: 'now', leadMs: 0, pollIntervalMs: 250 },
    txPerWallet: 1,
    requireSimulation: true,
    dryRun: false,
    ...overrides,
  } as BotConfig;
}

describe('signOne', () => {
  it('produces a transaction that recovers to the signing wallet', async () => {
    const [wallet] = loadWallets([TEST_KEY]);
    const tx = await signOne({ wallet, nonce: 7, gasLimit: 250_000n, config: makeConfig() });

    const recovered = await recoverTransactionAddress({
      serializedTransaction: tx.serialized,
    });
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('encodes every field the sequencer will see', async () => {
    const [wallet] = loadWallets([TEST_KEY]);
    const config = makeConfig();
    const tx = await signOne({ wallet, nonce: 42, gasLimit: 250_000n, config });

    const parsed = parseTransaction(tx.serialized);
    expect(parsed.nonce).toBe(42);
    expect(parsed.to?.toLowerCase()).toBe(CONTRACT.toLowerCase());
    expect(parsed.value).toBe(config.mint.value);
    expect(parsed.gas).toBe(250_000n);
    expect(parsed.maxFeePerGas).toBe(config.gas.maxFeePerGas);
    expect(parsed.chainId).toBe(46630);
    expect(parsed.type).toBe('eip1559');
  });

  it('derives the transaction hash locally, before broadcast', async () => {
    const [wallet] = loadWallets([TEST_KEY]);
    const tx = await signOne({ wallet, nonce: 0, gasLimit: 250_000n, config: makeConfig() });
    // This is what lets the bot track a transaction it has not yet sent.
    expect(tx.hash).toBe(keccak256(tx.serialized));
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('pre-serializes a valid eth_sendRawTransaction body', async () => {
    const [wallet] = loadWallets([TEST_KEY]);
    const tx = await signOne({ wallet, nonce: 1, gasLimit: 250_000n, config: makeConfig() });

    const body = JSON.parse(tx.rpcBody);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('eth_sendRawTransaction');
    expect(body.params).toEqual([tx.serialized]);
    expect(typeof body.id).toBe('number');
  });

  it('defaults the priority fee to zero, since a tip buys no priority on FCFS', async () => {
    const [wallet] = loadWallets([TEST_KEY]);
    const tx = await signOne({ wallet, nonce: 0, gasLimit: 250_000n, config: makeConfig() });

    // RLP encodes zero as an empty byte string, so viem parses the field back
    // as `undefined` rather than 0n. Both mean "no tip"; normalize before
    // comparing, and check against a real tip to prove the field is live.
    const parsed = parseTransaction(tx.serialized);
    expect(parsed.maxPriorityFeePerGas ?? 0n).toBe(0n);

    const tipped = await signOne({
      wallet,
      nonce: 0,
      gasLimit: 250_000n,
      config: makeConfig({
        gas: {
          gasLimit: 250_000n,
          gasLimitMultiplier: 1.3,
          maxFeePerGas: 500_000_000n,
          maxPriorityFeePerGas: 1_000_000n,
        },
      }),
    });
    expect(parseTransaction(tipped.serialized).maxPriorityFeePerGas).toBe(1_000_000n);
    expect(tipped.serialized).not.toBe(tx.serialized);
  });
});

describe('presignAll', () => {
  it('assigns consecutive nonces per wallet and keeps wallets independent', async () => {
    const config = makeConfig({
      privateKeys: [TEST_KEY, SECOND_KEY],
      txPerWallet: 3,
    });
    const wallets = loadWallets(config.privateKeys);
    const nonces = new NonceManager();
    nonces.seed(wallets[0].address, 10);
    nonces.seed(wallets[1].address, 50);

    const txs = await presignAll({ config, wallets, nonces, gasLimit: 250_000n });

    expect(txs).toHaveLength(6);
    const first = txs.filter((t) => t.from === wallets[0].address).map((t) => t.nonce);
    const second = txs.filter((t) => t.from === wallets[1].address).map((t) => t.nonce);
    expect(first).toEqual([10, 11, 12]);
    expect(second).toEqual([50, 51, 52]);
  });

  it('gives every transaction a distinct hash', async () => {
    const config = makeConfig({ txPerWallet: 4 });
    const wallets = loadWallets(config.privateKeys);
    const nonces = new NonceManager();
    nonces.seed(wallets[0].address, 0);

    const txs = await presignAll({ config, wallets, nonces, gasLimit: 250_000n });
    expect(new Set(txs.map((t) => t.hash)).size).toBe(4);
  });

  it('expands $SENDER per wallet, so each mints to itself', async () => {
    const config = makeConfig({
      privateKeys: [TEST_KEY, SECOND_KEY],
      mint: {
        contract: CONTRACT,
        functionSignature: 'mint(address,uint256)',
        args: ['$SENDER', '1'],
        value: 0n,
      },
    });
    const wallets = loadWallets(config.privateKeys);
    const nonces = new NonceManager();
    for (const w of wallets) nonces.seed(w.address, 0);

    const txs = await presignAll({ config, wallets, nonces, gasLimit: 250_000n });
    expect(txs[0].data.toLowerCase()).toContain(wallets[0].address.slice(2).toLowerCase());
    expect(txs[1].data.toLowerCase()).toContain(wallets[1].address.slice(2).toLowerCase());
    expect(txs[0].data).not.toBe(txs[1].data);
  });
});

describe('totalCommitment', () => {
  it('sums value plus worst-case gas across the batch', async () => {
    const config = makeConfig({ txPerWallet: 2 });
    const wallets = loadWallets(config.privateKeys);
    const nonces = new NonceManager();
    nonces.seed(wallets[0].address, 0);

    const txs = await presignAll({ config, wallets, nonces, gasLimit: 250_000n });
    const perTx = config.mint.value + 250_000n * config.gas.maxFeePerGas;
    expect(totalCommitment(txs)).toBe(perTx * 2n);
  });
});
