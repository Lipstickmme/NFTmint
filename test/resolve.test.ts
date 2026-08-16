import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../src/resolve.js';

const ADDR = '0x1234567890AbcdEF1234567890aBcdef12345678';

describe('resolveTarget', () => {
  it('accepts a plain address and checksums it', () => {
    const r = resolveTarget(ADDR.toLowerCase());
    expect(r.contract).toBe(ADDR);
    expect(r.via).toBe('address');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveTarget(`  ${ADDR}  `).contract).toBe(ADDR);
  });

  it('adds a missing 0x prefix', () => {
    const r = resolveTarget(ADDR.slice(2));
    expect(r.contract).toBe(ADDR);
    expect(r.via).toMatch(/0x added/);
  });

  it('pulls the address out of an explorer link', () => {
    const r = resolveTarget(`https://robinhoodchain.blockscout.com/token/${ADDR}`);
    expect(r.contract).toBe(ADDR);
    expect(r.via).toBe('Blockscout link');
  });

  it('pulls the address out of an OpenSea item link', () => {
    const r = resolveTarget(`https://opensea.io/assets/ethereum/${ADDR}/42`);
    expect(r.contract).toBe(ADDR);
    expect(r.via).toBe('OpenSea link');
  });

  it('explains what to do with a slug-only OpenSea link', () => {
    // No address in the URL, and resolving a slug needs an API that does not
    // cover this chain — so say so rather than failing cryptically.
    expect(() => resolveTarget('https://opensea.io/collection/some-cats')).toThrow(
      /only contains a collection name/,
    );
  });

  it('rejects a link with no address in it', () => {
    expect(() => resolveTarget('https://example.com/mint')).toThrow(/No contract address/);
  });

  it('rejects obvious nonsense with a helpful message', () => {
    expect(() => resolveTarget('hello world')).toThrow(/0x followed by 40 characters/);
  });

  it('rejects empty input', () => {
    expect(() => resolveTarget('   ')).toThrow(/Paste a contract address/);
  });

  it('rejects a too-short hex string', () => {
    expect(() => resolveTarget('0x1234')).toThrow();
  });

  it('reports errors as client faults so the API returns 400', () => {
    try {
      resolveTarget('nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('ConfigError');
    }
  });
});
