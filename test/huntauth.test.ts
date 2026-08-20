import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ApiRequest, ApiResponse } from '../src/http.js';
import huntHandler from '../src/routes/hunt.js';
import { resetRateLimits } from '../src/ratelimit.js';

/**
 * Authentication on /api/hunt.
 *
 * This is the endpoint that spends money without a human in the loop, so it
 * gets its own tests. The specific hazard: `x-vercel-cron` is a header any
 * client can set, so it must never on its own authorize a request.
 */

const TOKEN = 'a-sufficiently-long-api-token';
const CRON = 'a-sufficiently-long-cron-secret';

// Hunting really runs a feed sample; stub it so these tests stay fast and
// never touch the network. Auth happens before this is reached.
vi.mock('../src/hunt.js', () => ({
  runHuntCycle: vi.fn(async () => ({
    startedAt: new Date().toISOString(),
    durationMs: 1,
    sampledSeconds: 1,
    feedConnected: false,
    feedUrl: 'wss://stub',
    observed: { feedTxSeen: 0, mintsSeen: 0, contractsTracked: 0 },
    candidates: [],
    qualified: 0,
    mintedCollections: 0,
    dryRun: true,
    criteria: {},
    note: 'stubbed',
  })),
  criteriaForDisplay: (c: unknown) => c,
}));

interface Captured { status: number; body: unknown }

async function call(headers: Record<string, string | undefined> = {}): Promise<Captured> {
  const captured: Captured = { status: 0, body: undefined };
  const res: ApiResponse = {
    status(code) { captured.status = code; return this; },
    setHeader() { /* ignored */ },
    send(body) { try { captured.body = JSON.parse(body); } catch { captured.body = body; } },
  };
  const req: ApiRequest = { method: 'GET', url: '/api/hunt', headers };
  await huntHandler(req, res);
  return captured;
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  resetRateLimits();
  saved = { ...process.env };
  process.env.API_TOKEN = TOKEN;
  delete process.env.CRON_SECRET;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('/api/hunt authentication', () => {
  it('rejects an unauthenticated request', async () => {
    expect((await call()).status).toBe(401);
  });

  it('accepts a valid API token', async () => {
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('does NOT let the x-vercel-cron header alone authorize a spend', async () => {
    // The regression this file exists for. With CRON_SECRET unset, an earlier
    // version ran the full money-spending cycle for anyone who set this header.
    const res = await call({ 'x-vercel-cron': '1' });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/CRON_SECRET is not set/);
  });

  it('still rejects a spoofed cron header when a cron secret IS configured', async () => {
    process.env.CRON_SECRET = CRON;
    expect((await call({ 'x-vercel-cron': '1' })).status).toBe(401);
    expect((await call({ 'x-vercel-cron': '1', authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('accepts a genuine cron request carrying the secret', async () => {
    process.env.CRON_SECRET = CRON;
    const res = await call({ 'x-vercel-cron': '1', authorization: `Bearer ${CRON}` });
    expect(res.status).toBe(200);
  });

  it('lets the API token through even on a cron-shaped request', async () => {
    process.env.CRON_SECRET = CRON;
    // Not the cron secret, but a valid operator token — should still work.
    const res = await call({ authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it('fails closed when no API_TOKEN is configured at all', async () => {
    delete process.env.API_TOKEN;
    expect((await call({ 'x-vercel-cron': '1' })).status).toBe(503);
    expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(503);
  });
});
