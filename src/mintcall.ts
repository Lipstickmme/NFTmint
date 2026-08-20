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
  /** The same thing, in words, for anything a person reads. */
  label: string;
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
  /**
   * Take this many in one call, when the contract allows it.
   *
   * A copied transaction asks for whatever quantity that particular person
   * wanted, usually one. On a five-per-wallet free drop that leaves four
   * behind for the same gas, so where a quantity can be located it is raised
   * to the cap. Candidates that do so are offered first and the original
   * quantity is still tried after, because a contract may cap per transaction
   * more tightly than per wallet.
   */
  quantity?: bigint;
}

/** The largest plausible mint quantity. Anything above this is not a count. */
const MAX_PLAUSIBLE_QUANTITY = 10_000n;

/**
 * The single argument that looks like a quantity, if there is exactly one.
 *
 * ABI-free, so it works on entrypoints nobody has hardcoded. The rule is
 * deliberately strict: every word after the selector must be a small integer,
 * and exactly one of them may be non-trivial. A payload carrying an address, a
 * merkle proof, or a token id has words that fail that test, and returning
 * nothing there is correct — a wrong guess would corrupt the call.
 */
export function findQuantityWord(data: Hex): number | undefined {
  const body = data.slice(10);
  if (body.length === 0 || body.length % WORD !== 0) return undefined;

  const words = body.length / WORD;
  // More than a couple of arguments and the shape is too ambiguous to read
  // without an ABI.
  if (words > 2) return undefined;

  let found: number | undefined;
  for (let i = 0; i < words; i += 1) {
    const at = i * WORD;
    let value: bigint;
    try {
      value = BigInt(`0x${body.slice(at, at + WORD)}`);
    } catch {
      return undefined;
    }
    if (value === 0n) continue;
    if (value > MAX_PLAUSIBLE_QUANTITY) return undefined;
    // Two candidate quantities is one too many to choose between.
    if (found !== undefined) return undefined;
    found = at;
  }
  return found;
}

/** Rewrite the quantity word, leaving every other byte alone. */
export function setQuantity(data: Hex, quantity: bigint): Hex | undefined {
  const at = findQuantityWord(data);
  if (at === undefined) return undefined;
  const body = data.slice(10);
  const replacement = quantity.toString(16).padStart(WORD, '0');
  return (data.slice(0, 10) + body.slice(0, at) + replacement + body.slice(at + WORD)) as Hex;
}

/**
 * Every way this mint could plausibly be reproduced, best first.
 *
 * Returns a list rather than a single answer because the caller can *test*
 * them — and a cheap simulation against the real contract is a far better
 * arbiter than any amount of reasoning here about what the ABI probably is.
 */
export function buildAutoMintCalls(input: AutoMintInput): AutoMintCall[] {
  const { selector, observed, observedSender, quantity } = input;
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

  // 0. The whole per-wallet allowance, where a quantity can be located.
  //    Offered first because it is strictly better when it works, and the
  //    ordinary quantity is still tried after if the contract refuses.
  if (quantity !== undefined && quantity > 1n && quantity <= MAX_PLAUSIBLE_QUANTITY) {
    const bulk = setQuantity(observed, quantity);
    if (bulk) {
      const swapped = observedSender
        ? swapAddressWords(bulk, observedSender, PROBE_WALLET)
        : undefined;
      add({
        strategy: swapped ? 'address-swap' : 'verbatim',
        label: `take all ${quantity} at once`,
        describe:
          `Copied a working mint and raised the quantity to ${quantity}, the ` +
          `contract's per-wallet limit, so one transaction takes the whole allowance.`,
        buildFor: (wallet) =>
          (observedSender ? swapAddressWords(bulk, observedSender, wallet) : undefined) ?? bulk,
      });
    }
  }

  // 1. The observed sender's address, found inside their own calldata.
  if (observedSender) {
    const swapped = swapAddressWords(observed, observedSender, PROBE_WALLET);
    if (swapped) {
      add({
        strategy: 'address-swap',
        label: 'swap your address in',
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
            label: 'rebuild it from the ABI',
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
    label: 'replay it exactly',
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
