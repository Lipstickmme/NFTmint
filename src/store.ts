import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mergeFinding, type Finding } from './findings.js';
import { log } from './logger.js';

/**
 * Storage for found collections.
 *
 * Three drivers behind one interface, chosen from the environment, so the same
 * code works whether or not any storage is provisioned:
 *
 *   redis   — Upstash / Vercel KV over its REST API. Durable, shared across
 *             serverless instances. Selected automatically when Vercel KV is
 *             attached, because that integration injects the two variables
 *             below; no code change is needed to upgrade to it.
 *   file    — a JSON file, for the persistent-host path (`npm run serve`).
 *   memory  — a process-local map. Survives nothing, but means the feature
 *             works out of the box rather than erroring until storage exists.
 *
 * Records are keyed by contract so a collection seen across many rounds stays
 * one row instead of burying the list in duplicates.
 *
 * Every write is fail-soft. A hunt round must never abort because a history
 * write failed — losing a log entry is a far smaller problem than losing the
 * mint the round was there to make.
 */

export interface FindingStore {
  readonly kind: 'redis' | 'file' | 'memory';
  /** Insert or merge one finding. */
  put(finding: Finding): Promise<void>;
  /** Most recently seen first. */
  list(limit?: number): Promise<Finding[]>;
  clear(): Promise<void>;
}

/** Newest first, capped. */
function sortAndCap(items: Finding[], limit: number): Finding[] {
  return items
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, limit);
}

const MAX_RECORDS = 200;

class MemoryStore implements FindingStore {
  readonly kind = 'memory' as const;
  private readonly rows = new Map<string, Finding>();

  async put(finding: Finding): Promise<void> {
    const existing = this.rows.get(finding.contract);
    this.rows.set(finding.contract, existing ? mergeFinding(existing, finding) : finding);
    if (this.rows.size > MAX_RECORDS) {
      // Everything past the cap, oldest first.
      const stale = sortAndCap([...this.rows.values()], this.rows.size).slice(MAX_RECORDS);
      for (const row of stale) this.rows.delete(row.contract);
    }
  }

  async list(limit = 100): Promise<Finding[]> {
    return sortAndCap([...this.rows.values()], limit);
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }
}

class FileStore implements FindingStore {
  readonly kind = 'file' as const;
  /**
   * Writes are chained rather than run in parallel. A put is a read-modify-write
   * of one file, so two overlapping puts would each read the pre-write state and
   * the second would silently drop the first. A round records several findings
   * at once, so this is the normal case, not an edge case.
   */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Record<string, Finding>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Finding>;
    } catch {
      // Missing or corrupt file is an empty history, not an error.
      return {};
    }
  }

  async put(finding: Finding): Promise<void> {
    await this.serialize(async () => {
      const rows = await this.read();
      const existing = rows[finding.contract];
      rows[finding.contract] = existing ? mergeFinding(existing, finding) : finding;

      const capped = sortAndCap(Object.values(rows), MAX_RECORDS);
      const next: Record<string, Finding> = {};
      for (const row of capped) next[row.contract] = row;

      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(next), 'utf8');
    });
  }

  async list(limit = 100): Promise<Finding[]> {
    return sortAndCap(Object.values(await this.read()), limit);
  }

  async clear(): Promise<void> {
    await this.serialize(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, '{}', 'utf8');
    });
  }
}

/**
 * Upstash-compatible Redis over REST.
 *
 * REST rather than a TCP client on purpose: serverless functions are short
 * lived and a connection pool would be re-established per invocation, so a
 * plain HTTP request is both simpler and no slower here.
 */
class RedisStore implements FindingStore {
  readonly kind = 'redis' as const;
  private readonly key: string;

  constructor(
    private readonly url: string,
    private readonly token: string,
    keyPrefix = 'nftmint',
  ) {
    this.key = `${keyPrefix}:findings`;
  }

  private async command<T>(args: (string | number)[]): Promise<T | undefined> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`store returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: string };
    if (body.error) throw new Error(body.error);
    return body.result;
  }

  async put(finding: Finding): Promise<void> {
    const raw = await this.command<string | null>(['HGET', this.key, finding.contract]);
    let next = finding;
    if (raw) {
      try {
        next = mergeFinding(JSON.parse(raw) as Finding, finding);
      } catch {
        /* unreadable row is replaced rather than merged */
      }
    }
    await this.command(['HSET', this.key, finding.contract, JSON.stringify(next)]);
    // The expiry is refreshed on every write, so it only cleans up after a bot
    // that has stopped running. A bot that keeps running needs the cap too.
    await this.command(['EXPIRE', this.key, 60 * 60 * 24 * 30]);

    const size = (await this.command<number>(['HLEN', this.key])) ?? 0;
    if (size > MAX_RECORDS) await this.trim();
  }

  /** Drop the oldest rows past the cap. Rare, so the extra reads are cheap. */
  private async trim(): Promise<void> {
    const rows = await this.readAll();
    const stale = rows.slice(MAX_RECORDS);
    if (stale.length === 0) return;
    await this.command(['HDEL', this.key, ...stale.map((r) => r.contract)]);
  }

  /** Every row, newest first. */
  private async readAll(): Promise<Finding[]> {
    const flat = (await this.command<string[]>(['HGETALL', this.key])) ?? [];
    const rows: Finding[] = [];
    // HGETALL returns [field, value, field, value, …].
    for (let i = 1; i < flat.length; i += 2) {
      try {
        rows.push(JSON.parse(flat[i]) as Finding);
      } catch {
        /* skip a corrupt row rather than failing the whole listing */
      }
    }
    return sortAndCap(rows, rows.length);
  }

  async list(limit = 100): Promise<Finding[]> {
    return (await this.readAll()).slice(0, limit);
  }

  async clear(): Promise<void> {
    await this.command(['DEL', this.key]);
  }
}

let cached: FindingStore | undefined;

/**
 * Pick a driver from the environment.
 *
 * Vercel KV injects KV_REST_API_URL and KV_REST_API_TOKEN when the integration
 * is added, so attaching it is the whole upgrade path from memory to durable.
 */
export function getStore(env: NodeJS.ProcessEnv = process.env): FindingStore {
  if (cached) return cached;

  const url = env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) {
    cached = new RedisStore(url, token, env.FINDINGS_KEY_PREFIX?.trim() || 'nftmint');
  } else if (env.FINDINGS_FILE?.trim()) {
    cached = new FileStore(env.FINDINGS_FILE.trim());
  } else {
    cached = new MemoryStore();
  }
  return cached;
}

/** Drop the cached driver. For tests, and after changing the environment. */
export function resetStore(): void {
  cached = undefined;
}

/**
 * Record a finding without ever disrupting the caller.
 *
 * Called from inside a hunt round, where a storage failure must not cost a
 * mint.
 */
export async function recordFinding(
  finding: Finding,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await getStore(env).put(finding);
  } catch (err) {
    log.warn('could not record finding', {
      contract: finding.contract,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
