import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

/**
 * User accounts: a bundle of generated mint wallets, held for auto-minting.
 *
 * Be clear about what this is, because it decides how it has to be built. To
 * mint on a user's behalf while they are not watching, the server must hold
 * keys that can spend. That makes this custodial: whoever controls the host
 * and ACCOUNT_ENCRYPTION_KEY can move anything those wallets hold.
 *
 * So the design keeps the blast radius small rather than pretending it is
 * zero:
 *
 *   - Keys are generated per account and never reused across accounts.
 *   - They are sealed with AES-256-GCM under a server key that lives only in
 *     the environment, so a dump of the database alone is not enough.
 *   - The account token is stored only as a hash, so the same dump cannot be
 *     replayed against the API.
 *   - Wallets are meant to hold gas money and nothing else. The UI says so.
 *
 * Ten wallets by default because per-wallet mint limits are the norm: ten
 * funded wallets is ten mints where one wallet is one.
 */

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError'; // handled as a 400 by the route wrapper
  }
}

/** How many mint wallets a new account gets. */
export const WALLETS_PER_ACCOUNT = 10;

/** A single generated wallet, as stored. */
export interface StoredWallet {
  address: Address;
  /** AES-256-GCM sealed private key. Never the key itself. */
  sealed: string;
}

export interface Account {
  id: string;
  createdAt: string;
  /** SHA-256 of the access token. The token itself is shown once, at signup. */
  tokenHash: string;
  wallets: StoredWallet[];
  /** The user's own RPC endpoint, when they set one. */
  rpcUrl?: string;
  /** Auto-mint on or off for this account. */
  autoMint: boolean;
}

/** What the API returns: never a sealed blob, never a private key. */
export interface AccountView {
  id: string;
  createdAt: string;
  walletCount: number;
  addresses: Address[];
  rpcUrl?: string;
  autoMint: boolean;
}

export function toView(account: Account): AccountView {
  return {
    id: account.id,
    createdAt: account.createdAt,
    walletCount: account.wallets.length,
    addresses: account.wallets.map((w) => w.address),
    rpcUrl: account.rpcUrl,
    autoMint: account.autoMint,
  };
}

/**
 * The 32-byte key everything is sealed under.
 *
 * Required rather than defaulted. A generated default would be a key that
 * changes on every deploy — every stored wallet would become unopenable, and
 * anything funded in them would be stranded. Failing loudly at setup is much
 * kinder than losing funds quietly later.
 */
export function encryptionKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.ACCOUNT_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new AccountError(
      'ACCOUNT_ENCRYPTION_KEY is not set, so generated wallets cannot be sealed. ' +
        'Generate one with: openssl rand -hex 32 — then set it in your environment ' +
        'and never change it, or every existing wallet becomes unopenable.',
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'utf8');
  if (key.length < 32) {
    throw new AccountError(
      'ACCOUNT_ENCRYPTION_KEY is too short. Use 32 bytes — openssl rand -hex 32.',
    );
  }
  // Longer inputs are folded to exactly 32 bytes rather than truncated, so no
  // part of a long passphrase is silently ignored.
  return key.length === 32 ? key : createHash('sha256').update(key).digest();
}

/** Seal a private key. Output is `iv.tag.ciphertext`, all base64url. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function unseal(sealed: string, key: Buffer): string {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new AccountError('stored key is malformed');
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // A wrong key fails the auth tag here rather than returning garbage.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenMatches(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(provided), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A short, unambiguous account id. No l/1/O/0 confusion when read aloud. */
function shortId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(10);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export interface NewAccount {
  account: Account;
  /** Shown once. Only its hash is stored. */
  token: string;
}

export function createAccount(
  env: NodeJS.ProcessEnv = process.env,
  walletCount = WALLETS_PER_ACCOUNT,
): NewAccount {
  const key = encryptionKey(env);
  const count = Math.max(1, Math.min(50, walletCount));

  const wallets: StoredWallet[] = [];
  for (let i = 0; i < count; i += 1) {
    const privateKey = generatePrivateKey();
    wallets.push({
      address: privateKeyToAccount(privateKey).address,
      sealed: seal(privateKey, key),
    });
  }

  const token = randomBytes(24).toString('base64url');
  return {
    token,
    account: {
      id: shortId(),
      createdAt: new Date().toISOString(),
      tokenHash: hashToken(token),
      wallets,
      autoMint: true,
    },
  };
}

/** Open every wallet. Only for the reveal route and the mint path. */
export function privateKeysOf(
  account: Account,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ address: Address; privateKey: Hex }> {
  const key = encryptionKey(env);
  return account.wallets.map((w) => ({
    address: w.address,
    privateKey: unseal(w.sealed, key) as Hex,
  }));
}

/**
 * Validate a user-supplied RPC endpoint.
 *
 * The server will make requests to whatever goes in here, so it is an SSRF
 * surface: without this, an account could point the bot at a cloud metadata
 * endpoint or an internal service and read the response through an error
 * message.
 */
export function normalizeRpcUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AccountError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AccountError('An RPC URL must start with https:// (or http:// for a local node).');
  }

  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^0\./.test(host);

  if (blocked) {
    throw new AccountError(
      'That address is on a private or loopback network, which the server will not ' +
        'call on your behalf. Use a public RPC endpoint.',
    );
  }
  return url.toString();
}
