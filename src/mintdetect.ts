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
 *
 * This list saves round trips; it is not the safety net. Enumerating every
 * router entrypoint is a losing game, and a swap router that slips past it still
 * has to answer for itself: before anything is sent, the contract is asked
 * whether it is an ERC-721 or ERC-1155, and a no — or a silence — is fatal.
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
  'exactInput((bytes,address,uint256,uint256,uint256))',
  'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  'swapETHForExactTokens(uint256,address[],address,uint256)',
  'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
  'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
  'multicall(bytes[])',
  'multicall(uint256,bytes[])',
  'execute(bytes,bytes[],uint256)',
  'execute(bytes,bytes[])',
  'unwrapWETH9(uint256,address)',
  'wrapETH(uint256)',
  // Seaport order fulfilment — a purchase on a marketplace, not a mint.
  'fulfillBasicOrder((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
  'fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32)',
] as const;

export const NOT_MINT_SELECTORS: ReadonlySet<Hex> = new Set(
  NOT_MINT_SIGNATURES.map((sig) => selectorOf(sig).toLowerCase() as Hex),
);

/**
 * Mints made through a shared drop contract.
 *
 * OpenSea's SeaDrop is the common one: buyers call SeaDrop, not the collection,
 * and SeaDrop mints on the collection's behalf. On the feed that looks like one
 * enormously busy contract at `0x00005EA0…` with thousands of mints a minute and
 * no NFT interface — which is exactly what it is, and exactly what should not be
 * on a board of collections.
 *
 * The traffic is real, though. It is only attributed to the wrong address, and
 * the right one is the first argument of every one of these calls:
 *
 *   mintPublic(address nftContract, address feeRecipient, …)
 *
 * So rather than discarding it, the mint is credited to the collection it was
 * actually for. Keyed by selector rather than by proxy address on purpose:
 * SeaDrop has several deployments and more will follow, but the argument order
 * is part of its interface.
 */
const PROXY_MINT_SIGNATURES = [
  // SeaDrop v1 — the collection is always the first parameter.
  'mintPublic(address,address,address,uint256)',
  'mintAllowList(address,address,address,uint256,(bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256,bool),bytes32[])',
  'mintSigned(address,address,address,uint256,(bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256,bool),uint256,bytes)',
  'mintAllowedTokenHolder(address,address,address,(address,uint256[])[])',
] as const;

export const PROXY_MINT_SELECTORS: ReadonlySet<Hex> = new Set(
  PROXY_MINT_SIGNATURES.map((sig) => selectorOf(sig).toLowerCase() as Hex),
);

/**
 * The collection a mint is actually for.
 *
 * Normally the transaction's `to`. For a call through a shared drop contract it
 * is the first address argument instead. Returns undefined when the calldata is
 * too short to hold one, rather than guessing.
 */
export function mintTarget(tx: {
  to?: string;
  selector?: Hex;
  data: Hex;
}): string | undefined {
  if (!tx.to) return undefined;
  const selector = tx.selector?.toLowerCase() as Hex | undefined;
  if (!selector || !PROXY_MINT_SELECTORS.has(selector)) return tx.to;

  // Selector plus one 32-byte word: `0x` + 8 + 64 characters.
  if (tx.data.length < 74) return undefined;
  const word = tx.data.slice(10, 74);
  // A left-padded address is twelve zero bytes then twenty address bytes.
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return undefined;
  const address = `0x${word.slice(24)}`;
  // A zero address means the argument was not filled in; that is not a target.
  return /^0x0{40}$/.test(address) ? undefined : address;
}

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
