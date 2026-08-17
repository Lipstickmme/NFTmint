import {
  decodeFunctionData,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { parseFunction } from './calldata.js';
import { SELECTOR_TO_SIGNATURE } from './mintdetect.js';

/**
 * Turn calldata observed from a real minter into calldata we can safely send.
 *
 * Shared by every automatic path, so it lives on its own rather than inside one
 * of them.
 *
 * The trap this exists to avoid: `mint(address,uint256)` encodes a recipient.
 * Replaying an observed payload verbatim would mint the NFT to the wallet we
 * copied it from — a silent, total failure that still costs full gas and
 * returns a successful receipt. So any address argument is re-encoded to the
 * sending wallet.
 *
 * When the selector is not one we can decode, we refuse rather than guess.
 * Sending unknown calldata to an unaudited contract is how wallets get drained.
 */

export interface AutoMintCall {
  /** Builds calldata for a specific wallet, substituting any recipient. */
  buildFor: (wallet: Address) => Hex;
  signature?: string;
  /** True when the observed calldata was replayed byte for byte. */
  verbatim: boolean;
}

export function buildAutoMintCall(
  selector: Hex | undefined,
  observed: Hex | undefined,
): AutoMintCall | undefined {
  if (!selector || !observed) return undefined;

  const signature = SELECTOR_TO_SIGNATURE.get(selector.toLowerCase() as Hex);
  if (!signature) return undefined;

  let fn: ReturnType<typeof parseFunction>;
  try {
    fn = parseFunction(signature);
  } catch {
    return undefined;
  }

  const hasAddressArg = fn.inputs.some((i) => i.type === 'address');

  // No recipient to rewrite: the observed payload is safe to reuse exactly.
  if (!hasAddressArg) {
    return { buildFor: () => observed, signature, verbatim: true };
  }

  // Decode the observed arguments so we keep the quantity and any extra
  // parameters a real minter used, and swap only the address positions.
  let decodedArgs: readonly unknown[];
  try {
    const decoded = decodeFunctionData({ abi: [fn] as Abi, data: observed });
    decodedArgs = (decoded.args ?? []) as readonly unknown[];
  } catch {
    return undefined;
  }
  if (decodedArgs.length !== fn.inputs.length) return undefined;

  return {
    signature,
    verbatim: false,
    buildFor: (wallet: Address): Hex =>
      encodeFunctionData({
        abi: [fn] as Abi,
        functionName: fn.name,
        args: fn.inputs.map((input, i) =>
          input.type === 'address' ? wallet : decodedArgs[i],
        ),
      }),
  };
}
