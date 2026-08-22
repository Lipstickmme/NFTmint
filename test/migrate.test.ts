import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccount, encryptionKey, unseal } from '../src/accounts.js';
import { saveAccount, listAccounts } from '../src/accountstore.js';
import { resetKv } from '../src/kv.js';
import { recordFinding, getStore, resetStore } from '../src/store.js';
import type { Finding } from '../src/findings.js';
import {
  checkEncryptionKey,
  describeBackup,
  discoverNamespaces,
  exportData,
  importData,
  parseBackup,
} from '../src/migrate.js';

/**
 * Moving hosts without losing anything.
 *
 * This exists because the app is about to change hands twice — a new GitHub
 * account and a new Vercel account — and the parts that cannot be re-created
 * are the generated wallets and the history of what the chain did. Wallets can
 * hold funds, so the failure that matters is not "the import errored" but "the
 * import looked fine and the wallets no longer open".
 *
 * So the cases here are the ones that would cost something: per-account
 * namespaces have to be found without being named, sealed keys have to survive
 * the round trip, a destination holding a different encryption key has to be
 * caught before anything is written, and a re-run must not undo work done on
 * the new host in between.
 */

const KEY = 'a'.repeat(64);

let oldDir: string;
let newDir: string;
let source: NodeJS.ProcessEnv;
let destination: NodeJS.ProcessEnv;

beforeEach(async () => {
  oldDir = await mkdtemp(path.join(tmpdir(), 'nftmint-old-'));
  newDir = await mkdtemp(path.join(tmpdir(), 'nftmint-new-'));
  source = { DATA_DIR: oldDir, ACCOUNT_ENCRYPTION_KEY: KEY };
  destination = { DATA_DIR: newDir, ACCOUNT_ENCRYPTION_KEY: KEY };
  resetKv();
});

afterEach(async () => {
  resetStore();
  await rm(oldDir, { recursive: true, force: true });
  await rm(newDir, { recursive: true, force: true });
});

function finding(contract: string): Finding {
  return {
    contract,
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-01T00:01:00.000Z',
    timesSeen: 1,
    passed: true,
    failed: [],
    score: 91,
  } as Finding;
}

/** One account plus a finding of its own, in the source environment. */
async function seedSource(): Promise<{ id: string; address: string }> {
  const created = createAccount(source);
  await saveAccount(created.account, source);
  await recordFinding(finding('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), source, created.account.id);
  await recordFinding(finding('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), source);
  resetKv();
  resetStore();
  return { id: created.account.id, address: created.account.wallets[0].address };
}

describe('discovering what there is to move', () => {
  it('finds a per-account findings namespace without being told the id', async () => {
    const { id } = await seedSource();

    const names = await discoverNamespaces(source);

    expect(names).toContain('accounts');
    expect(names).toContain('findings');
    expect(names).toContain(`findings-${id}`);
  });

  it('leaves the live cache behind unless asked for it', async () => {
    const { id } = await seedSource();

    expect(await discoverNamespaces(source)).not.toContain(`live-${id}`);
    expect(await discoverNamespaces(source, { includeLive: true })).toContain(`live-${id}`);
  });

  it('carries the prices the operator set, so they do not revert on the new host', async () => {
    // Pricing lives in the store, not the environment. Left behind, the new
    // host quietly falls back to its own defaults and starts charging a
    // different amount with nobody told.
    const { saveBilling } = await import('../src/billing.js');
    await saveBilling({ feePct: 3, subscriptionEth: '0.02' }, source);
    resetKv();

    const backup = await exportData(source);
    await importData(backup, destination);
    resetKv();

    const { loadBilling } = await import('../src/billing.js');
    const moved = await loadBilling(destination);

    expect(backup.namespaces.settings).toBeDefined();
    expect(moved.feePct).toBe(3);
    expect(moved.subscriptionWei).toBe(10n ** 16n * 2n);
  });

  it('omits namespaces that hold nothing', async () => {
    const backup = await exportData(source);

    expect(backup.namespaces).toEqual({});
    expect(describeBackup(backup)).toEqual([]);
  });
});

describe('the round trip', () => {
  it('carries accounts and both findings histories to the new host', async () => {
    const { id } = await seedSource();

    const backup = await exportData(source);
    const summary = await importData(backup, destination);

    expect(Object.keys(backup.namespaces).sort()).toEqual(
      ['accounts', 'findings', `findings-${id}`].sort(),
    );
    expect(summary.destination).toBe('file');
    expect(summary.written).toBe(3);
    expect(summary.skipped).toBe(0);

    resetKv();
    resetStore();
    const moved = await listAccounts(destination);
    expect(moved.map((a) => a.id)).toEqual([id]);
    expect(await getStore(destination, id).list()).toHaveLength(1);
    expect(await getStore(destination).list()).toHaveLength(1);
  });

  it('keeps a wallet signable on the new host', async () => {
    const { id, address } = await seedSource();

    await importData(await exportData(source), destination);

    resetKv();
    const [moved] = await listAccounts(destination);
    const key = unseal(moved.wallets[0].sealed, encryptionKey(destination));

    expect(moved.id).toBe(id);
    expect(moved.wallets[0].address).toBe(address);
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('lands the imported accounts owner-only on the new host\'s disk', async () => {
    await seedSource();

    await importData(await exportData(source), destination);

    // The move puts sealed wallet keys on a VPS disk for the first time. Sealed
    // is not a reason for every other account on that box to be able to read
    // them and start guessing at the passphrase.
    const { stat } = await import('node:fs/promises');
    const mode = (await stat(path.join(newDir, 'accounts.json'))).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it('moves sealed keys, never plaintext ones', async () => {
    await seedSource();

    const backup = await exportData(source);
    const [account] = Object.values(backup.namespaces.accounts);
    const parsed = JSON.parse(account) as { wallets: Array<{ sealed: string }> };

    // Three base64url parts: iv, auth tag, ciphertext. Nothing key-shaped.
    expect(parsed.wallets[0].sealed.split('.')).toHaveLength(3);
    expect(JSON.stringify(backup)).not.toMatch(/"0x[0-9a-f]{64}"/);
  });
});

describe('not making the move worse', () => {
  it('leaves rows already present at the destination alone', async () => {
    const { id } = await seedSource();
    const backup = await exportData(source);
    await importData(backup, destination);

    // The new host is in use: the account turns auto-mint off after the move.
    resetKv();
    const [moved] = await listAccounts(destination);
    await saveAccount({ ...moved, autoMint: false }, destination);
    resetKv();

    const second = await importData(backup, destination);

    expect(second.written).toBe(0);
    expect(second.skipped).toBe(3);
    resetKv();
    const after = await listAccounts(destination);
    expect(after[0].id).toBe(id);
    expect(after[0].autoMint).toBe(false);
  });

  it('replaces them when the move is being redone deliberately', async () => {
    await seedSource();
    const backup = await exportData(source);
    await importData(backup, destination);

    resetKv();
    const [moved] = await listAccounts(destination);
    await saveAccount({ ...moved, autoMint: false }, destination);
    resetKv();

    const second = await importData(backup, destination, { overwrite: true });

    expect(second.written).toBe(3);
    resetKv();
    expect((await listAccounts(destination))[0].autoMint).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    await seedSource();

    const summary = await importData(await exportData(source), destination, { dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.written).toBe(3);
    resetKv();
    expect(await listAccounts(destination)).toEqual([]);
  });
});

describe('the encryption key', () => {
  it('accepts a destination that can open the wallets', async () => {
    await seedSource();

    const check = checkEncryptionKey(await exportData(source), destination);

    expect(check).toMatchObject({ status: 'ok', accounts: 1, wallets: 10 });
  });

  it('catches a destination holding a different key', async () => {
    await seedSource();

    const check = checkEncryptionKey(await exportData(source), {
      ...destination,
      ACCOUNT_ENCRYPTION_KEY: 'b'.repeat(64),
    });

    expect(check.status).toBe('wrong-key');
    if (check.status === 'wrong-key') {
      expect(check.reason).toMatch(/does not open these wallets/);
    }
  });

  it('catches a destination with no key at all', async () => {
    await seedSource();

    const check = checkEncryptionKey(await exportData(source), { DATA_DIR: newDir });

    expect(check.status).toBe('no-key');
  });

  it('says nothing about keys when the backup carries no accounts', async () => {
    await recordFinding(finding('0xcccccccccccccccccccccccccccccccccccccccc'), source);
    resetKv();
    resetStore();

    const check = checkEncryptionKey(await exportData(source), destination);

    expect(check.status).toBe('no-accounts');
  });
});

describe('reading a backup file', () => {
  it('refuses a file that is not a backup', () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/not an nftmint backup/);
    expect(() => parseBackup('not json at all')).toThrow(/not valid JSON/);
  });

  it('refuses a format from a future build rather than guessing', () => {
    expect(() =>
      parseBackup(JSON.stringify({ format: 'nftmint-backup', version: 2, namespaces: {} })),
    ).toThrow(/unsupported backup version 2/);
  });

  it('refuses rows that are not strings, before writing any of them', () => {
    expect(() =>
      parseBackup(
        JSON.stringify({
          format: 'nftmint-backup',
          version: 1,
          namespaces: { accounts: { a1: { not: 'a string' } } },
        }),
      ),
    ).toThrow(/accounts\/a1 is not a string/);
  });

  it('reads back what export wrote', async () => {
    await seedSource();
    const file = path.join(newDir, 'backup.json');
    const backup = await exportData(source);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(backup), 'utf8');

    expect(parseBackup(await readFile(file, 'utf8'))).toEqual(backup);
  });
});
