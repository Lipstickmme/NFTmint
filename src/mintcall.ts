import {
  decodeFunctionData,
  encodeFunctionData,
  recoverTransactionAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { parseFunction } from './calldata.js';
import { SELECTOR_TO_SIGNATURE } from './mintdetect.js';

/**
 * Turn calldata observed from a real minter into calldata we can send.
 *
 * The premise, and the reason this is now the whole strategy: somebody just
 * minted this collection successfully, on this chain, seconds ago. Their
 * transaction is the specification. Guessing a function signature and hoping
 * is strictly worse than copying something that demonstrably worked — the old
 * approach could only mint the two dozen entrypoints that happened to be
 * hardcoded, and refused everything else.
 *
 * The one trap: `mint(address,uint256)` and friends encode a *recipient*.
 * Replaying such a payload verbatim mints the NFT to the wallet we copied
 * from — a silent, total failure that still costs full gas and returns a
 * successful receipt. So the recipient has to be found and replaced.
 *
 * Three ways to do that, generated in order of confidence and then handed to
 * the chain to adjudicate. Simulation is what makes this safe: nothing is
 * broadcast until `eth_call` from our own wallet succeeds, so a wrong guess
 * costs a round trip rather than a transaction.
 *
 *   1. address swap — find the observed sender's own address inside the
 *      calldata and put ours in its place. Needs no ABI at all, which is the
 *      point: it works on entrypoints nobody has ever seen.
 *   2. ABI re-encode — for selectors we recognise, decode and substitute the
 *      address arguments properly. Most precise where it applies.
 *   3. verbatim — replay byte for byte. Correct whenever there is no recipient
 *      to rewrite, which covers `mint()`, `mint(uint256)`, and most free drops.
 */

export interface AutoMintCall {
  /** Builds calldata for a specific wallet. */
  buildFor: (wallet: Address) => Hex;
  /** How this candidate was derived, for the report. */
  strategy: 'address-swap' | 'abi-decode' | 'verbatim';
  signature?: string;
  /** Plain-language account of what will be sent and why. */
  describe: string;
}

const WORD = 64; // one 32-byte ABI word, in hex characters

/**
 * Positions in the calldata holding a left-padded copy of `needle`.
 *
 * ABI-encoded addresses are always a 32-byte word: twelve zero bytes then the
 * twenty address bytes. Scanning word-aligned positions for exactly that
 * pattern finds recipient arguments without knowing the function — and, by
 * requiring an exact match against the sender we observed, avoids mistaking an
 * unrelated address (a payment token, a referrer, a proof element) for one.
 */
export function findAddressWords(data: Hex, needle: Address): number[] {
  const body = data.slice(10).toLowerCase(); // strip 0x and the 4-byte selector
  const padded = '0'.repeat(24) + needle.slice(2).toLowerCase();
  const hits: number[] = [];
  for (let i = 0; i + WORD <= body.length; i += WORD) {
    if (body.slice(i, i + WORD) === padded) hits.push(i);
  }
  return hits;
}

/** Replace every word-aligned copy of `from` with `to`. */
export function swapAddressWords(data: Hex, from: Address, to: Address): Hex | undefined {
  const positions = findAddressWords(data, from);
  if (positions.length === 0) return undefined;

  const prefix = data.slice(0, 10);
  let body = data.slice(10).toLowerCase();
  const replacement = '0'.repeat(24) + to.slice(2).toLowerCase();
  for (const at of positions) {
    body = body.slice(0, at) + replacement + body.slice(at + WORD);
  }
  return (prefix + body) as Hex;
}

/**
 * Recover who sent the sampled transaction.
 *
 * ECDSA recovery is ~1ms, far too slow to run over a busy feed but entirely
 * affordable once, at the moment we are about to mint one specific collection.
 */
export async function recoverSampleSender(raw: Hex | undefined): Promise<Address | undefined> {
  if (!raw) return undefined;
  try {
    return await recoverTransactionAddress({
      serializedTransaction: raw as Parameters<
        typeof recoverTransactionAddress
      >[0]['serializedTransaction'],
    });
  } catch {
    return undefined;
  }
}

export interface AutoMintInput {
  selector?: Hex;
  /** Calldata from a transaction a real minter sent to this contract. */
  observed?: Hex;
  /** Who sent it, when recovery succeeded. */
  observedSender?: Address;
}

/**
 * Every way this mint could plausibly be reproduced, best first.
 *
 * Returns a list rather than a single answer because the caller can *test*
 * them — and a cheap simulation against the real contract is a far better
 * arbiter than any amount of reasoning here about what the ABI probably is.
 */
export function buildAutoMintCalls(input: AutoMintInput): AutoMintCall[] {
  const { selector, observed, observedSender } = input;
  if (!observed || observed.length < 10) return [];

  const calls: AutoMintCall[] = [];
  const seen = new Set<string>();

  /** Keep a candidate only if it produces calldata no earlier one already did. */
  const add = (call: AutoMintCall): void => {
    const probe = call.buildFor(PROBE_WALLET);
    if (seen.has(probe)) return;
    seen.add(probe);
    calls.push(call);
  };

  // 1. The observed sender's address, found inside their own calldata.
  if (observedSender) {
    const swapped = swapAddressWords(observed, observedSender, PROBE_WALLET);
    if (swapped) {
      add({
        strategy: 'address-swap',
        describe:
          'Copied a working mint and replaced the minter\'s address with yours. ' +
          'This needs no knowledge of the contract.',
        buildFor: (wallet) => swapAddressWords(observed, observedSender, wallet) ?? observed,
      });
    }
  }

  // 2. Proper decode, where the entrypoint is one we recognise.
  const signature = selector
    ? SELECTOR_TO_SIGNATURE.get(selector.toLowerCase() as Hex)
    : undefined;
  if (signature) {
    try {
      const fn = parseFunction(signature);
      const decoded = decodeFunctionData({ abi: [fn] as Abi, data: observed });
      const args = (decoded.args ?? []) as readonly unknown[];
      if (args.length === fn.inputs.length) {
        const hasAddress = fn.inputs.some((i) => i.type === 'address');
        if (hasAddress) {
          add({
            strategy: 'abi-decode',
            signature,
            describe: `Recognised ${signature}; kept the observed arguments and set the ` +
              'recipient to your wallet.',
            buildFor: (wallet) =>
              encodeFunctionData({
                abi: [fn] as Abi,
                functionName: fn.name,
                args: fn.inputs.map((input, i) => (input.type === 'address' ? wallet : args[i])),
              }),
          });
        }
      }
    } catch {
      /* the observed payload does not match the signature; other candidates remain */
    }
  }

  // 3. Byte-for-byte. Right whenever there is no recipient encoded at all,
  //    which is the common case for free drops.
  add({
    strategy: 'verbatim',
    signature,
    describe: signature
      ? `Replayed a working ${signature} call exactly.`
      : 'Replayed a working mint exactly, byte for byte.',
    buildFor: () => observed,
  });

  return calls;
}

/**
 * A stand-in address used only to compare candidates against each other.
 *
 * Deduplication needs to know whether two strategies produce the same bytes,
 * which means rendering both for the same wallet. Never sent anywhere.
 */
const PROBE_WALLET = '0x0000000000000000000000000000000000000001' as Address;

/**
 * Backwards-compatible single-answer form, for callers that cannot simulate.
 *
 * Prefers the best candidate. Anything that can afford a round trip should use
 * `buildAutoMintCalls` and let the chain choose instead.
 */
export function buildAutoMintCall(
  selector: Hex | undefined,
  observed: Hex | undefined,
  observedSender?: Address,
): AutoMintCall | undefined {
  return buildAutoMintCalls({ selector, observed, observedSender })[0];
}
