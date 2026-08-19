import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createAccount,
  encryptionKey,
  hashToken,
  normalizeRpcUrl,
  privateKeysOf,
  seal,
  tokenMatches,
  toView,
  unseal,
  WALLETS_PER_ACCOUNT,
} from '../src/accounts.js';
import {
  accountsAreDurable,
  authenticateAccount,
  listAccounts,
  loadAccount,
  saveAccount,
} from '../src/accountstore.js';
import { resetKv } from '../src/kv.js';
import { resetRateLimits } from '../src/ratelimit.js';
import accountHandler from '../api/account.js';
import type { ApiRequest, ApiResponse } from '../src/http.js';

/**
 * Generated wallets.
 *
 * This is the part of the app that holds spendable keys, so the tests here are
 * about the properties that keep that survivable: a key never round-trips into
 * something that cannot spend, a key never lands on disk in the clear, an
 * account token cannot be recovered from what is stored, and an account can
 * never be talked into pointing the server at a private network.
 */

const KEY32 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('encryption key', () => {
  it('refuses to run without one', () => {
    // A generated default would change on every deploy, and every wallet sealed
    // under the old one would become unopenable — funds stranded, silently.
    expect(() => encryptionKey({} as NodeJS.ProcessEnv)).toThrow(/ACCOUNT_ENCRYPTION_KEY/);
  });

  it('rejects a key too short to be worth having', () => {
    expect(() => encryptionKey({ ACCOUNT_ENCRYPTION_KEY: 'short' } as NodeJS.ProcessEnv))
      .toThrow(/too short/);
  });

  it('accepts 32 bytes of hex', () => {
    expect(encryptionKey({ ACCOUNT_ENCRYPTION_KEY: KEY32 } as NodeJS.ProcessEnv)).toHaveLength(32);
  });

  it('folds a long passphrase rather than truncating it', () => {
    // Truncating would silently ignore everything past the 32nd byte, so two
    // different long passphrases could seal to the same key.
    const a = encryptionKey({ ACCOUNT_ENCRYPTION_KEY: 'x'.repeat(80) } as NodeJS.ProcessEnv);
    const b = encryptionKey({ ACCOUNT_ENCRYPTION_KEY: 'x'.repeat(80) + 'y' } as NodeJS.ProcessEnv);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe('sealing', () => {
  const key = encryptionKey({ ACCOUNT_ENCRYPTION_KEY: KEY32 } as NodeJS.ProcessEnv);

  it('round-trips', () => {
    expect(unseal(seal('hello', key), key)).toBe('hello');
  });

  it('never repeats a ciphertext for the same input', () => {
    // A fresh IV per seal, so equal wallets do not produce equal blobs and
    // reveal that they are equal.
    expect(seal('hello', key)).not.toBe(seal('hello', key));
  });

  it('fails loudly under the wrong key rather than returning garbage', () => {
    const other = encryptionKey({ ACCOUNT_ENCRYPTION_KEY: 'f'.repeat(64) } as NodeJS.ProcessEnv);
    expect(() => unseal(seal('hello', key), other)).toThrow();
  });

  it('detects a tampered ciphertext', () => {
    // GCM's auth tag is the point: without it a flipped bit would decrypt to a
    // different, valid-looking private key.
    const sealed = seal('hello', key);
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => unseal(parts.join('.'), key)).toThrow();
  });

  it('rejects a malformed blob', () => {
    expect(() => unseal('nonsense', key)).toThrow(/malformed/);
  });
});

describe('account tokens', () => {
  it('matches the right token', () => {
    expect(tokenMatches('secret', hashToken('secret'))).toBe(true);
  });

  it('rejects the wrong one', () => {
    expect(tokenMatches('guess', hashToken('secret'))).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    expect(tokenMatches('secret', 'not-a-hash')).toBe(false);
  });
});

describe('createAccount', () => {
  const env = { ACCOUNT_ENCRYPTION_KEY: KEY32 } as NodeJS.ProcessEnv;

  it('generates ten distinct wallets', () => {
    // Ten because per-wallet mint limits are the norm: ten funded wallets is
    // ten mints where one wallet is one.
    const { account } = createAccount(env);
    expect(account.wallets).toHaveLength(WALLETS_PER_ACCOUNT);
    expect(new Set(account.wallets.map((w) => w.address)).size).toBe(WALLETS_PER_ACCOUNT);
  });

  it('never reuses keys between accounts', () => {
    const a = createAccount(env).account;
    const b = createAccount(env).account;
    const overlap = a.wallets.filter((w) => b.wallets.some((o) => o.address === w.address));
    expect(overlap).toEqual([]);
  });

  it('stores only a hash of the access token', () => {
    // So a dump of the database cannot be replayed against the API.
    const { account, token } = createAccount(env);
    expect(JSON.stringify(account)).not.toContain(token);
    expect(tokenMatches(token, account.tokenHash)).toBe(true);
  });

  it('stores no private key in the clear', () => {
    const { account } = createAccount(env);
    const dump = JSON.stringify(account);
    for (const { privateKey } of privateKeysOf(account, env)) {
      expect(dump).not.toContain(privateKey);
    }
  });

  it('opens every key back to the address it was stored under', () => {
    // The property that matters: a key that does not derive its address is a
    // wallet nobody can spend from, and the failure would only show up when a
    // mint silently went nowhere.
    const { account } = createAccount(env);
    for (const { address, privateKey } of privateKeysOf(account, env)) {
      expect(privateKeyToAccount(privateKey).address).toBe(address);
    }
  });

  it('never exposes a sealed blob or a key through the API view', () => {
    const dump = JSON.stringify(toView(createAccount(env).account));
    expect(dump).not.toContain('sealed');
    expect(dump).not.toContain('tokenHash');
  });
});

describe('normalizeRpcUrl', () => {
  it('accepts a public https endpoint', () => {
    expect(normalizeRpcUrl(' https://rpc.example.com/v2/key ')).toBe('https://rpc.example.com/v2/key');
  });

  it('treats empty as clearing the setting', () => {
    expect(normalizeRpcUrl('   ')).toBe('');
  });

  it('rejects anything that is not a URL', () => {
    expect(() => normalizeRpcUrl('rpc.example.com')).toThrow(/valid URL/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => normalizeRpcUrl('file:///etc/passwd')).toThrow(/https/);
  });

  for (const host of [
    'http://127.0.0.1:8545',
    'http://localhost:8545',
    'http://10.0.0.5',
    'http://192.168.1.1',
    'http://172.16.0.1',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal',
  ]) {
    it(`refuses ${host}`, () => {
      // The server fetches whatever goes in here, so without this an account
      // could aim it at a cloud metadata service and read the answer back
      // through an error message.
      expect(() => normalizeRpcUrl(host)).toThrow(/private or loopback/);
    });
  }
});

describe('account storage', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetKv();
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-accounts-'));
    env = { ACCOUNT_ENCRYPTION_KEY: KEY32, DATA_DIR: dir } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    resetKv();
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips an account through the file store', async () => {
    const { account } = createAccount(env);
    await saveAccount(account, env);

    resetKv();
    const loaded = await loadAccount(account.id, env);
    expect(loaded?.wallets).toHaveLength(WALLETS_PER_ACCOUNT);
    expect(privateKeysOf(loaded!, env)[0].address).toBe(account.wallets[0].address);
  });

  it('writes no private key to disk', async () => {
    const { account } = createAccount(env);
    await saveAccount(account, env);

    const onDisk = await readFile(path.join(dir, 'accounts.json'), 'utf8');
    for (const { privateKey } of privateKeysOf(account, env)) {
      expect(onDisk).not.toContain(privateKey);
    }
    // Nothing key-shaped at all, in any encoding we would recognise.
    expect(onDisk).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  it('reports whether accounts survive a restart', async () => {
    expect(accountsAreDurable(env)).toBe(true);
    resetKv();
    // Nothing configured means memory, which strands anything funded.
    expect(accountsAreDurable({ ACCOUNT_ENCRYPTION_KEY: KEY32 } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('lists accounts newest first', async () => {
    const a = createAccount(env).account;
    const b = { ...createAccount(env).account, createdAt: new Date(Date.now() + 5_000).toISOString() };
    await saveAccount(a, env);
    await saveAccount(b, env);
    expect((await listAccounts(env)).map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe('authenticateAccount', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetKv();
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-auth-'));
    env = { ACCOUNT_ENCRYPTION_KEY: KEY32, DATA_DIR: dir } as NodeJS.ProcessEnv;
  });

  afterEach(async () => {
    resetKv();
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves the account behind a matching pair', async () => {
    const { account, token } = createAccount(env);
    await saveAccount(account, env);
    expect((await authenticateAccount(account.id, token, env)).id).toBe(account.id);
  });

  it('gives the same answer for a wrong token and a missing account', async () => {
    // Telling them apart would turn this into an oracle for which ids exist.
    const { account, token } = createAccount(env);
    await saveAccount(account, env);

    const wrongToken = await authenticateAccount(account.id, 'nope', env).catch((e: Error) => e.message);
    const noAccount = await authenticateAccount('doesnotexist', token, env).catch((e: Error) => e.message);
    expect(wrongToken).toBe(noAccount);
  });

  it('asks for credentials when none were sent', async () => {
    await expect(authenticateAccount(undefined, undefined, env)).rejects.toThrow(/Sign in first/);
  });
});

/** Minimal adapter over the deployed route, matching the other API tests. */
async function call(
  init: Partial<ApiRequest> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const res: ApiResponse = {
    status(code) { captured.status = code; return this; },
    setHeader() {},
    send(body) {
      try { captured.body = JSON.parse(body) as Record<string, unknown>; }
      catch { captured.body = { raw: body }; }
    },
  };
  await accountHandler({ method: 'GET', headers: {}, ...init }, res);
  return captured;
}

describe('/api/account', () => {
  let dir: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetRateLimits();
    resetKv();
    saved = { ...process.env };
    dir = await mkdtemp(path.join(tmpdir(), 'nftmint-api-'));
    process.env.ACCOUNT_ENCRYPTION_KEY = KEY32;
    process.env.DATA_DIR = dir;
    process.env.NETWORK = 'testnet';
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.FINDINGS_FILE;
    delete process.env.PRIVATE_KEYS;
  });

  afterEach(async () => {
    process.env = saved;
    resetKv();
    await rm(dir, { recursive: true, force: true });
  });

  it('signs up without any credential and returns the key once', async () => {
    const res = await call({ method: 'POST' });
    expect(res.status).toBe(200);
    expect(String(res.body.token)).not.toBe('');
    expect(res.body.walletCount).toBe(WALLETS_PER_ACCOUNT);
    expect((res.body.addresses as string[])).toHaveLength(WALLETS_PER_ACCOUNT);
    expect(res.body.notice).toMatch(/shown once/i);
  });

  it('persists the account before handing back the key', async () => {
    // Otherwise a dropped response would leave a key for an account that was
    // never written, and the wallets would be unreachable forever.
    const res = await call({ method: 'POST' });
    expect(await loadAccount(String(res.body.id))).toBeDefined();
  });

  it('warns when generated wallets would not survive a restart', async () => {
    delete process.env.DATA_DIR;
    resetKv();
    const res = await call({ method: 'POST' });
    expect(res.body.durable).toBe(false);
    expect(res.body.notice).toMatch(/lost on the next restart/i);
  });

  it('refuses to sign up with no encryption key configured', async () => {
    delete process.env.ACCOUNT_ENCRYPTION_KEY;
    const res = await call({ method: 'POST' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/ACCOUNT_ENCRYPTION_KEY/);
  });

  it('needs credentials to read an account', async () => {
    await call({ method: 'POST' });
    expect((await call()).status).toBe(400);
  });

  it('reveals keys only on an explicit request', async () => {
    const created = await call({ method: 'POST' });
    const auth = {
      'x-account-id': String(created.body.id),
      'x-account-token': String(created.body.token),
    };

    // The ordinary view is fetched on page load, so it must never carry keys.
    const plain = await call({ headers: auth });
    expect(JSON.stringify(plain.body)).not.toMatch(/privateKey/);

    const shown = await call({ headers: auth, url: '/api/account?reveal=1' });
    expect((shown.body.keys as unknown[])).toHaveLength(WALLETS_PER_ACCOUNT);
    expect(String(shown.body.warning)).toMatch(/spend anything/i);
  });

  it('saves a public RPC and refuses a private one', async () => {
    const created = await call({ method: 'POST' });
    const headers = {
      'x-account-id': String(created.body.id),
      'x-account-token': String(created.body.token),
    };

    const ok = await call({ method: 'PATCH', headers, body: { rpcUrl: 'https://rpc.example.com/x' } });
    expect(ok.body.rpcUrl).toBe('https://rpc.example.com/x');

    const bad = await call({
      method: 'PATCH', headers, body: { rpcUrl: 'http://169.254.169.254/latest/meta-data' },
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/private or loopback/);

    // The refused value must not have overwritten the good one.
    expect((await call({ headers })).body.rpcUrl).toBe('https://rpc.example.com/x');
  });

  it('turns auto-mint off and on', async () => {
    const created = await call({ method: 'POST' });
    const headers = {
      'x-account-id': String(created.body.id),
      'x-account-token': String(created.body.token),
    };
    expect((await call({ method: 'PATCH', headers, body: { autoMint: false } })).body.autoMint)
      .toBe(false);
    expect((await call({ headers })).body.autoMint).toBe(false);
  });

  it('refuses a method that is none of those things', async () => {
    expect((await call({ method: 'DELETE' })).status).toBe(405);
  });
});
