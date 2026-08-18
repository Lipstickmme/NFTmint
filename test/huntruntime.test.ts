import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadHuntRuntime } from '../src/config.js';

/**
 * Auto-hunt discovers its target on the feed, so it must never require the
 * mint-specific variables.
 *
 * The shipped bug: hunting borrowed the full mint config and fed it a
 * placeholder via `CONTRACT_ADDRESS ?? '0x…01'`. `??` only substitutes for
 * null/undefined, so a variable that existed but was blank — exactly what you
 * get after adding it in a dashboard and leaving it empty — passed straight
 * through and was then rejected as missing. Every round died with
 * "Missing required environment variable CONTRACT_ADDRESS".
 */

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const k of ['CONTRACT_ADDRESS', 'MINT_FUNCTION', 'MINT_ARGS', 'MINT_CALLDATA']) {
    delete process.env[k];
  }
  process.env.NETWORK = 'mainnet';
  process.env.PRIVATE_KEYS = KEY;
  process.env.RPC_URLS = 'https://rpc.example.com';
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('loadHuntRuntime', () => {
  it('works with no mint configuration at all', () => {
    const cfg = loadHuntRuntime();
    expect(cfg.chainId).toBe(4663);
    expect(cfg.privateKeys).toHaveLength(1);
    expect(cfg.rpcUrls).toEqual(['https://rpc.example.com']);
  });

  it('works when CONTRACT_ADDRESS exists but is blank', () => {
    // The regression. A dashboard variable left empty must not break hunting.
    process.env.CONTRACT_ADDRESS = '';
    process.env.MINT_FUNCTION = '';
    expect(() => loadHuntRuntime()).not.toThrow();
  });

  it('ignores a contract address even when one is set', () => {
    process.env.CONTRACT_ADDRESS = '0x00000000000000000000000000000000000000aa';
    const cfg = loadHuntRuntime();
    expect(Object.keys(cfg)).not.toContain('mint');
  });

  it('still requires the private keys it genuinely needs', () => {
    delete process.env.PRIVATE_KEYS;
    expect(() => loadHuntRuntime()).toThrow(/PRIVATE_KEYS/);
  });

  it('defaults the sequencer endpoint and honours an explicit blank', () => {
    expect(loadHuntRuntime().submitOnlyUrls[0]).toContain('sequencer.mainnet');
    process.env.SEQUENCER_URLS = '';
    expect(loadHuntRuntime().submitOnlyUrls).toEqual([]);
  });

  it('carries the fee settings signing needs', () => {
    process.env.MAX_FEE_GWEI = '0.75';
    const cfg = loadHuntRuntime();
    expect(cfg.gas.maxFeePerGas).toBe(750_000_000n);
    expect(cfg.gas.maxPriorityFeePerGas).toBe(0n);
  });

  it('rejects an RPC list with nothing usable in it', () => {
    process.env.RPC_URLS = 'not-a-url,also-bad';
    expect(() => loadHuntRuntime()).toThrow(/no usable http/);
  });
});
