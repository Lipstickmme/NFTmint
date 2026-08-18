import { keccak256, type Address, type Hex } from 'viem';
import { buildCalldata } from './calldata.js';
import { encodeRpcBody } from './rpc.js';
import type { NonceManager, Wallet } from './wallet.js';
import type { BotConfig, GasConfig, MintCallConfig } from './config.js';

/**
 * Pre-signing: the single most important optimization for a FCFS chain.
 *
 * Robinhood Chain orders by arrival time at the sequencer, and Timeboost is not
 * enabled, so no amount of fee can move a transaction ahead of one that
 * arrived earlier. That makes the mint a pure latency race, and every
 * microsecond spent after the start signal is a microsecond of lost ground.
 *
 * So everything is hoisted out of the critical section and done in advance:
 *
 *   calldata encoding  -> done here
 *   nonce resolution   -> done here (locally allocated, no RPC round trip)
 *   gas limit          -> done here (from preflight simulation, never estimated live)
 *   ECDSA signing      -> done here (~1ms of elliptic-curve math, far too slow to do live)
 *   JSON-RPC framing   -> done here (body pre-serialized to a string)
 *
 * What remains at fire time is a socket write of an already-built string.
 */

export interface PreparedTx {
  wallet: Wallet;
  from: Address;
  to: Address;
  nonce: number;
  value: bigint;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** RLP-encoded signed transaction. */
  serialized: Hex;
  /** Transaction hash, derivable before broadcast because the tx is signed. */
  hash: Hex;
  /**
   * Fully framed `eth_sendRawTransaction` request body. Written straight to
   * the socket at fire time with no further processing.
   */
  rpcBody: string;
}

export interface PresignParams {
  config: BotConfig;
  wallets: Wallet[];
  nonces: NonceManager;
  /** Resolved gas limit; preflight must have determined this already. */
  gasLimit: bigint;
}

/**
 * Build and sign the full transaction set.
 *
 * Transactions for a single wallet occupy consecutive nonces, so the sequencer
 * can only execute them in that order — nonce N+1 is invalid until N lands.
 * Spreading across multiple wallets is what actually buys parallelism, since
 * each wallet has an independent nonce sequence.
 */
export async function presignAll(params: PresignParams): Promise<PreparedTx[]> {
  const { config, wallets, nonces, gasLimit } = params;
  const prepared: PreparedTx[] = [];

  for (const wallet of wallets) {
    for (let i = 0; i < config.txPerWallet; i++) {
      const nonce = nonces.allocate(wallet.address);
      prepared.push(
        await signOne({
          wallet,
          nonce,
          gasLimit,
          config,
        }),
      );
    }
  }

  return prepared;
}

/**
 * The slice of configuration signing actually needs.
 *
 * Narrower than BotConfig on purpose: auto-hunt chooses its contract per
 * candidate and has no mint config of its own, so demanding the whole thing
 * forced it to fabricate placeholder values. `BotConfig` still satisfies this
 * structurally, so every existing caller is unaffected.
 */
export interface SigningConfig {
  chainId: number;
  gas: Pick<GasConfig, 'maxFeePerGas' | 'maxPriorityFeePerGas'>;
  mint: MintCallConfig;
}

interface SignOneParams {
  wallet: Wallet;
  nonce: number;
  gasLimit: bigint;
  config: SigningConfig;
}

export async function signOne(params: SignOneParams): Promise<PreparedTx> {
  const { wallet, nonce, gasLimit, config } = params;

  const data = buildCalldata({
    rawCalldata: config.mint.rawCalldata,
    functionSignature: config.mint.functionSignature,
    args: config.mint.args,
    sender: wallet.address,
  });

  const request = {
    to: config.mint.contract,
    value: config.mint.value,
    data,
    nonce,
    gas: gasLimit,
    maxFeePerGas: config.gas.maxFeePerGas,
    maxPriorityFeePerGas: config.gas.maxPriorityFeePerGas,
    chainId: config.chainId,
    type: 'eip1559',
  } as const;

  const serialized = await wallet.account.signTransaction(request);

  // A signed transaction's hash is fully determined before broadcast, so we can
  // record and track it without waiting for the node to echo one back.
  const hash = keccak256(serialized);

  return {
    wallet,
    from: wallet.address,
    to: config.mint.contract,
    nonce,
    value: config.mint.value,
    data,
    gas: gasLimit,
    maxFeePerGas: config.gas.maxFeePerGas,
    maxPriorityFeePerGas: config.gas.maxPriorityFeePerGas,
    serialized,
    hash,
    rpcBody: encodeRpcBody('eth_sendRawTransaction', [serialized]),
  };
}

/** Total worst-case ETH committed if every transaction lands and burns full gas. */
export function totalCommitment(txs: PreparedTx[]): bigint {
  return txs.reduce((sum, tx) => sum + tx.value + tx.gas * tx.maxFeePerGas, 0n);
}

export function summarize(txs: PreparedTx[]): Record<string, unknown> {
  const wallets = new Set(txs.map((t) => t.from));
  return {
    transactions: txs.length,
    wallets: wallets.size,
    gasLimit: txs[0]?.gas,
    maxFeePerGas: txs[0]?.maxFeePerGas,
    maxCommitmentWei: totalCommitment(txs),
  };
}
