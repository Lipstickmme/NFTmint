import { encodeFunctionData, isAddress, type Abi, type Address, type Hex } from 'viem';
import { parseFunction, selectorOf } from './calldata.js';
import { inspectContract, type ContractInfo } from './inspect.js';
import { JsonRpcError, type RpcClient } from './rpc.js';
import { decodeRevert } from './preflight.js';

/**
 * Work out how to mint a collection, by asking the chain rather than the user.
 *
 * Requiring someone to supply a function signature or raw calldata is the
 * single worst part of a mint tool: it demands they read an ABI under time
 * pressure, and a wrong guess costs gas for nothing. Every input needed is
 * already discoverable on chain, so this derives it:
 *
 *   - price, supply, and sale state come from the contract's own getters
 *   - the mint entrypoint is found by simulating each common signature and
 *     keeping whichever one the contract accepts
 *
 * A simulation that succeeds is strong evidence: it means the contract would
 * really execute that call, with that price, from this wallet, right now.
 */

/** A mint entrypoint worth trying, and how to fill its arguments. */
interface Candidate {
  signature: string;
  /** Argument template. `$QTY` becomes the quantity, `$SENDER` the wallet. */
  args: string[];
}

const CANDIDATES: Candidate[] = [
  { signature: 'mint(uint256)', args: ['$QTY'] },
  { signature: 'mint(address,uint256)', args: ['$SENDER', '$QTY'] },
  { signature: 'publicMint(uint256)', args: ['$QTY'] },
  { signature: 'mintPublic(uint256)', args: ['$QTY'] },
  { signature: 'freeMint(uint256)', args: ['$QTY'] },
  { signature: 'claim(uint256)', args: ['$QTY'] },
  { signature: 'purchase(uint256)', args: ['$QTY'] },
  { signature: 'buy(uint256)', args: ['$QTY'] },
  { signature: 'mintNFT(uint256)', args: ['$QTY'] },
  { signature: 'safeMint(address,uint256)', args: ['$SENDER', '$QTY'] },
  { signature: 'mint(address)', args: ['$SENDER'] },
  { signature: 'safeMint(address)', args: ['$SENDER'] },
  { signature: 'mint()', args: [] },
  { signature: 'publicMint()', args: [] },
  { signature: 'freeMint()', args: [] },
  { signature: 'claim()', args: [] },
];

export interface CandidateResult {
  signature: string;
  selector: Hex;
  /** 'ok' means the contract would accept this call as configured. */
  outcome: 'ok' | 'revert' | 'error';
  reason?: string;
}

export interface MintPlan {
  contract: Address;
  info: ContractInfo;
  /** Every entrypoint tried, so a failure is diagnosable. */
  tried: CandidateResult[];
  /** The call to use, when one was found. */
  chosen?: {
    signature: string;
    args: string[];
    valueWei: string;
    calldata: Hex;
    gasLimit?: string;
  };
  /** True when the plan is complete enough to mint from. */
  ready: boolean;
  /** Reasons it is not ready, in plain language. */
  blockers: string[];
  /** What to do next. */
  advice: string;
}

function fillArgs(template: string[], qty: number, sender: Address): string[] {
  return template.map((a) =>
    a === '$QTY' ? String(qty) : a === '$SENDER' ? sender : a,
  );
}

function buildCandidateCalldata(
  candidate: Candidate,
  qty: number,
  sender: Address,
): Hex {
  const fn = parseFunction(candidate.signature);
  const raw = fillArgs(candidate.args, qty, sender);
  const args = fn.inputs.map((input, i) =>
    input.type === 'address' ? (raw[i] as Address) : BigInt(raw[i]),
  );
  return encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args });
}

/**
 * Try one entrypoint against the live contract.
 *
 * A revert is informative rather than fatal — it usually means "wrong function"
 * or "sale closed", and the decoded reason distinguishes the two.
 */
async function trySignature(
  client: RpcClient,
  contract: Address,
  sender: Address,
  candidate: Candidate,
  qty: number,
  valueWei: bigint,
): Promise<CandidateResult & { calldata?: Hex }> {
  const selector = selectorOf(candidate.signature);
  let calldata: Hex;
  try {
    calldata = buildCandidateCalldata(candidate, qty, sender);
  } catch (err) {
    return {
      signature: candidate.signature,
      selector,
      outcome: 'error',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    await client.call('eth_call', [
      {
        from: sender,
        to: contract,
        data: calldata,
        value: `0x${valueWei.toString(16)}`,
      },
      'latest',
    ]);
    return { signature: candidate.signature, selector, outcome: 'ok', calldata };
  } catch (err) {
    let reason: string | undefined;
    if (err instanceof JsonRpcError) {
      const data = err.data;
      const hex =
        typeof data === 'string'
          ? data
          : typeof (data as { data?: unknown } | undefined)?.data === 'string'
            ? ((data as { data: string }).data)
            : undefined;
      reason = decodeRevert(hex as Hex | undefined) ?? err.message;
    } else if (err instanceof Error) {
      reason = err.message;
    }
    return { signature: candidate.signature, selector, outcome: 'revert', reason };
  }
}

export interface PlanOptions {
  quantity: number;
  /** Overrides the price read from the contract. */
  valueWeiOverride?: bigint;
  /** Try this signature first, e.g. one observed on the feed. */
  preferSignature?: string;
}

export async function buildMintPlan(
  client: RpcClient,
  contract: Address,
  wallet: Address,
  options: PlanOptions = { quantity: 1 },
): Promise<MintPlan> {
  if (!isAddress(contract)) {
    throw Object.assign(new Error(`Not a valid contract address: ${contract}`), {
      name: 'ConfigError',
    });
  }

  const info = await inspectContract(client, contract, wallet, true);
  const blockers: string[] = [];

  if (!info.hasCode) {
    return {
      contract, info, tried: [], ready: false,
      blockers: ['There is no contract at this address on this network.'],
      advice: 'Check the address, and that you are on the right network.',
    };
  }

  if (info.soldOut) blockers.push('This collection is sold out.');
  if (info.saleOpen && !info.saleOpen.value) {
    blockers.push(`The contract reports its sale is closed (${info.saleOpen.source}).`);
  }

  const qty = Math.max(1, Math.floor(options.quantity));
  const unitPrice =
    options.valueWeiOverride ?? (info.priceWei ? BigInt(info.priceWei.value) : 0n);
  const valueWei = unitPrice * BigInt(qty);

  // Put a preferred signature first — one seen working on the feed beats
  // anything we would guess.
  const ordered = [...CANDIDATES];
  if (options.preferSignature) {
    const idx = ordered.findIndex((c) => c.signature === options.preferSignature);
    if (idx > 0) ordered.unshift(...ordered.splice(idx, 1));
  }

  const tried: CandidateResult[] = [];
  let chosen: MintPlan['chosen'];

  for (const candidate of ordered) {
    const result = await trySignature(client, contract, wallet, candidate, qty, valueWei);
    const { calldata, ...record } = result;
    tried.push(record);

    if (result.outcome === 'ok' && calldata) {
      chosen = {
        signature: candidate.signature,
        args: fillArgs(candidate.args, qty, wallet),
        valueWei: valueWei.toString(),
        calldata,
      };
      break;
    }
  }

  if (chosen) {
    // Estimate gas now, so the mint path never has to.
    try {
      const hex = await client.call<Hex>('eth_estimateGas', [
        {
          from: wallet,
          to: contract,
          data: chosen.calldata,
          value: `0x${valueWei.toString(16)}`,
        },
      ]);
      chosen.gasLimit = ((BigInt(hex) * 13n) / 10n).toString();
    } catch {
      /* the mint path will estimate or fall back */
    }
  }

  if (!chosen) {
    // Distinguish "closed" from "unknown ABI": if every attempt reverted with
    // the same reason, that is the contract telling us why, not a bad guess.
    const reasons = tried
      .map((t) => t.reason)
      .filter((r): r is string => typeof r === 'string' && !/execution reverted$/i.test(r));
    const common = mostCommon(reasons);
    if (common && blockers.length === 0) {
      blockers.push(`Every mint attempt was rejected with: ${common}`);
    } else if (blockers.length === 0) {
      blockers.push('None of the common mint functions were accepted by this contract.');
    }
  }

  const ready = Boolean(chosen) && blockers.length === 0;

  return {
    contract,
    info,
    tried,
    chosen,
    ready,
    blockers,
    advice: adviceFor(ready, chosen, blockers, info),
  };
}

function mostCommon(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function adviceFor(
  ready: boolean,
  chosen: MintPlan['chosen'],
  blockers: string[],
  info: ContractInfo,
): string {
  if (ready && chosen) {
    const price = BigInt(chosen.valueWei) === 0n ? 'free' : `${chosen.valueWei} wei`;
    return `Ready to mint using ${chosen.signature} (${price}). Press Mint.`;
  }
  if (info.soldOut) return 'Nothing left to mint here — find another collection.';
  if (info.saleOpen && !info.saleOpen.value) {
    return 'The sale is not open yet. Come back when it starts, or use auto-hunt to catch it.';
  }
  if (chosen && blockers.length > 0) {
    return `A working mint call was found, but: ${blockers.join(' ')}`;
  }
  return (
    'Could not work out how to mint this automatically. Paste the raw input data ' +
    'from a successful mint transaction on the explorer instead.'
  );
}
