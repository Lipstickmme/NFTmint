import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRateLimit,
  clientKey,
  resetRateLimits,
  withSingleFlight,
  isLocked,
  DEFAULT_LIMITS,
} from '../src/ratelimit.js';

beforeEach(() => resetRateLimits());

const rule = { capacity: 3, refillPerSec: 1 };

describe('checkRateLimit', () => {
  it('allows a burst up to capacity, then denies', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('k', rule).allowed).toBe(true);
    }
    expect(checkRateLimit('k', rule).allowed).toBe(false);
  });

  it('reports how long to wait', () => {
    for (let i = 0; i < 3; i++) checkRateLimit('k', rule);
    const denied = checkRateLimit('k', rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit('k', rule, t0);
    expect(checkRateLimit('k', rule, t0).allowed).toBe(false);

    // One second later, one token is back.
    expect(checkRateLimit('k', rule, t0 + 1_000).allowed).toBe(true);
    expect(checkRateLimit('k', rule, t0 + 1_000).allowed).toBe(false);
  });

  it('never refills past capacity', () => {
    const t0 = 1_000_000;
    checkRateLimit('k', rule, t0);
    // An hour of idling should not bank an unlimited burst.
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('k', rule, t0 + 3_600_000).allowed).toBe(true);
    }
    expect(checkRateLimit('k', rule, t0 + 3_600_000).allowed).toBe(false);
  });

  it('keeps buckets independent per key', () => {
    for (let i = 0; i < 3; i++) checkRateLimit('a', rule);
    expect(checkRateLimit('a', rule).allowed).toBe(false);
    expect(checkRateLimit('b', rule).allowed).toBe(true);
  });

  it('ships defaults that do not obstruct normal use', () => {
    // A hunt cycle takes ~35s, so back-to-back hunting is ~2/min against a
    // budget of 6 — the limit should never bite in ordinary operation.
    expect(DEFAULT_LIMITS.hunt.capacity).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_LIMITS.mint.capacity).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_LIMITS.read.capacity).toBeGreaterThan(DEFAULT_LIMITS.mint.capacity);
  });
});

describe('clientKey', () => {
  it('uses the first forwarded address', () => {
    expect(clientKey({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('203.0.113.7');
  });

  it('handles a header array', () => {
    expect(clientKey({ 'x-forwarded-for': ['198.51.100.4'] })).toBe('198.51.100.4');
  });

  it('falls back to a shared bucket when no address is available', () => {
    // Still bounds total throughput, which is what protects the wallet.
    expect(clientKey({})).toBe('shared');
    expect(clientKey({ 'x-forwarded-for': '  ' })).toBe('shared');
  });
});

describe('withSingleFlight', () => {
  it('runs the work when nothing holds the lock', async () => {
    const r = await withSingleFlight('job', async () => 42);
    expect(r).toEqual({ ran: true, value: 42 });
  });

  it('refuses a second concurrent run rather than queueing it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const first = withSingleFlight('job', async () => { await gate; return 'first'; });
    // While the first is in flight the lock is held.
    expect(isLocked('job')).toBe(true);
    const second = await withSingleFlight('job', async () => 'second');
    expect(second.ran).toBe(false);

    release();
    expect(await first).toEqual({ ran: true, value: 'first' });
  });

  it('releases the lock after the work finishes', async () => {
    await withSingleFlight('job', async () => 1);
    expect(isLocked('job')).toBe(false);
    expect((await withSingleFlight('job', async () => 2)).ran).toBe(true);
  });

  it('releases the lock even when the work throws', async () => {
    await expect(
      withSingleFlight('job', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    // A failed cycle must not wedge the endpoint permanently.
    expect(isLocked('job')).toBe(false);
    expect((await withSingleFlight('job', async () => 'ok')).ran).toBe(true);
  });

  it('keeps separate locks for separate names', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const a = withSingleFlight('a', async () => { await gate; return 1; });

    expect((await withSingleFlight('b', async () => 2)).ran).toBe(true);
    release();
    await a;
  });
});
