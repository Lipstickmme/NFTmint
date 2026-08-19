import { mergeFinding, type Finding } from './findings.js';
import { openHash, resetKv, type KvHash, type StoreKind } from './kv.js';
import { log } from './logger.js';

/**
 * Storage for found collections.
 *
 * A thin layer over one KV namespace: records are keyed by contract so a
 * collection seen across many rounds stays one row instead of burying the list
 * in duplicates, and the list is capped and sorted newest first.
 *
 * Every write is fail-soft. A hunt round must never abort because a history
 * write failed — losing a log entry is a far smaller problem than losing the
 * mint the round was there to make.
 */

export interface FindingStore {
  readonly kind: StoreKind;
  /** Insert one finding, or fold it into an existing row as a new sighting. */
  put(finding: Finding): Promise<void>;
  /**
   * Overwrite a row without treating it as a sighting.
   *
   * Needed because `put` counts rounds: enriching a record with a price it did
   * not have would otherwise inflate `timesSeen` every time the list is read.
   */
  update(finding: Finding): Promise<void>;
  /** Most recently seen first. */
  list(limit?: number): Promise<Finding[]>;
  clear(): Promise<void>;
}

const MAX_RECORDS = 200;

/** Newest first, capped. */
function sortAndCap(items: Finding[], limit: number): Finding[] {
  return items
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, limit);
}

class HashFindingStore implements FindingStore {
  constructor(private readonly hash: KvHash) {}

  get kind(): StoreKind { return this.hash.kind; }

  private async readAll(): Promise<Finding[]> {
    const rows: Finding[] = [];
    for (const [, value] of await this.hash.entries()) {
      try {
        rows.push(JSON.parse(value) as Finding);
      } catch {
        /* skip a corrupt row rather than failing the whole listing */
      }
    }
    return sortAndCap(rows, rows.length);
  }

  async put(finding: Finding): Promise<void> {
    const raw = await this.hash.get(finding.contract);
    let next = finding;
    if (raw) {
      try {
        next = mergeFinding(JSON.parse(raw) as Finding, finding);
      } catch {
        /* unreadable row is replaced rather than merged */
      }
    }
    await this.hash.set(finding.contract, JSON.stringify(next));

    // The redis expiry is refreshed on every write, so it only ever cleans up
    // after a bot that has stopped. A bot that keeps running needs the cap too.
    if ((await this.hash.size()) > MAX_RECORDS) {
      const stale = (await this.readAll()).slice(MAX_RECORDS);
      if (stale.length > 0) await this.hash.delete(stale.map((r) => r.contract));
    }
  }

  async update(finding: Finding): Promise<void> {
    await this.hash.set(finding.contract, JSON.stringify(finding));
  }

  async list(limit = 100): Promise<Finding[]> {
    return (await this.readAll()).slice(0, limit);
  }

  async clear(): Promise<void> {
    await this.hash.clear();
  }
}

/**
 * @param namespace keeps one account's history out of another's. What the
 * chain was doing is shared, but the outcome of a mint — which wallets tried,
 * which transactions landed — belongs to the account that made it.
 */
export function getStore(
  env: NodeJS.ProcessEnv = process.env,
  namespace?: string,
): FindingStore {
  return new HashFindingStore(
    openHash(namespace ? `findings-${namespace}` : 'findings', env),
  );
}

/** Drop the cached driver. For tests, and after changing the environment. */
export function resetStore(): void {
  resetKv();
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
  namespace?: string,
): Promise<void> {
  try {
    await getStore(env, namespace).put(finding);
  } catch (err) {
    log.warn('could not record finding', {
      contract: finding.contract,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
