import { describe, it, expect } from 'vitest';
import { gweiToWei } from '../src/config.js';
import { decodeRevert } from '../src/preflight.js';
import { preciseSleepUntil } from '../src/triggers.js';
import { chainFor, feedFor, defaultRpcFor, explorerTxUrl } from '../src/chain.js';

describe('gweiToWei', () => {
  it('converts whole gwei', () => {
    expect(gweiToWei('1')).toBe(1_000_000_000n);
    expect(gweiToWei('0')).toBe(0n);
    expect(gweiToWei('100')).toBe(100_000_000_000n);
  });

  it('converts fractional gwei without float error', () => {
    expect(gweiToWei('0.5')).toBe(500_000_000n);
    expect(gweiToWei('0.1')).toBe(100_000_000n);
    expect(gweiToWei('0.000000001')).toBe(1n);
  });

  it('rejects malformed input', () => {
    expect(() => gweiToWei('abc')).toThrow();
    expect(() => gweiToWei('-1')).toThrow();
    expect(() => gweiToWei('0.0000000001')).toThrow(/more than 9 decimal/);
  });
});

describe('decodeRevert', () => {
  it('decodes Error(string)', () => {
    // abi.encodeWithSignature("Error(string)", "Sale not active")
    const data =
      '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '000000000000000000000000000000000000000000000000000000000000000f' +
      '53616c65206e6f742061637469766500000000000000000000000000000000000';
    expect(decodeRevert(data.slice(0, 202) as `0x${string}`)).toBe('Sale not active');
  });

  it('names a custom error by selector so it can be looked up', () => {
    expect(decodeRevert('0x1234abcd')).toBe('custom error 0x1234abcd');
  });

  it('returns undefined for empty revert data', () => {
    expect(decodeRevert('0x')).toBeUndefined();
    expect(decodeRevert(undefined)).toBeUndefined();
  });
});

describe('chain definitions', () => {
  it('uses the documented chain IDs', () => {
    expect(chainFor('mainnet').id).toBe(4663);
    expect(chainFor('testnet').id).toBe(46630);
  });

  it('pays gas in ETH on both networks', () => {
    expect(chainFor('mainnet').nativeCurrency.symbol).toBe('ETH');
    expect(chainFor('testnet').nativeCurrency.symbol).toBe('ETH');
  });

  it('exposes the sequencer feed and RPC per network', () => {
    expect(feedFor('mainnet')).toBe('wss://feed.mainnet.chain.robinhood.com');
    expect(feedFor('testnet')).toBe('wss://feed.testnet.chain.robinhood.com');
    expect(defaultRpcFor('mainnet')).toBe('https://rpc.mainnet.chain.robinhood.com');
  });

  it('builds explorer links for a transaction', () => {
    expect(explorerTxUrl('mainnet', '0xabc')).toContain('/tx/0xabc');
  });
});

describe('preciseSleepUntil', () => {
  it('does not return early', async () => {
    const target = Date.now() + 60;
    await preciseSleepUntil(target, 5);
    expect(Date.now()).toBeGreaterThanOrEqual(target);
  });

  it('returns immediately for a deadline already passed', async () => {
    const started = Date.now();
    await preciseSleepUntil(Date.now() - 1_000);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('lands close to the target', async () => {
    const target = Date.now() + 100;
    await preciseSleepUntil(target, 5);
    // Spin-waiting the last few ms should keep overshoot small.
    expect(Date.now() - target).toBeLessThan(25);
  });
});
