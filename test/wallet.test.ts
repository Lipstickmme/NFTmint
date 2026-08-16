import { describe, it, expect } from 'vitest';
import { loadWallets, NonceManager } from '../src/wallet.js';
import type { Hex } from 'viem';

// Well-known test key (hardhat account #0). Never use it for real funds.
const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const SECOND_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;

describe('loadWallets', () => {
  it('derives the expected address from a private key', () => {
    const [wallet] = loadWallets([TEST_KEY]);
    expect(wallet.address).toBe(TEST_ADDRESS);
    expect(wallet.index).toBe(0);
  });

  it('indexes multiple wallets in order', () => {
    const wallets = loadWallets([TEST_KEY, SECOND_KEY]);
    expect(wallets).toHaveLength(2);
    expect(wallets[0].index).toBe(0);
    expect(wallets[1].index).toBe(1);
    expect(wallets[0].address).not.toBe(wallets[1].address);
  });
});

describe('NonceManager', () => {
  it('allocates consecutive nonces from the seeded value', () => {
    const nonces = new NonceManager();
    nonces.seed(TEST_ADDRESS, 5);

    expect(nonces.allocate(TEST_ADDRESS)).toBe(5);
    expect(nonces.allocate(TEST_ADDRESS)).toBe(6);
    expect(nonces.allocate(TEST_ADDRESS)).toBe(7);
    expect(nonces.peek(TEST_ADDRESS)).toBe(8);
  });

  it('allocates a contiguous range', () => {
    const nonces = new NonceManager();
    nonces.seed(TEST_ADDRESS, 100);
    expect(nonces.allocateRange(TEST_ADDRESS, 4)).toEqual([100, 101, 102, 103]);
  });

  it('keeps wallets independent so they can mint in parallel', () => {
    const nonces = new NonceManager();
    const other = '0x0000000000000000000000000000000000000001' as const;
    nonces.seed(TEST_ADDRESS, 10);
    nonces.seed(other, 200);

    expect(nonces.allocate(TEST_ADDRESS)).toBe(10);
    expect(nonces.allocate(other)).toBe(200);
    expect(nonces.allocate(TEST_ADDRESS)).toBe(11);
    expect(nonces.allocate(other)).toBe(201);
  });

  it('rolls back the most recent allocation', () => {
    const nonces = new NonceManager();
    nonces.seed(TEST_ADDRESS, 3);
    nonces.allocate(TEST_ADDRESS);
    nonces.release(TEST_ADDRESS);
    expect(nonces.allocate(TEST_ADDRESS)).toBe(3);
  });

  it('throws rather than guessing when a wallet was never primed', () => {
    const nonces = new NonceManager();
    expect(() => nonces.peek(TEST_ADDRESS)).toThrow(/never primed/);
  });
});
