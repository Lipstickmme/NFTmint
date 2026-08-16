import {
  decodeErrorResult,
  encodeFunctionData,
  hexToString,
  isHex,
  type Address,
  type Hex,
} from 'viem';
import {
  NODE_INTERFACE_ABI,
  NODE_INTERFACE_ADDRESS,
} from './chain.js';
import { buildCalldata } from './calldata.js';
import { JsonRpcError, type RpcClient } from './rpc.js';
import { log } from './logger.js';
import type { BotConfig } from './config.js';
import type { Wallet } from './wallet.js';

/**
 * Preflight resolves everything the race depends on, and refuses to proceed on
 * a configuration that cannot work.
 *
 * The important subtlety: a mint call simulated BEFORE the sale opens will
 * revert, and that is the normal, expected case for a bot that is waiting for a
 * drop. A revert therefore is not automatically a configuration error — but it
 * does mean the node cannot give us a gas estimate, so the operator has to
 * supply one explicitly. Guessing a gas limit silently would risk every
 * transaction running out of gas at the worst possible moment.
 */

export interface SimulationResult {
  ok: boolean;
  returnData?: Hex;
  revertReason?: string;
  rawError?: string;
}

export interface GasEstimate {
  /** Total gas including the parent-chain data component. */
  total: bigint;
  /** Portion attributable to posting calldata to Ethereum. */
  forL1: bigint;
  /** Portion consumed by L2 execution. */
  forL2: bigint;
  baseFee: bigint;
  l1BaseFeeEstimate: bigint;
  source: 'nodeInterface' | 'estimateGas' | 'configured';
}

export interface PreflightReport {
  chainIdOk: boolean;
  observedChainId: number;
  contractHasCode: boolean;
  simulation: SimulationResult;
  gas: GasEstimate;
  gasLimit: bigint;
  baseFeePerGas?: bigint;
  warnings: string[];
}

/** Decode a Solidity revert payload into something a human can act on. */
export function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data || data === '0x' || !isHex(data)) return undefined;

  // Error(string) — selector 0x08c379a0
  if (data.startsWith('0x08c379a0')) {
    try {
      const decoded = decodeErrorResult({
        abi: [
          {
            type: 'error',
            name: 'Error',
            inputs: [{ name: 'message', type: 'string' }],
          },
        ],
        data,
      });
      return String(decoded.args?.[0] ?? '');
    } catch {
      // Fall through to the raw-string attempt below.
    }
  }

  // Panic(uint256) — selector 0x4e487b71
  if (data.startsWith('0x4e487b71')) {
    const code = data.slice(10);
    return `Panic(0x${BigInt(`0x${code}`).toString(16)})`;
  }

  // Otherwise it is most likely a custom error; surface the selector so the
  // operator can look it up against the contract's ABI.
  if (data.length >= 10) {
    return `custom error ${data.slice(0, 10)}`;
  }

  try {
    return hexToString(data);
  } catch {
    return undefined;
  }
}

function extractRevertData(err: unknown): Hex | undefined {
  if (err instanceof JsonRpcError) {
    const data = err.data;
    if (typeof data === 'string' && isHex(data)) return data;
    if (data && typeof data === 'object') {
      const nested = (data as { data?: unknown }).data;
      if (typeof nested === 'string' && isHex(nested)) return nested;
    }
  }
  return undefined;
}

/** Simulate the mint via `eth_call` from the given wallet. */
export async function simulateMint(
  client: RpcClient,
  config: BotConfig,
  wallet: Wallet,
): Promise<SimulationResult> {
  const data = buildCalldata({
    rawCalldata: config.mint.rawCalldata,
    functionSignature: config.mint.functionSignature,
    args: config.mint.args,
    sender: wallet.address,
  });

  try {
    const result = await client.call<Hex>('eth_call', [
      {
        from: wallet.address,
        to: config.mint.contract,
        data,
        value: `0x${config.mint.value.toString(16)}`,
      },
      'latest',
    ]);
    return { ok: true, returnData: result };
  } catch (err) {
    const revertData = extractRevertData(err);
    return {
      ok: false,
      revertReason: decodeRevert(revertData),
      rawError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Estimate gas using the Arbitrum NodeInterface precompile.
 *
 * Plain `eth_estimateGas` returns a single number that folds the parent-chain
 * data cost into the total, which makes it hard to reason about why a limit is
 * what it is. `gasEstimateComponents` breaks the two apart, which matters
 * because the L1 component moves with Ethereum's base fee and is the part most
 * likely to shift between preflight and the actual mint.
 */
export async function estimateGasComponents(
  client: RpcClient,
  config: BotConfig,
  wallet: Wallet,
): Promise<GasEstimate> {
  const mintData = buildCalldata({
    rawCalldata: config.mint.rawCalldata,
    functionSignature: config.mint.functionSignature,
    args: config.mint.args,
    sender: wallet.address,
  });

  const probe = encodeFunctionData({
    abi: NODE_INTERFACE_ABI,
    functionName: 'gasEstimateComponents',
    args: [config.mint.contract, false, mintData],
  });

  const raw = await client.call<Hex>('eth_call', [
    {
      from: wallet.address,
      to: NODE_INTERFACE_ADDRESS,
      data: probe,
      value: `0x${config.mint.value.toString(16)}`,
    },
    'latest',
  ]);

  // Four ABI words: gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate.
  const body = raw.slice(2);
  if (body.length < 256) {
    throw new Error(`NodeInterface returned ${body.length / 2} bytes, expected 128`);
  }
  const word = (i: number): bigint => BigInt(`0x${body.slice(i * 64, (i + 1) * 64)}`);

  const total = word(0);
  const forL1 = word(1);
  return {
    total,
    forL1,
    forL2: total > forL1 ? total - forL1 : total,
    baseFee: word(2),
    l1BaseFeeEstimate: word(3),
    source: 'nodeInterface',
  };
}

/** Fallback estimator for nodes that do not expose NodeInterface. */
async function estimateGasPlain(
  client: RpcClient,
  config: BotConfig,
  wallet: Wallet,
): Promise<GasEstimate> {
  const data = buildCalldata({
    rawCalldata: config.mint.rawCalldata,
    functionSignature: config.mint.functionSignature,
    args: config.mint.args,
    sender: wallet.address,
  });

  const hex = await client.call<Hex>('eth_estimateGas', [
    {
      from: wallet.address,
      to: config.mint.contract,
      data,
      value: `0x${config.mint.value.toString(16)}`,
    },
  ]);

  const total = BigInt(hex);
  return {
    total,
    forL1: 0n,
    forL2: total,
    baseFee: 0n,
    l1BaseFeeEstimate: 0n,
    source: 'estimateGas',
  };
}

export async function runPreflight(
  client: RpcClient,
  config: BotConfig,
  wallets: Wallet[],
): Promise<PreflightReport> {
  const warnings: string[] = [];
  const probe = wallets[0];

  const chainIdHex = await client.call<Hex>('eth_chainId');
  const observedChainId = Number(BigInt(chainIdHex));
  const chainIdOk = observedChainId === config.chainId;
  if (!chainIdOk) {
    throw new Error(
      `RPC endpoint reports chain ${observedChainId} but config expects ${config.chainId}. ` +
        `Check NETWORK and RPC_URLS agree.`,
    );
  }

  const code = await client.call<Hex>('eth_getCode', [config.mint.contract, 'latest']);
  const contractHasCode = code !== undefined && code !== '0x';
  if (!contractHasCode) {
    throw new Error(
      `No contract code at ${config.mint.contract} on ${config.network}. ` +
        `The address is wrong, or the contract is not deployed yet.`,
    );
  }

  let baseFeePerGas: bigint | undefined;
  try {
    const block = await client.call<{ baseFeePerGas?: Hex }>('eth_getBlockByNumber', [
      'latest',
      false,
    ]);
    if (block?.baseFeePerGas) baseFeePerGas = BigInt(block.baseFeePerGas);
  } catch {
    warnings.push('Could not read the latest block base fee.');
  }

  if (baseFeePerGas !== undefined && config.gas.maxFeePerGas < baseFeePerGas) {
    warnings.push(
      `MAX_FEE_GWEI is below the current base fee (${baseFeePerGas} wei). ` +
        `Transactions would be rejected outright — raise it.`,
    );
  }

  const simulation = await simulateMint(client, config, probe);

  let gas: GasEstimate;
  if (config.gas.gasLimit !== undefined) {
    gas = {
      total: config.gas.gasLimit,
      forL1: 0n,
      forL2: config.gas.gasLimit,
      baseFee: baseFeePerGas ?? 0n,
      l1BaseFeeEstimate: 0n,
      source: 'configured',
    };
  } else if (simulation.ok) {
    try {
      gas = await estimateGasComponents(client, config, probe);
    } catch (err) {
      log.debug('NodeInterface estimate failed, falling back to eth_estimateGas', {
        error: err instanceof Error ? err.message : String(err),
      });
      gas = await estimateGasPlain(client, config, probe);
      warnings.push('NodeInterface unavailable; used eth_estimateGas instead.');
    }
  } else {
    // This is the normal pre-launch state, not necessarily a misconfiguration.
    throw new Error(
      `Cannot determine a gas limit because the mint call reverts right now` +
        (simulation.revertReason ? ` (${simulation.revertReason})` : '') +
        `.\n` +
        `  If the sale simply has not opened yet, this is expected. Set GAS_LIMIT\n` +
        `  explicitly (copy the gas used by a comparable mint on the explorer, or\n` +
        `  use a generous value like 250000) and re-run.\n` +
        `  If the sale IS open, the call itself is misconfigured — check\n` +
        `  MINT_FUNCTION / MINT_ARGS / MINT_PRICE_ETH against the contract.`,
    );
  }

  const gasLimit =
    config.gas.gasLimit ??
    (gas.total * BigInt(Math.round(config.gas.gasLimitMultiplier * 1000))) / 1000n;

  if (!simulation.ok) {
    warnings.push(
      `Mint call currently reverts${simulation.revertReason ? `: ${simulation.revertReason}` : ''}. ` +
        `Expected if the sale has not opened.`,
    );
  }

  return {
    chainIdOk,
    observedChainId,
    contractHasCode,
    simulation,
    gas,
    gasLimit,
    baseFeePerGas,
    warnings,
  };
}

/** Read a boolean "is the sale open" view, used by the poll trigger. */
export async function readBooleanView(
  client: RpcClient,
  contract: Address,
  signature: string,
): Promise<boolean> {
  const selector = (await import('./calldata.js')).selectorOf(signature);
  const raw = await client.call<Hex>('eth_call', [
    { to: contract, data: selector },
    'latest',
  ]);
  if (!raw || raw === '0x') return false;
  return BigInt(raw) !== 0n;
}
