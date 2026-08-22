import { encryptionKey, unseal, type Account } from './accounts.js';
import { openHash, resetKv, type StoreKind } from './kv.js';

/**
 * Moving stored data from one host to another.
 *
 * Everything durable lives in KV namespaces (see kv.ts), and which driver backs
 * them is decided by the environment. That makes a host move a data problem
 * rather than a code problem: read every namespace out of the old environment,
 * write every namespace into the new one. Vercel KV to a file on a VPS, one
 * Upstash database to another, a file back into KV — all the same operation,
 * because both ends are the same interface.
 *
 * Two things this deliberately does not do:
 *
 *   It does not decrypt. Account rows carry private keys sealed under
 *   ACCOUNT_ENCRYPTION_KEY, and they move sealed. The backup file is therefore
 *   useless to anyone who does not also have that key — which is exactly why
 *   the key has to travel separately, and why importing into an environment
 *   with a different key gives you accounts you cannot open.
 *
 *   It does not discover namespaces by scanning the store. The redis driver
 *   could KEYS its way through a shared database, but that would also sweep up
 *   rows belonging to other apps sharing the prefix. Instead the namespace list
 *   is derived from the data itself: accounts first, then one findings
 *   namespace per account, plus the operator's own — and the settings the
 *   operator has changed, which would otherwise silently revert to whatever the
 *   new host's environment happens to say.
 */

/** What a backup file contains. Versioned so a future format can be detected. */
export interface Backup {
  format: 'nftmint-backup';
  version: 1;
  createdAt: string;
  /** Which driver the data came out of. Informational. */
  source: StoreKind;
  /** namespace -> { key -> raw JSON string }, exactly as stored. */
  namespaces: Record<string, Record<string, string>>;
}

export interface ExportOptions {
  /**
   * Include the live-board cache. Off by default: it is a 15-minute cache of
   * what the chain was doing, it rebuilds itself within a minute of the new
   * host starting, and carrying it over would only make a backup bigger and
   * staler.
   */
  includeLive?: boolean;
}

export interface ImportOptions {
  /**
   * Replace rows that already exist at the destination. Off by default, so a
   * re-run of an interrupted import cannot roll back an account that has since
   * been used on the new host.
   */
  overwrite?: boolean;
  /** Report what would be written without writing it. */
  dryRun?: boolean;
}

export interface NamespaceSummary {
  namespace: string;
  written: number;
  skipped: number;
}

export interface ImportSummary {
  destination: StoreKind;
  dryRun: boolean;
  namespaces: NamespaceSummary[];
  written: number;
  skipped: number;
}

/** Accounts never expire; a findings history does. Mirrors the writers. */
const NO_EXPIRY = 0;
const FINDINGS_TTL_SEC = 60 * 60 * 24 * 30;
const LIVE_TTL_SEC = 15 * 60;

function ttlFor(namespace: string): number {
  // Settings and accounts both hold things that must not quietly expire: a
  // price that reverted to the default on a timer would start charging the
  // wrong amount with nobody told.
  if (namespace === 'accounts' || namespace === 'settings') return NO_EXPIRY;
  if (namespace === 'live' || namespace.startsWith('live-')) return LIVE_TTL_SEC;
  return FINDINGS_TTL_SEC;
}

/**
 * Which namespaces hold this deployment's data.
 *
 * Per-account namespaces are named after account ids, so the accounts
 * namespace has to be read before the rest of the list is even known.
 */
export async function discoverNamespaces(
  env: NodeJS.ProcessEnv,
  options: ExportOptions = {},
): Promise<string[]> {
  const names = ['accounts', 'settings', 'findings'];
  if (options.includeLive) names.push('live');

  for (const [id] of await openHash('accounts', env, NO_EXPIRY).entries()) {
    names.push(`findings-${id}`);
    if (options.includeLive) names.push(`live-${id}`);
  }
  return names;
}

/**
 * Read every namespace out of `env`.
 *
 * Drops the cached drivers first: `openHash` remembers which driver it chose
 * for a namespace, so exporting and importing in one process would otherwise
 * read and write the same store no matter which environments were passed.
 */
export async function exportData(
  env: NodeJS.ProcessEnv = process.env,
  options: ExportOptions = {},
): Promise<Backup> {
  resetKv();

  const namespaces: Record<string, Record<string, string>> = {};
  for (const name of await discoverNamespaces(env, options)) {
    const rows = Object.fromEntries(await openHash(name, env, ttlFor(name)).entries());
    // An empty namespace is omitted rather than written as {}: a backup should
    // say what exists, not list every name that was looked for.
    if (Object.keys(rows).length > 0) namespaces[name] = rows;
  }

  return {
    format: 'nftmint-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    source: openHash('accounts', env, NO_EXPIRY).kind,
    namespaces,
  };
}

/** Reject anything that is not a backup before it is written anywhere. */
export function parseBackup(raw: string): Backup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('backup file is not valid JSON');
  }

  const backup = parsed as Partial<Backup>;
  if (backup?.format !== 'nftmint-backup') {
    throw new Error('not an nftmint backup file (missing format marker)');
  }
  if (backup.version !== 1) {
    throw new Error(`unsupported backup version ${String(backup.version)} — this build reads version 1`);
  }
  if (!backup.namespaces || typeof backup.namespaces !== 'object') {
    throw new Error('backup file has no namespaces');
  }

  for (const [name, rows] of Object.entries(backup.namespaces)) {
    if (!rows || typeof rows !== 'object') {
      throw new Error(`namespace ${name} is not an object`);
    }
    for (const [key, value] of Object.entries(rows)) {
      if (typeof value !== 'string') {
        throw new Error(`row ${name}/${key} is not a string`);
      }
    }
  }

  return backup as Backup;
}

/** How many rows a backup carries, per namespace. For a dry run or a report. */
export function describeBackup(backup: Backup): NamespaceSummary[] {
  return Object.entries(backup.namespaces).map(([namespace, rows]) => ({
    namespace,
    written: Object.keys(rows).length,
    skipped: 0,
  }));
}

/**
 * Write a backup into `env`.
 *
 * Rows are written one at a time rather than in a batch on purpose: the redis
 * driver speaks one command per request, and a half-finished import that can be
 * re-run is better than a batch that has to succeed all at once.
 */
export async function importData(
  backup: Backup,
  env: NodeJS.ProcessEnv = process.env,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  resetKv();

  const summaries: NamespaceSummary[] = [];
  for (const [name, rows] of Object.entries(backup.namespaces)) {
    const hash = openHash(name, env, ttlFor(name));
    let written = 0;
    let skipped = 0;

    for (const [key, value] of Object.entries(rows)) {
      if (!options.overwrite && (await hash.get(key)) !== undefined) {
        skipped++;
        continue;
      }
      if (!options.dryRun) await hash.set(key, value);
      written++;
    }
    summaries.push({ namespace: name, written, skipped });
  }

  return {
    destination: openHash('accounts', env, NO_EXPIRY).kind,
    dryRun: options.dryRun === true,
    namespaces: summaries,
    written: summaries.reduce((sum, s) => sum + s.written, 0),
    skipped: summaries.reduce((sum, s) => sum + s.skipped, 0),
  };
}

/**
 * Where a backup would land, in words.
 *
 * `memory` is called out because an import into it succeeds and then vanishes
 * at the end of the process — the one outcome that looks like success and is
 * not.
 */
export function describeDestination(kind: StoreKind): string {
  switch (kind) {
    case 'redis':
      return 'redis/KV (durable, shared across instances)';
    case 'file':
      return 'a file under DATA_DIR (durable for as long as that disk is)';
    case 'memory':
      return 'memory — NOTHING WILL BE SAVED. Set KV_REST_API_URL/KV_REST_API_TOKEN or DATA_DIR first.';
  }
}

export type KeyCheck =
  | { status: 'ok'; accounts: number; wallets: number }
  | { status: 'no-accounts' }
  | { status: 'no-key'; reason: string }
  | { status: 'wrong-key'; reason: string };

/**
 * Can the destination environment actually open the wallets being imported?
 *
 * This is the one migration mistake worth failing loudly over. Moving the rows
 * without moving ACCOUNT_ENCRYPTION_KEY gives you a new host that starts
 * cleanly, lists every account, shows every address — and cannot sign with any
 * of them. Anything funded in those wallets is then stranded, and the import
 * looked like it worked.
 *
 * So: unseal one wallet with the destination's key before anyone trusts the
 * move. AES-GCM authenticates, so a wrong key fails here rather than returning
 * plausible garbage.
 */
export function checkEncryptionKey(backup: Backup, env: NodeJS.ProcessEnv): KeyCheck {
  const rows = Object.values(backup.namespaces.accounts ?? {});
  if (rows.length === 0) return { status: 'no-accounts' };

  let key: Buffer;
  try {
    key = encryptionKey(env);
  } catch (err) {
    return { status: 'no-key', reason: err instanceof Error ? err.message : String(err) };
  }

  let wallets = 0;
  let sample: string | undefined;
  for (const raw of rows) {
    try {
      const account = JSON.parse(raw) as Account;
      wallets += account.wallets?.length ?? 0;
      sample ??= account.wallets?.[0]?.sealed;
    } catch {
      /* a row that will not parse is reported by the import itself */
    }
  }
  if (!sample) return { status: 'no-accounts' };

  try {
    unseal(sample, key);
  } catch (err) {
    return {
      status: 'wrong-key',
      reason:
        'ACCOUNT_ENCRYPTION_KEY at the destination does not open these wallets ' +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        'Copy the key from the old deployment — without it the imported wallets cannot sign.',
    };
  }
  return { status: 'ok', accounts: rows.length, wallets };
}
