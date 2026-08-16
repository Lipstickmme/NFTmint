import {
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  isHex,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';

/**
 * Calldata construction.
 *
 * Two supported paths, in order of reliability:
 *
 *   1. Raw calldata copied from a known-good mint transaction. This is what
 *      experienced minters use, because it sidesteps every ambiguity about
 *      overloads, argument order, and non-standard ABIs. The bot reproduces
 *      the bytes exactly.
 *
 *   2. A human-readable function signature plus arguments, encoded here.
 *
 * Either way the result is computed once, before the race, and reused.
 */

/**
 * Placeholder substituted with the sending wallet's own address. Needed for
 * the common `mint(address to, uint256 qty)` shape, where each wallet in a
 * multi-wallet run must pass a different recipient.
 */
export const SENDER_PLACEHOLDER = '$SENDER';

export class CalldataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalldataError';
  }
}

/** Normalize a signature into a full `function ...` declaration for viem. */
function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  return trimmed.startsWith('function ') ? trimmed : `function ${trimmed}`;
}

export function parseFunction(signature: string): AbiFunction {
  let item: unknown;
  try {
    item = parseAbiItem(normalizeSignature(signature));
  } catch (err) {
    throw new CalldataError(
      `Could not parse function signature "${signature}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const fn = item as AbiFunction;
  if (fn.type !== 'function') {
    throw new CalldataError(`"${signature}" is not a function`);
  }
  return fn;
}

/**
 * Coerce a string argument from config into the JS type viem expects for the
 * given Solidity type. Config is inherently stringly-typed; this is where that
 * ends.
 */
function coerceArg(value: string, solidityType: string, sender: Address): unknown {
  if (value === SENDER_PLACEHOLDER) {
    if (solidityType !== 'address') {
      throw new CalldataError(
        `${SENDER_PLACEHOLDER} can only fill an address argument, not ${solidityType}`,
      );
    }
    return sender;
  }

  if (solidityType.endsWith(']')) {
    const inner = solidityType.slice(0, solidityType.lastIndexOf('['));
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new CalldataError(
        `Argument for ${solidityType} must be a JSON array, got "${value}"`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CalldataError(`Argument for ${solidityType} must be a JSON array`);
    }
    return parsed.map((v) => coerceArg(String(v), inner, sender));
  }

  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) {
    try {
      return BigInt(value);
    } catch {
      throw new CalldataError(`Argument "${value}" is not a valid ${solidityType}`);
    }
  }

  if (solidityType === 'bool') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new CalldataError(`Argument "${value}" is not a valid bool`);
  }

  if (solidityType === 'address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new CalldataError(`Argument "${value}" is not a valid address`);
    }
    return value as Address;
  }

  if (solidityType.startsWith('bytes')) {
    if (!isHex(value)) {
      throw new CalldataError(`Argument "${value}" is not valid hex for ${solidityType}`);
    }
    return value as Hex;
  }

  // string and anything else passes through untouched.
  return value;
}

export interface BuildCalldataInput {
  rawCalldata?: Hex;
  functionSignature?: string;
  args: string[];
  /** Wallet the calldata is being built for, used to expand $SENDER. */
  sender: Address;
}

export function buildCalldata(input: BuildCalldataInput): Hex {
  if (input.rawCalldata) {
    if (input.rawCalldata.length % 2 !== 0) {
      throw new CalldataError('MINT_CALLDATA has an odd number of hex digits');
    }
    // Raw calldata is used verbatim; substituting into it would silently
    // corrupt the ABI encoding.
    return input.rawCalldata;
  }

  if (!input.functionSignature) {
    throw new CalldataError('Neither raw calldata nor a function signature was provided');
  }

  const fn = parseFunction(input.functionSignature);
  if (fn.inputs.length !== input.args.length) {
    throw new CalldataError(
      `${fn.name} expects ${fn.inputs.length} argument(s) but ${input.args.length} were provided. ` +
        `Expected types: (${fn.inputs.map((i) => i.type).join(', ')})`,
    );
  }

  const coerced = fn.inputs.map((inputDef, i) =>
    coerceArg(input.args[i], inputDef.type, input.sender),
  );

  return encodeFunctionData({
    abi: [fn] as Abi,
    functionName: fn.name,
    args: coerced,
  });
}

/** The 4-byte selector for a signature, e.g. for feed matching. */
export function selectorOf(signature: string): Hex {
  return toFunctionSelector(normalizeSignature(signature));
}

/** Extract the leading 4-byte selector from calldata, if present. */
export function selectorFromCalldata(calldata: Hex): Hex | undefined {
  if (calldata.length < 10) return undefined;
  return calldata.slice(0, 10).toLowerCase() as Hex;
}

/**
 * Mint entrypoints seen commonly enough to be worth naming. Used by the
 * `inspect` command to suggest a signature when the user does not have raw
 * calldata to copy.
 */
export const COMMON_MINT_SIGNATURES = [
  'mint(uint256)',
  'mint(address,uint256)',
  'mint()',
  'publicMint(uint256)',
  'mintPublic(uint256)',
  'purchase(uint256)',
  'claim(uint256)',
  'whitelistMint(uint256,bytes32[])',
  'allowlistMint(uint256,bytes32[])',
  'presaleMint(uint256,bytes32[])',
] as const;

/** Common "is the sale open?" views, polled by the `poll` trigger. */
export const COMMON_READY_SIGNATURES = [
  'saleIsActive() (bool)',
  'saleActive() (bool)',
  'isSaleActive() (bool)',
  'mintingEnabled() (bool)',
  'publicSaleActive() (bool)',
] as const;
