import {
  decodeAbiParameters,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { parseFunction, selectorOf } from './calldata.js';
import { fetchNftPreview, type NftPreview } from './nftimage.js';
import type { RpcClient } from './rpc.js';

/**
 * Contract inspection.
 *
 * The tracker can tell you a contract is being minted hard, but not whether
 * there is anything left to mint. That question — "has this already sold out?"
 * — can only be answered by the contract itself, so we ask it.
 *
 * NFT contracts do not share one ABI, so every field is probed across the
 * names that are common in practice and reported as absent if none answer.
 * Nothing here throws on a missing function: an unreadable field is normal,
 * not an error.
 */

/** Candidate getters, in the order we trust them. */
const SUPPLY_FNS = ['totalSupply()', 'totalMinted()', 'minted()', 'currentSupply()'];
const MAX_SUPPLY_FNS = [
  'maxSupply()',
  'MAX_SUPPLY()',
  'MAX_TOKENS()',
  'maxTokens()',
  'collectionSize()',
  'MAX_MINT_SUPPLY()',
  'totalSupplyCap()',
];
const PRICE_FNS = [
  'price()',
  'mintPrice()',
  'cost()',
  'PRICE()',
  'MINT_PRICE()',
  'publicPrice()',
  'publicMintPrice()',
  'salePrice()',
];
const SALE_OPEN_FNS = [
  'saleIsActive()',
  'saleActive()',
  'isSaleActive()',
  'mintingEnabled()',
  'publicSaleActive()',
  'mintOpen()',
  'isMintActive()',
  'mintActive()',
  'saleStarted()',
];

export interface ProbedValue<T> {
  value: T;
  /** Which function answered, so the UI can show its reasoning. */
  source: string;
}

export interface ContractInfo {
  contract: Address;
  hasCode: boolean;
  name?: string;
  symbol?: string;
  totalSupply?: ProbedValue<string>;
  maxSupply?: ProbedValue<string>;
  /** Percent of max supply already minted, when both numbers are readable. */
  progressPct?: number;
  remaining?: string;
  soldOut?: boolean;
  priceWei?: ProbedValue<string>;
  saleOpen?: ProbedValue<boolean>;
  /** How many tokens the given wallet already holds. */
  ownedByWallet?: string;
  /** Artwork preview, when one was requested and could be resolved. */
  preview?: NftPreview;
  /** Plain-language read of the contract's state. */
  summary: string;
}

/** Call a zero-argument view, returning undefined if it does not exist. */
async function probe(
  client: RpcClient,
  contract: Address,
  signature: string,
): Promise<Hex | undefined> {
  try {
    const data = selectorOf(signature);
    const result = await client.call<Hex>('eth_call', [{ to: contract, data }, 'latest']);
    if (!result || result === '0x') return undefined;
    return result;
  } catch {
    return undefined;
  }
}

/** Try each candidate in turn and return the first that answers. */
async function probeFirst<T>(
  client: RpcClient,
  contract: Address,
  signatures: string[],
  decode: (raw: Hex) => T | undefined,
): Promise<ProbedValue<T> | undefined> {
  const results = await Promise.all(
    signatures.map(async (sig) => ({ sig, raw: await probe(client, contract, sig) })),
  );
  for (const { sig, raw } of results) {
    if (raw === undefined) continue;
    const value = decode(raw);
    if (value !== undefined) return { value, source: sig };
  }
  return undefined;
}

function decodeUint(raw: Hex): string | undefined {
  try {
    return BigInt(raw).toString();
  } catch {
    return undefined;
  }
}

function decodeBool(raw: Hex): boolean | undefined {
  try {
    return BigInt(raw) !== 0n;
  } catch {
    return undefined;
  }
}

function decodeString(raw: Hex): string | undefined {
  try {
    const [value] = decodeAbiParameters([{ type: 'string' }], raw);
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Read how many tokens a wallet holds — the basis for skip-if-already-minted. */
export async function balanceOf(
  client: RpcClient,
  contract: Address,
  wallet: Address,
): Promise<bigint | undefined> {
  try {
    const fn = parseFunction('balanceOf(address) (uint256)');
    const data = encodeFunctionData({
      abi: [fn] as Abi,
      functionName: 'balanceOf',
      args: [wallet],
    });
    const raw = await client.call<Hex>('eth_call', [{ to: contract, data }, 'latest']);
    if (!raw || raw === '0x') return undefined;
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

export async function inspectContract(
  client: RpcClient,
  contract: Address,
  wallet?: Address,
  /**
   * Resolve the artwork too.
   *
   * Off by default because it costs a contract read plus an off-chain metadata
   * fetch. Worth it for a single collection someone is looking at; too slow to
   * do for every candidate in a hunt round, which has a hard time budget.
   */
  withPreview = false,
): Promise<ContractInfo> {
  const code = await client.call<Hex>('eth_getCode', [contract, 'latest']);
  const hasCode = Boolean(code) && code !== '0x';

  if (!hasCode) {
    return {
      contract,
      hasCode: false,
      summary: 'No contract deployed at this address on this network.',
    };
  }

  const [nameRaw, symbolRaw, totalSupply, maxSupply, priceWei, saleOpen, owned] =
    await Promise.all([
      probe(client, contract, 'name()'),
      probe(client, contract, 'symbol()'),
      probeFirst(client, contract, SUPPLY_FNS, decodeUint),
      probeFirst(client, contract, MAX_SUPPLY_FNS, decodeUint),
      probeFirst(client, contract, PRICE_FNS, decodeUint),
      probeFirst(client, contract, SALE_OPEN_FNS, decodeBool),
      wallet ? balanceOf(client, contract, wallet) : Promise.resolve(undefined),
    ]);

  const info: ContractInfo = {
    contract,
    hasCode: true,
    name: nameRaw ? decodeString(nameRaw) : undefined,
    symbol: symbolRaw ? decodeString(symbolRaw) : undefined,
    totalSupply,
    maxSupply,
    priceWei,
    saleOpen,
    ownedByWallet: owned?.toString(),
    summary: '',
  };

  if (totalSupply && maxSupply) {
    const minted = BigInt(totalSupply.value);
    const max = BigInt(maxSupply.value);
    if (max > 0n) {
      info.progressPct = Number((minted * 10_000n) / max) / 100;
      info.remaining = (max > minted ? max - minted : 0n).toString();
      info.soldOut = minted >= max;
    }
  }

  if (withPreview) {
    info.preview = await fetchNftPreview(
      client,
      contract,
      totalSupply ? BigInt(totalSupply.value) : undefined,
    );
    // Metadata usually carries a better name than the contract does.
    if (!info.name && info.preview.tokenName) info.name = info.preview.tokenName;
  }

  info.summary = describe(info);
  return info;
}

/** Turn the probed fields into one sentence a human can act on. */
function describe(info: ContractInfo): string {
  const parts: string[] = [];

  if (info.name) parts.push(info.name + (info.symbol ? ` (${info.symbol})` : ''));

  if (info.soldOut) {
    parts.push('SOLD OUT — nothing left to mint');
  } else if (info.progressPct !== undefined) {
    parts.push(
      `${info.totalSupply?.value} of ${info.maxSupply?.value} minted ` +
        `(${info.progressPct.toFixed(1)}%), ${info.remaining} left`,
    );
  } else if (info.totalSupply) {
    parts.push(`${info.totalSupply.value} minted so far, max supply not readable`);
  } else {
    parts.push('supply not readable from this contract');
  }

  if (info.saleOpen) {
    parts.push(info.saleOpen.value ? 'sale is OPEN' : 'sale is CLOSED');
  }

  if (info.priceWei) {
    const wei = BigInt(info.priceWei.value);
    parts.push(wei === 0n ? 'free mint' : `price ${formatEth(wei)} ETH`);
  }

  if (info.ownedByWallet && BigInt(info.ownedByWallet) > 0n) {
    parts.push(`you already hold ${info.ownedByWallet}`);
  }

  return parts.join(' · ');
}

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
