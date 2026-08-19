import type { Hex } from 'viem';
import { selectorOf } from './calldata.js';

/**
 * Mint detection.
 *
 * The sequencer feed gives us transactions, not receipts or logs, so we
 * classify by function selector and value rather than by Transfer events. That
 * is a deliberate trade: we see *attempted* mints instead of confirmed ones,
 * which is both earlier and — for demand measurement — the better signal. A
 * hundred people racing for a mint tells you it is sought after whether or not
 * they all succeed.
 */

/**
 * Selectors we recognise on sight.
 *
 * This list is a *fast path*, not a gate. It used to be the gate, and that was
 * the single biggest reason auto-mint missed things: a collection whose
 * entrypoint is `mintTo(address,uint256)` or any of the hundred other shapes in
 * the wild was never tracked at all, so it could not be scored, let alone
 * bought. Now an unrecognised selector is still watched — it just has to earn
 * attention by being called repeatedly (see `looksLikeContractCall`).
 */
const MINT_SIGNATURES = [
  'mint(uint256)',
  'mint(address,uint256)',
  'mint()',
  'mint(address)',
  'mint(uint256,uint256)',
  'publicMint(uint256)',
  'publicMint()',
  'mintPublic(uint256)',
  'mintPublic(address,uint256)',
  'purchase(uint256)',
  'buy(uint256)',
  'claim(uint256)',
  'claim()',
  'claimTo(address,uint256)',
  'safeMint(address)',
  'safeMint(address,uint256)',
  'whitelistMint(uint256,bytes32[])',
  'allowlistMint(uint256,bytes32[])',
  'presaleMint(uint256,bytes32[])',
  'mintNFT(uint256)',
  'freeMint(uint256)',
  'freeMint()',
  // thirdweb drop standard, widely used for free claims
  'claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)',
] as const;

export const MINT_SELECTORS: ReadonlySet<Hex> = new Set(
  MINT_SIGNATURES.map((sig) => selectorOf(sig).toLowerCase() as Hex),
);

/** Reverse lookup so the tracker can report which entrypoint was used. */
export const SELECTOR_TO_SIGNATURE: ReadonlyMap<Hex, string> = new Map(
  MINT_SIGNATURES.map((sig) => [selectorOf(sig).toLowerCase() as Hex, sig]),
);

/**
 * Selectors that are definitely not mints.
 *
 * Cheap, and it keeps the busiest traffic on any chain — transfers, approvals,
 * swaps — out of the tracker entirely, so widening detection does not just mean
 * tracking everything.
 */
const NOT_MINT_SIGNATURES = [
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
  'approve(address,uint256)',
  'setApprovalForAll(address,bool)',
  'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'deposit()',
  'withdraw(uint256)',
  'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  'swapExactETHForTokens(uint256,address[],address,uint256)',
  'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'multicall(bytes[])',
  'execute(bytes,bytes[],uint256)',
] as const;

export const NOT_MINT_SELECTORS: ReadonlySet<Hex> = new Set(
  NOT_MINT_SIGNATURES.map((sig) => selectorOf(sig).toLowerCase() as Hex),
);

export interface MintClassification {
  isMint: boolean;
  /** True when no ETH was attached — a free mint candidate. */
  isFree: boolean;
  /**
   * How we know.
   *
   *   'known'    — a selector from the list above. Trusted immediately.
   *   'observed' — an unrecognised entrypoint. Tracked, but it has to be called
   *                by enough distinct people before it is taken seriously.
   */
  confidence: 'known' | 'observed';
  signature?: string;
  selector?: Hex;
}

export interface ClassifyInput {
  to?: string;
  selector?: Hex;
  value: bigint;
  data: Hex;
}

/**
 * Classify a feed transaction.
 *
 * `extraSelectors` lets an operator register a collection's non-standard mint
 * entrypoint without a code change.
 */
export function classifyMint(
  tx: ClassifyInput,
  extraSelectors?: ReadonlySet<Hex>,
): MintClassification {
  // Contract creation, or a bare value transfer, is never a mint.
  if (!tx.to || !tx.selector) return { isMint: false, isFree: false, confidence: 'observed' };

  const selector = tx.selector.toLowerCase() as Hex;

  if (NOT_MINT_SELECTORS.has(selector)) {
    return { isMint: false, isFree: false, confidence: 'observed' };
  }

  const known = MINT_SELECTORS.has(selector) || extraSelectors?.has(selector) === true;

  return {
    isMint: true,
    isFree: tx.value === 0n,
    // An unrecognised entrypoint is a maybe, not a no. The tracker holds it in
    // a cheap watch state until enough distinct wallets call it, which is a far
    // better test of "this is a drop people are racing for" than whether we
    // happened to hardcode the function name.
    confidence: known ? 'known' : 'observed',
    signature: SELECTOR_TO_SIGNATURE.get(selector),
    selector,
  };
}

/**
 * Parse a comma-separated list of extra selectors or signatures from config.
 * Accepts either form: "0xdeadbeef" or "customMint(uint256)".
 */
export function parseExtraSelectors(raw: string | undefined): Set<Hex> {
  const out = new Set<Hex>();
  if (!raw) return out;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^0x[0-9a-fA-F]{8}$/.test(entry)) {
      out.add(entry.toLowerCase() as Hex);
    } else if (entry.includes('(')) {
      out.add(selectorOf(entry).toLowerCase() as Hex);
    } else {
      throw new Error(
        `EXTRA_MINT_SELECTORS entry "${entry}" is neither a 4-byte selector nor a function signature`,
      );
    }
  }
  return out;
}
