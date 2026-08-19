import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isNearMiss, mergeFinding, toFinding, type Finding } from '../src/findings.js';
import { getStore, recordFinding, resetStore } from '../src/store.js';
import { resetRateLimits } from '../src/ratelimit.js';
import type { Candidate } from '../src/hunt.js';
import findingsHandler from '../api/findings.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';

/**
 * The durable half of the hunter.
 *
 * A hunt report only describes the round that produced it, so without this the
 * only record of a collection the bot found — or nearly bought — is a panel
 * that the next round overwrites. These tests cover the three things that made
 * the feature worth having: repeats fold into one row, a failed write never
 * takes a round down with it, and the record outlives the process that made it.
 */

const TOKEN = 'test-token-that-is-long-enough';
const auth = { authorization: `Bearer ${TOKEN}` };

function candidate(over: {
  contract?: string;
  passed?: boolean;
  failed?: string[];
  minted?: Candidate['minted'];
} = {}): Candidate {
  const contract = over.contract ?? '0x00000000000000000000000000000000000000aa';
  const failed = over.failed ?? [];
  return {
    collection: {
      contract,
      status: 'live',
      attemptsPerMinute: 90,
      uniqueMinters: 22,
      isFree: true,
    } as unknown as Candidate['collection'],
    info: {
      contract,
      hasCode: true,
      name: 'Stub Cats',
      remaining: '700',
      progressPct: 30,
      summary: '',
    } as unknown as Candidate['info'],
    evaluation: {
      contract,
      passed: over.passed ?? true,
      projectedSelloutSec: 466,
      reason: over.passed === false ? 'skipped' : 'qualified',
      checks: [
        { name: 'mint rate', passed: true, actual: '90/min', required: '>= 30/min', why: '' },
        ...failed.map((name) => ({
          name, passed: false, actual: 'no', required: 'yes', why: '',
        })),
        { name: 'sale open', passed: false, skipped: true, actual: '—', required: '—', why: '' },
      ],
    } as unknown as Candidate['evaluation'],
    minted: over.minted,
  };
}

describe('near misses', () => {
  it('is a near miss when one or two rules failed', () => {
    expect(isNearMiss(1)).toBe(true);
    expect(isNearMiss(2)).toBe(true);
  });

  it('is not a near miss when everything passed', () => {
    // A passer is recorded on its own merit; calling it a near miss too would
    // put it in both filters at once.
    expect(isNearMiss(0)).toBe(false);
  });

  it('is not a near miss when it missed by a mile', () => {
    expect(isNearMiss(3)).toBe(false);
    expect(isNearMiss(9)).toBe(false);
  });
});

describe('toFinding', () => {
  it('keeps the failed rules and ignores the skipped ones', () => {
    // A skipped check could not be judged, so listing it as failed would send
    // the operator to loosen a rule that was never applied.
    const f = toFinding(candidate({ passed: false, failed: ['unique minters'] }));
    expect(f.failedChecks).toEqual(['unique minters']);
    expect(f.passed).toBe(false);
  });

  it('flattens the demand signal and the artwork', () => {
    const f = toFinding(candidate());
    expect(f.mintsPerMinute).toBe(90);
    expect(f.uniqueMinters).toBe(22);
    expect(f.remaining).toBe('700');
    expect(f.name).toBe('Stub Cats');
    expect(f.timesSeen).toBe(1);
  });

  it('records why a passing collection was not bought', () => {
    const f = toFinding(candidate({
      minted: { attempted: 1, accepted: 0, confirmed: 0, txs: [], error: 'practice mode' },
    }));
    expect(f.outcome).toBe('practice mode');
    expect(f.minted).toBe(0);
  });

  it('records a completed buy with its transaction links', () => {
    const f = toFinding(candidate({
      minted: {
        attempted: 2, accepted: 2, confirmed: 2,
        txs: [{ hash: '0xaa', url: 'https://ex/tx/0xaa', accepted: true }],
      },
    }));
    expect(f.outcome).toBe('bought');
    expect(f.minted).toBe(2);
    expect(f.txUrls).toEqual(['https://ex/tx/0xaa']);
  });
});

describe('mergeFinding', () => {
  const first = toFinding(candidate({ passed: true }), new Date('2026-01-01T00:00:00Z'));

  it('keeps the first sighting time and counts the rounds', () => {
    // "When did this drop start" is the interesting half; the latest sighting
    // says nothing an operator cannot get from the round panel.
    const merged = mergeFinding(first, toFinding(candidate(), new Date('2026-01-01T00:05:00Z')));
    expect(merged.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.lastSeenAt).toBe('2026-01-01T00:05:00.000Z');
    expect(merged.timesSeen).toBe(2);
  });

  it('never forgets that it once passed', () => {
    // A collection that qualified and then slowed down is still a collection
    // the bot qualified — downgrading it to a near miss would hide a buy.
    const later = toFinding(candidate({ passed: false, failed: ['mint rate'] }));
    expect(mergeFinding(first, later).passed).toBe(true);
  });

  it('never forgets a buy', () => {
    const bought = mergeFinding(first, toFinding(candidate({
      minted: {
        attempted: 1, accepted: 1, confirmed: 1,
        txs: [{ hash: '0xaa', url: 'https://ex/tx/0xaa', accepted: true }],
      },
    })));
    const quietRound = mergeFinding(bought, toFinding(candidate()));
    expect(quietRound.minted).toBe(1);
    expect(quietRound.txUrls).toEqual(['https://ex/tx/0xaa']);
  });
});

describe('storage drivers', () => {
  let dir: string;

  beforeEach(async () => {
    resetStore();
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-findings-'));
  });

  afterEach(async () => {
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to memory when nothing is provisioned', () => {
    // The feature has to work on a bare deployment, not error until someone
    // attaches a database.
    expect(getStore({} as NodeJS.ProcessEnv).kind).toBe('memory');
  });

  it('uses a file when FINDINGS_FILE is set', () => {
    const env = { FINDINGS_FILE: path.join(dir, 'f.json') } as NodeJS.ProcessEnv;
    expect(getStore(env).kind).toBe('file');
  });

  it('prefers redis when Vercel KV is attached', () => {
    // Attaching the integration is meant to be the whole upgrade path, with no
    // code change, so its two injected variables must win on their own.
    const env = {
      FINDINGS_FILE: path.join(dir, 'f.json'),
      KV_REST_API_URL: 'https://kv.example',
      KV_REST_API_TOKEN: 'kv-token',
    } as NodeJS.ProcessEnv;
    expect(getStore(env).kind).toBe('redis');
  });

  it('also accepts the Upstash variable names', () => {
    const env = {
      UPSTASH_REDIS_REST_URL: 'https://kv.example',
      UPSTASH_REDIS_REST_TOKEN: 'kv-token',
    } as NodeJS.ProcessEnv;
    expect(getStore(env).kind).toBe('redis');
  });

  for (const kind of ['memory', 'file'] as const) {
    describe(kind, () => {
      const env = (d: string): NodeJS.ProcessEnv =>
        (kind === 'file'
          ? { FINDINGS_FILE: path.join(d, 'findings.json') }
          : {}) as NodeJS.ProcessEnv;

      it('returns what was written, newest first', async () => {
        const store = getStore(env(dir));
        await store.put({ ...toFinding(candidate({ contract: '0x' + 'a'.repeat(40) })), lastSeenAt: '2026-01-01T00:00:00.000Z' });
        await store.put({ ...toFinding(candidate({ contract: '0x' + 'b'.repeat(40) })), lastSeenAt: '2026-01-01T00:09:00.000Z' });

        const rows = await store.list();
        expect(rows.map((r) => r.contract)).toEqual(['0x' + 'b'.repeat(40), '0x' + 'a'.repeat(40)]);
      });

      it('folds a repeat sighting into one row', async () => {
        const store = getStore(env(dir));
        await store.put(toFinding(candidate()));
        await store.put(toFinding(candidate()));

        const rows = await store.list();
        expect(rows).toHaveLength(1);
        expect(rows[0].timesSeen).toBe(2);
      });

      it('clears', async () => {
        const store = getStore(env(dir));
        await store.put(toFinding(candidate()));
        await store.clear();
        expect(await store.list()).toEqual([]);
      });

      it('drops the oldest rows once it is full', async () => {
        const store = getStore(env(dir));
        for (let i = 0; i < 205; i += 1) {
          await store.put({
            ...toFinding(candidate({ contract: `0x${String(i).padStart(40, '0')}` })),
            lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          });
        }

        const rows = await store.list(500);
        expect(rows).toHaveLength(200);
        expect(rows[0].contract).toBe(`0x${String(204).padStart(40, '0')}`);
      }, 20_000);

      it('honours the limit', async () => {
        const store = getStore(env(dir));
        for (let i = 0; i < 5; i += 1) {
          await store.put(toFinding(candidate({ contract: '0x' + String(i).repeat(40) })));
        }
        expect(await store.list(2)).toHaveLength(2);
      });
    });
  }

  it('survives the process that wrote it', async () => {
    // The point of the file driver: a restart must not lose the record.
    const file = path.join(dir, 'nested', 'findings.json');
    await getStore({ FINDINGS_FILE: file } as NodeJS.ProcessEnv).put(toFinding(candidate()));

    resetStore();
    const reopened = await getStore({ FINDINGS_FILE: file } as NodeJS.ProcessEnv).list();
    expect(reopened[0].name).toBe('Stub Cats');
  });

  it('does not lose writes that overlap', async () => {
    // A round records several findings at once. Two overlapping read-modify-
    // write cycles over one file would silently drop all but the last.
    const file = path.join(dir, 'findings.json');
    const store = getStore({ FINDINGS_FILE: file } as NodeJS.ProcessEnv);
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((c) => store.put(toFinding(candidate({ contract: '0x' + c.repeat(40) })))),
    );
    expect(await store.list()).toHaveLength(4);
  });

  it('treats an unreadable file as an empty history', async () => {
    const file = path.join(dir, 'corrupt.json');
    await writeFile(file, 'not json', 'utf8');
    expect(await getStore({ FINDINGS_FILE: file } as NodeJS.ProcessEnv).list()).toEqual([]);
  });

  it('writes JSON that reads back as findings', async () => {
    const file = path.join(dir, 'findings.json');
    await getStore({ FINDINGS_FILE: file } as NodeJS.ProcessEnv).put(toFinding(candidate()));

    const rows = JSON.parse(await readFile(file, 'utf8')) as Record<string, Finding>;
    expect(Object.keys(rows)).toHaveLength(1);
    expect(Object.values(rows)[0].name).toBe('Stub Cats');
  });
});

/**
 * Stands in for Upstash / Vercel KV.
 *
 * The redis driver is the production path once the integration is attached,
 * and it is the only one that talks a wire protocol, so it gets a real server
 * rather than a mocked fetch: a wrong command name or a misread HGETALL reply
 * would sail past a stub that just records calls.
 */
function startFakeKv(): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hash = new Map<string, string>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer kv-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      const args = JSON.parse(Buffer.concat(chunks).toString('utf8')) as string[];
      const [cmd, , field, value] = args;
      hits.push(cmd);

      let result: unknown = null;
      switch (cmd) {
        case 'HGET': result = hash.get(field) ?? null; break;
        case 'HSET': hash.set(field, value); result = 1; break;
        case 'HGETALL': result = [...hash].flat(); break;
        case 'HLEN': result = hash.size; break;
        case 'HDEL':
          for (const f of args.slice(2)) hash.delete(f);
          result = args.length - 2;
          break;
        case 'DEL': hash.clear(); result = 1; break;
        case 'EXPIRE': result = 1; break;
        default: result = null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        hits,
        close: () => new Promise<void>((r) => {
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}

describe('redis driver', () => {
  let kv: Awaited<ReturnType<typeof startFakeKv>>;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetStore();
    kv = await startFakeKv();
    env = { KV_REST_API_URL: kv.url, KV_REST_API_TOKEN: 'kv-token' } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    resetStore();
    await kv.close();
  });

  it('writes and reads a finding back', async () => {
    const store = getStore(env);
    await store.put(toFinding(candidate()));

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Stub Cats');
    expect(rows[0].mintsPerMinute).toBe(90);
  });

  it('merges a repeat sighting rather than duplicating it', async () => {
    const store = getStore(env);
    await store.put(toFinding(candidate()));
    await store.put(toFinding(candidate()));

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].timesSeen).toBe(2);
  });

  it('bounds growth with an expiry', async () => {
    // Nothing in a serverless deployment ever calls clear(), so the key has to
    // age out on its own or it grows forever.
    await getStore(env).put(toFinding(candidate()));
    expect(kv.hits).toContain('EXPIRE');
  });

  it('clears', async () => {
    const store = getStore(env);
    await store.put(toFinding(candidate()));
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('skips a corrupt row instead of failing the whole listing', async () => {
    const store = getStore(env);
    await store.put(toFinding(candidate({ contract: '0x' + 'a'.repeat(40) })));
    // Write something unparseable under a second field, as a partial write would.
    await fetch(kv.url, {
      method: 'POST',
      headers: { authorization: 'Bearer kv-token', 'content-type': 'application/json' },
      body: JSON.stringify(['HSET', 'nftmint:findings', '0xbad', 'not json']),
    });

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].contract).toBe('0x' + 'a'.repeat(40));
  });

  it('drops the oldest rows once it is full', async () => {
    // The expiry is refreshed on every write, so a bot that never stops would
    // otherwise grow this key forever.
    const store = getStore(env);
    for (let i = 0; i < 205; i += 1) {
      await store.put({
        ...toFinding(candidate({ contract: `0x${String(i).padStart(40, '0')}` })),
        lastSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      });
    }

    const rows = await store.list(500);
    expect(rows).toHaveLength(200);
    // Newest kept, oldest gone.
    expect(rows[0].contract).toBe(`0x${String(204).padStart(40, '0')}`);
    expect(rows.map((r) => r.contract)).not.toContain(`0x${String(0).padStart(40, '0')}`);
  }, 20_000);

  it('reports a rejected token rather than silently losing writes', async () => {
    resetStore();
    const store = getStore({
      KV_REST_API_URL: kv.url,
      KV_REST_API_TOKEN: 'wrong',
    } as NodeJS.ProcessEnv);
    await expect(store.put(toFinding(candidate()))).rejects.toThrow(/401/);
  });
});

describe('recordFinding', () => {
  beforeEach(() => resetStore());
  afterEach(() => resetStore());

  it('never throws when the store is unreachable', async () => {
    // This runs inside a hunt round. Losing a log line is acceptable; losing
    // the mint the round existed to make is not.
    const env = {
      KV_REST_API_URL: 'http://127.0.0.1:1',
      KV_REST_API_TOKEN: 'nope',
    } as NodeJS.ProcessEnv;
    await expect(recordFinding(toFinding(candidate()), env)).resolves.toBeUndefined();
  });
});

interface FindingsBody {
  storage?: string;
  durable?: boolean;
  count?: number;
  passed?: number;
  nearMisses?: number;
  findings?: Finding[];
  cleared?: boolean;
  error?: string;
}

/** Minimal adapter over the deployed route, matching the other API tests. */
async function call(
  init: Partial<ApiRequest> = {},
): Promise<{ status: number; body: FindingsBody }> {
  const captured: { status: number; body: FindingsBody } = { status: 0, body: {} };
  const res: ApiResponse = {
    status(code) { captured.status = code; return this; },
    setHeader() {},
    send(body) {
      try { captured.body = JSON.parse(body); } catch { captured.body = body; }
    },
  };
  await findingsHandler({ method: 'GET', headers: {}, ...init }, res);
  return captured;
}

describe('/api/findings', () => {
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetRateLimits();
    resetStore();
    saved = { ...process.env };
    process.env.API_TOKEN = TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.FINDINGS_FILE;
  });

  afterEach(() => {
    process.env = saved;
    resetStore();
  });

  it('requires a token', async () => {
    // The history names contracts the bot bought from wallets it controls.
    expect((await call()).status).toBe(401);
  });

  it('returns an empty history before anything is found', async () => {
    const res = await call({ headers: auth });
    expect(res.status).toBe(200);
    expect(res.body.findings).toEqual([]);
    expect(res.body.durable).toBe(false);
  });

  it('lists what a round recorded', async () => {
    await recordFinding(toFinding(candidate()));
    const res = await call({ headers: auth });
    expect(res.body.count).toBe(1);
    expect(res.body.passed).toBe(1);
    expect(res.body.findings[0].name).toBe('Stub Cats');
  });

  it('filters to passers and to near misses', async () => {
    await recordFinding(toFinding(candidate({ contract: '0x' + 'a'.repeat(40) })));
    await recordFinding(
      toFinding(candidate({ contract: '0x' + 'b'.repeat(40), passed: false, failed: ['sale open'] })),
    );

    const passed = await call({ headers: auth, url: '/api/findings?filter=passed' });
    expect(passed.body.findings).toHaveLength(1);
    expect(passed.body.findings[0].passed).toBe(true);

    const near = await call({ headers: auth, url: '/api/findings?filter=near' });
    expect(near.body.findings).toHaveLength(1);
    expect(near.body.findings[0].failedChecks).toEqual(['sale open']);
  });

  it('clamps a nonsense limit instead of failing', async () => {
    await recordFinding(toFinding(candidate()));
    const res = await call({ headers: auth, url: '/api/findings?limit=banana' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it('clears the history on DELETE', async () => {
    await recordFinding(toFinding(candidate()));
    expect((await call({ method: 'DELETE', headers: auth })).body.cleared).toBe(true);
    expect((await call({ headers: auth })).body.findings).toEqual([]);
  });

  it('refuses methods that are neither read nor clear', async () => {
    expect((await call({ method: 'POST', headers: auth })).status).toBe(405);
  });
});
