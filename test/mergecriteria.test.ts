import { describe, it, expect } from 'vitest';
import { mergeCriteria, DEFAULT_CRITERIA, type HuntCriteria } from '../src/criteria.js';

/**
 * The Settings panel sends these overrides from the browser. The split that
 * matters: quality thresholds are adjustable, money limits are not.
 */

const base: HuntCriteria = { ...DEFAULT_CRITERIA, maxPriceWei: 1_000n };

describe('mergeCriteria', () => {
  it('returns the defaults when nothing is overridden', () => {
    const { criteria, applied } = mergeCriteria(base, {});
    expect(criteria).toEqual(base);
    expect(applied).toHaveLength(0);
  });

  it('applies numeric overrides', () => {
    const { criteria, applied } = mergeCriteria(base, {
      minUniqueMinters: '25',
      minMintsPerMinute: '5',
    });
    expect(criteria.minUniqueMinters).toBe(25);
    expect(criteria.minMintsPerMinute).toBe(5);
    expect(applied).toContain('minUniqueMinters=25');
  });

  it('applies boolean flags', () => {
    const { criteria } = mergeCriteria(base, { freeOnly: 'false', requireLive: 'false' });
    expect(criteria.freeOnly).toBe(false);
    expect(criteria.requireLive).toBe(false);
  });

  it('clamps values to a sane range instead of trusting them', () => {
    const { criteria } = mergeCriteria(base, {
      maxSupplyProgressPct: '9999',
      maxAgeSec: '0',
    });
    expect(criteria.maxSupplyProgressPct).toBe(100);
    expect(criteria.maxAgeSec).toBe(5);
  });

  it('ignores values that are not numbers', () => {
    const { criteria } = mergeCriteria(base, { minUniqueMinters: 'lots' });
    expect(criteria.minUniqueMinters).toBe(base.minUniqueMinters);
  });

  it('ignores empty strings so a blank form field means "use the default"', () => {
    const { criteria, applied } = mergeCriteria(base, { minUniqueMinters: '' });
    expect(criteria.minUniqueMinters).toBe(base.minUniqueMinters);
    expect(applied).toHaveLength(0);
  });

  it('refuses to let the browser raise the price ceiling', () => {
    // The whole point of the split: a browser may change what the bot looks
    // for, never how much it is allowed to spend.
    const { criteria } = mergeCriteria(base, {
      maxPriceWei: '999999999999999999999',
      maxPriceEth: '100',
    });
    expect(criteria.maxPriceWei).toBe(1_000n);
  });

  it('ignores unknown keys entirely', () => {
    const { criteria, applied } = mergeCriteria(base, {
      PRIVATE_KEYS: '0xdeadbeef',
      maxMintsPerCycle: '999',
      somethingElse: 'x',
    });
    expect(criteria).toEqual(base);
    expect(applied).toHaveLength(0);
  });

  it('turning off free-only does not by itself grant a budget', () => {
    // With freeOnly off and the server's ceiling at 1000 wei, a pricier mint
    // still fails the price check downstream.
    const { criteria } = mergeCriteria(base, { freeOnly: 'false' });
    expect(criteria.freeOnly).toBe(false);
    expect(criteria.maxPriceWei).toBe(1_000n);
  });

  it('does not mutate the base criteria', () => {
    const snapshot = { ...base };
    mergeCriteria(base, { minUniqueMinters: '99' });
    expect(base).toEqual(snapshot);
  });
});
