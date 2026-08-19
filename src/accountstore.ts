import { openHash } from './kv.js';
import { tokenMatches, AccountError, type Account } from './accounts.js';

/**
 * Where accounts live.
 *
 * Same three drivers as everything else, with one deliberate difference: no
 * expiry. The findings history is a rolling log and ages out; an account holds
 * wallets that may hold funds, and quietly expiring those would be losing
 * someone's money on a timer.
 *
 * That also means memory storage is genuinely dangerous here rather than merely
 * inconvenient — a restart loses the keys and strands anything funded. Callers
 * surface that; `accountsAreDurable` exists so the UI can refuse to look
 * reassuring about it.
 */

const NAMESPACE = 'accounts';
/** Never expire: these hold spendable keys. */
const NO_EXPIRY = 0;

export function accountsAreDurable(env: NodeJS.ProcessEnv = process.env): boolean {
  return openHash(NAMESPACE, env, NO_EXPIRY).kind !== 'memory';
}

export function accountStorageKind(env: NodeJS.ProcessEnv = process.env): string {
  return openHash(NAMESPACE, env, NO_EXPIRY).kind;
}

export async function saveAccount(
  account: Account,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await openHash(NAMESPACE, env, NO_EXPIRY).set(account.id, JSON.stringify(account));
}

export async function loadAccount(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Account | undefined> {
  const raw = await openHash(NAMESPACE, env, NO_EXPIRY).get(id);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Account;
  } catch {
    return undefined;
  }
}

export async function listAccounts(env: NodeJS.ProcessEnv = process.env): Promise<Account[]> {
  const rows: Account[] = [];
  for (const [, value] of await openHash(NAMESPACE, env, NO_EXPIRY).entries()) {
    try {
      rows.push(JSON.parse(value) as Account);
    } catch {
      /* skip a corrupt row rather than failing the whole listing */
    }
  }
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Resolve the account behind an `x-account-id` / `x-account-token` pair.
 *
 * Both a missing account and a wrong token give the same message on purpose:
 * telling them apart would turn this into an oracle for which account ids
 * exist.
 */
export async function authenticateAccount(
  id: string | undefined,
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Account> {
  const denied = new AccountError(
    'That account id and key do not match. Check the key you saved at sign-up.',
  );
  if (!id?.trim() || !token?.trim()) {
    throw new AccountError(
      'Sign in first: send your account id and key as x-account-id and x-account-token.',
    );
  }

  const account = await loadAccount(id.trim(), env);
  if (!account) throw denied;
  if (!tokenMatches(token.trim(), account.tokenHash)) throw denied;
  return account;
}
