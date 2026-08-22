import type { Hex } from 'viem';
import { JsonRpcError, raceSubmit, type RpcClient } from './rpc.js';
import { hot, log } from './logger.js';
import type { PreparedTx } from './presign.js';

/**
 * Broadcast.
 *
 * By the time this runs, every transaction is signed and framed. The only work
 * left is writing bytes, so this module is deliberately free of any encoding,
 * validation, or await-on-network-state.
 *
 * Each transaction is fired at every configured endpoint simultaneously. That
 * is safe because the transaction is signed against a fixed nonce: duplicates
 * are rejected by the node as already-known rather than executed twice. The
 * point is to avoid being held hostage by one slow provider.
 */

export interface SubmitOutcome {
  tx: PreparedTx;
  accepted: boolean;
  /** Hash echoed by the node; should equal the locally computed hash. */
  returnedHash?: Hex;
  endpoint?: string;
  elapsedMs: number;
  error?: string;
  /** True when rejection was "already known", which means it is in fact live. */
  alreadyKnown?: boolean;
}

/**
 * Nodes disagree on wording for a transaction they have already seen. All of
 * these mean the transaction reached the sequencer, so they are successes.
 */
const ALREADY_KNOWN_PATTERNS = [
  'already known',
  'already exists',
  'duplicate transaction',
  'known transaction',
  'nonce too low', // a same-nonce tx already landed
  'transaction already in the pool',
];

function classifyError(message: string): { alreadyKnown: boolean } {
  const lower = message.toLowerCase();
  return { alreadyKnown: ALREADY_KNOWN_PATTERNS.some((p) => lower.includes(p)) };
}

/** Fire one pre-signed transaction at every endpoint and take the first answer. */
export async function submitOne(
  clients: RpcClient[],
  tx: PreparedTx,
): Promise<SubmitOutcome> {
  const started = performance.now();
  hot('submit', { nonce: tx.nonce, from: tx.from });

  const { winner, all } = await raceSubmit(clients, tx.rpcBody);

  // Drain the losing attempts so a late failure is never an unhandled rejection.
  void all.then((results) => {
    for (const r of results) {
      if (r.error) {
        log.debug('secondary endpoint result', {
          endpoint: r.endpoint,
          error: r.error.message,
        });
      }
    }
  });

  const elapsedMs = performance.now() - started;

  if (winner.error) {
    const message =
      winner.error instanceof JsonRpcError
        ? winner.error.message
        : String(winner.error.message ?? winner.error);
    const { alreadyKnown } = classifyError(message);
    hot('submit:result', { nonce: tx.nonce, accepted: alreadyKnown });
    return {
      tx,
      accepted: alreadyKnown,
      alreadyKnown,
      endpoint: winner.endpoint,
      elapsedMs,
      error: message,
    };
  }

  hot('submit:result', { nonce: tx.nonce, accepted: true });
  return {
    tx,
    accepted: true,
    returnedHash: winner.result as Hex,
    endpoint: winner.endpoint,
    elapsedMs,
  };
}

/**
 * Fire the whole batch.
 *
 * Everything goes out concurrently rather than sequentially. Transactions on
 * the same wallet still execute in nonce order once they arrive, but there is
 * no reason to serialize the network writes and hand competitors a head start
 * on the later ones.
 */
export async function submitAll(
  clients: RpcClient[],
  txs: PreparedTx[],
): Promise<SubmitOutcome[]> {
  hot('fire', { count: txs.length });
  return Promise.all(txs.map((tx) => submitOne(clients, tx)));
}

export interface Receipt {
  transactionHash: Hex;
  blockNumber: Hex;
  status: Hex;
  gasUsed: Hex;
  /**
   * What the chain actually charged per unit of gas. Optional because not
   * every node reports it; without it, the fee falls back to the fee that was
   * authorised, which errs high rather than in the operator's favour.
   */
  effectiveGasPrice?: Hex;
}

/**
 * Poll for receipts after the race. Runs well off the hot path, so clarity
 * matters more than speed here.
 */
export async function waitForReceipts(
  client: RpcClient,
  hashes: Hex[],
  timeoutMs = 60_000,
  intervalMs = 300,
): Promise<Map<Hex, Receipt | undefined>> {
  const results = new Map<Hex, Receipt | undefined>();
  const pending = new Set(hashes);
  const deadline = Date.now() + timeoutMs;

  while (pending.size > 0 && Date.now() < deadline) {
    await Promise.all(
      [...pending].map(async (hash) => {
        try {
          const receipt = await client.call<Receipt | null>('eth_getTransactionReceipt', [
            hash,
          ]);
          if (receipt) {
            results.set(hash, receipt);
            pending.delete(hash);
          }
        } catch (err) {
          log.debug('receipt poll failed', {
            hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
    if (pending.size === 0) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  for (const hash of pending) results.set(hash, undefined);
  return results;
}

export function summarizeOutcomes(outcomes: SubmitOutcome[]): Record<string, unknown> {
  const accepted = outcomes.filter((o) => o.accepted).length;
  const times = outcomes.map((o) => o.elapsedMs).sort((a, b) => a - b);
  return {
    submitted: outcomes.length,
    accepted,
    rejected: outcomes.length - accepted,
    fastestMs: times[0]?.toFixed(2),
    slowestMs: times[times.length - 1]?.toFixed(2),
  };
}
