import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * A tiny namespaced key-value store, with three interchangeable drivers.
 *
 * Everything durable in this app lives here — the history of found mints and
 * the generated accounts alike — so the storage decision is made once, in one
 * place, from the environment:
 *
 *   redis   — Upstash / Vercel KV over its REST API. Durable and shared across
 *             serverless instances. Selected automatically when Vercel KV is
 *             attached, because that integration injects the two variables
 *             below; no code change is needed to upgrade to it.
 *   file    — a JSON file per namespace, for a persistent host (`npm run serve`).
 *   memory  — a process-local map. Survives nothing, but means the app works
 *             out of the box rather than erroring until storage exists.
 *
 * REST rather than a TCP redis client on purpose: serverless functions are
 * short lived, so a connection pool would be re-established per invocation and
 * a plain HTTP request is both simpler and no slower here.
 */

export type StoreKind = 'redis' | 'file' | 'memory';

/** One namespace: a string-keyed hash of JSON values. */
export interface KvHash {
  readonly kind: StoreKind;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  /** Every entry, as [key, value] pairs. */
  entries(): Promise<Array<[string, string]>>;
  size(): Promise<number>;
  clear(): Promise<void>;
}

class MemoryHash implements KvHash {
  readonly kind = 'memory' as const;
  private readonly rows = new Map<string, string>();

  async get(key: string): Promise<string | undefined> { return this.rows.get(key); }
  async set(key: string, value: string): Promise<void> { this.rows.set(key, value); }
  async delete(keys: string[]): Promise<void> { for (const k of keys) this.rows.delete(k); }
  async entries(): Promise<Array<[string, string]>> { return [...this.rows]; }
  async size(): Promise<number> { return this.rows.size; }
  async clear(): Promise<void> { this.rows.clear(); }
}

class FileHash implements KvHash {
  readonly kind = 'file' as const;
  /**
   * Writes are chained rather than run in parallel. A set is a read-modify-
   * write of one file, so two overlapping writes would each read the pre-write
   * state and the second would silently drop the first. A hunt round records
   * several findings at once, so this is the normal case, not an edge case.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // Keep the chain alive after a failed write; the caller still sees the error.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      // Missing or corrupt file is an empty namespace, not an error.
      return {};
    }
  }

  private async write(rows: Record<string, string>): Promise<void> {
    // Owner-only, because the accounts namespace lands here too and its rows
    // carry sealed wallet keys. Sealed is not a reason to hand them to every
    // account on a shared VPS. The mode applies when the file is created, so a
    // data directory that predates this keeps its old permissions — the VPS
    // setup script tightens those.
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(rows), { encoding: 'utf8', mode: 0o600 });
  }

  async get(key: string): Promise<string | undefined> { return (await this.read())[key]; }

  async set(key: string, value: string): Promise<void> {
    await this.serialize(async () => {
      const rows = await this.read();
      rows[key] = value;
      await this.write(rows);
    });
  }

  async delete(keys: string[]): Promise<void> {
    await this.serialize(async () => {
      const rows = await this.read();
      for (const k of keys) delete rows[k];
      await this.write(rows);
    });
  }

  async entries(): Promise<Array<[string, string]>> {
    return Object.entries(await this.read());
  }

  async size(): Promise<number> { return Object.keys(await this.read()).length; }

  async clear(): Promise<void> {
    await this.serialize(() => this.write({}));
  }
}

class RedisHash implements KvHash {
  readonly kind = 'redis' as const;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly key: string,
    /** Seconds before the namespace expires, refreshed on every write. */
    private readonly ttlSec = 60 * 60 * 24 * 30,
  ) {}

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

  async get(key: string): Promise<string | undefined> {
    return (await this.command<string | null>(['HGET', this.key, key])) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.command(['HSET', this.key, key, value]);
    if (this.ttlSec > 0) await this.command(['EXPIRE', this.key, this.ttlSec]);
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.command(['HDEL', this.key, ...keys]);
  }

  async entries(): Promise<Array<[string, string]>> {
    const flat = (await this.command<string[]>(['HGETALL', this.key])) ?? [];
    const rows: Array<[string, string]> = [];
    // HGETALL returns [field, value, field, value, …].
    for (let i = 0; i + 1 < flat.length; i += 2) rows.push([flat[i], flat[i + 1]]);
    return rows;
  }

  async size(): Promise<number> {
    return (await this.command<number>(['HLEN', this.key])) ?? 0;
  }

  async clear(): Promise<void> {
    await this.command(['DEL', this.key]);
  }
}

const cache = new Map<string, KvHash>();

/**
 * Open a namespace, reusing the driver already chosen for it.
 *
 * Vercel KV injects KV_REST_API_URL and KV_REST_API_TOKEN when the integration
 * is added, so attaching it is the whole upgrade path from memory to durable.
 *
 * `ttlSec` applies to the redis driver only, and 0 means never expire — right
 * for accounts, whose keys hold funds, and wrong for a rolling history.
 */
export function openHash(
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
  ttlSec = 60 * 60 * 24 * 30,
): KvHash {
  const cached = cache.get(namespace);
  if (cached) return cached;

  const url = env.KV_REST_API_URL?.trim() || env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.KV_REST_API_TOKEN?.trim() || env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const prefix = env.KV_KEY_PREFIX?.trim() || env.FINDINGS_KEY_PREFIX?.trim() || 'nftmint';

  let hash: KvHash;
  if (url && token) {
    hash = new RedisHash(url, token, `${prefix}:${namespace}`, ttlSec);
  } else if (env.DATA_DIR?.trim()) {
    hash = new FileHash(path.join(env.DATA_DIR.trim(), `${namespace}.json`));
  } else if (namespace === 'findings' && env.FINDINGS_FILE?.trim()) {
    // Kept so an existing FINDINGS_FILE deployment does not lose its history.
    hash = new FileHash(env.FINDINGS_FILE.trim());
  } else {
    hash = new MemoryHash();
  }

  cache.set(namespace, hash);
  return hash;
}

/** Drop every cached driver. For tests, and after changing the environment. */
export function resetKv(): void {
  cache.clear();
}
