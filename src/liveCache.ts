import { openHash } from './kv.js';
import { log } from './logger.js';
import type { LiveMint } from './live.js';

/**
 * The calldata behind each row on the live board.
 *
 * The board already discovered, for every collection it shows, a transaction
 * that mints it successfully. Without somewhere to put that, pressing Mint on a
 * row would have to re-open the sequencer feed and wait for the same collection
 * to come round again — twenty seconds to rediscover something the previous
 * request had in hand.
 *
 * Short-lived on purpose. Calldata is only worth replaying while the drop is
 * still running, and a stale entry would send a mint at a sale that closed.
 */

const NAMESPACE = 'live';
/** Long enough to press a button, short enough that nothing goes stale. */
const TTL_SEC = 15 * 60;

export interface CachedMint {
  contract: string;
  name?: string;
  entrypoint?: string;
  sampleCalldata?: string;
  sampleRaw?: string;
  priceWei: string;
  maxPerWallet?: string;
  isFree: boolean;
  cachedAt: string;
}

function keyFor(namespace?: string): string {
  return namespace ? `${NAMESPACE}-${namespace}` : NAMESPACE;
}

/** Never throws: a cache miss costs a button press, not a round. */
export async function rememberLiveMints(
  mints: LiveMint[],
  env: NodeJS.ProcessEnv = process.env,
  namespace?: string,
): Promise<void> {
  const hash = openHash(keyFor(namespace), env, TTL_SEC);
  const now = new Date().toISOString();
  try {
    await Promise.all(
      mints
        .filter((m) => m.sampleCalldata)
        .map((m) =>
          hash.set(
            m.contract.toLowerCase(),
            JSON.stringify({
              contract: m.contract,
              name: m.name,
              entrypoint: m.entrypoint,
              sampleCalldata: m.sampleCalldata,
              sampleRaw: m.sampleRaw,
              priceWei: m.priceWei,
              maxPerWallet: m.maxPerWallet,
              isFree: m.isFree,
              cachedAt: now,
            } satisfies CachedMint),
          ),
        ),
    );
  } catch (err) {
    log.warn('could not cache live mints', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Cache one row. Split out so a single mint can be seeded without a board. */
export async function rememberLiveMint(
  mint: Omit<CachedMint, 'cachedAt'>,
  env: NodeJS.ProcessEnv = process.env,
  namespace?: string,
): Promise<void> {
  await openHash(keyFor(namespace), env, TTL_SEC).set(
    mint.contract.toLowerCase(),
    JSON.stringify({ ...mint, cachedAt: new Date().toISOString() } satisfies CachedMint),
  );
}

export async function recallLiveMint(
  contract: string,
  env: NodeJS.ProcessEnv = process.env,
  namespace?: string,
): Promise<CachedMint | undefined> {
  try {
    const raw = await openHash(keyFor(namespace), env, TTL_SEC).get(contract.toLowerCase());
    if (!raw) return undefined;
    return JSON.parse(raw) as CachedMint;
  } catch {
    return undefined;
  }
}
