import { encodeFunctionData, decodeAbiParameters, type Abi, type Address, type Hex } from 'viem';
import { parseFunction } from './calldata.js';
import type { RpcClient } from './rpc.js';

/**
 * Fetch a small preview image for a collection.
 *
 * Seeing the artwork is the fastest way to tell a real drop from noise, and it
 * costs one contract read plus one metadata fetch.
 *
 * Everything here is defensive. The metadata URL comes from an unaudited
 * contract, so it is treated as hostile input: only known schemes are followed,
 * the request is bounded by a timeout, the response is capped before parsing,
 * and every failure resolves to "no image" rather than throwing. A missing
 * picture must never break a mint.
 *
 * The image URL is handed to the browser rather than proxied. Proxying would
 * make this server fetch arbitrary bytes on demand — a far larger surface than
 * letting the page load a picture.
 */

/** Public gateway used to turn ipfs:// into something a browser can load. */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

const METADATA_TIMEOUT_MS = 4_000;
const MAX_METADATA_BYTES = 256 * 1024;

export interface NftPreview {
  /** Directly loadable image URL, when one could be resolved. */
  imageUrl?: string;
  /** Name from the token metadata, which is often better than the contract's. */
  tokenName?: string;
  /** Which token was sampled. */
  tokenId?: string;
  /** Why there is no image, when there is not one. */
  note?: string;
}

/** Rewrite ipfs:// and bare CIDs into a gateway URL a browser can fetch. */
export function resolveUri(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (trimmed === '') return undefined;

  if (trimmed.startsWith('ipfs://')) {
    return IPFS_GATEWAY + trimmed.replace(/^ipfs:\/\/(ipfs\/)?/, '');
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // On-chain metadata and SVGs arrive as data: URIs and need no fetching.
  if (trimmed.startsWith('data:')) return trimmed;
  // A bare CID is common enough to be worth handling.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[0-9a-z]{50,})/.test(trimmed)) {
    return IPFS_GATEWAY + trimmed;
  }
  return undefined;
}

/** Decode a data: URI holding JSON, base64 or not. */
function decodeDataUri(uri: string): string | undefined {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!match) return undefined;
  const [, , base64, payload] = match;
  try {
    return base64 ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

async function readTokenUri(
  client: RpcClient,
  contract: Address,
  signature: string,
  tokenId: bigint,
): Promise<string | undefined> {
  try {
    const fn = parseFunction(signature);
    const data = encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args: [tokenId] });
    const raw = await client.call<Hex>('eth_call', [{ to: contract, data }, 'latest']);
    if (!raw || raw === '0x') return undefined;
    const [value] = decodeAbiParameters([{ type: 'string' }], raw);
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Fetch and parse token metadata, bounded in both time and size. */
async function fetchMetadata(url: string): Promise<Record<string, unknown> | undefined> {
  if (url.startsWith('data:')) {
    const text = decodeDataUri(url);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return undefined;

    // Cap the body before parsing so a huge or endless response cannot be used
    // to stall or exhaust the function.
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_METADATA_BYTES) return undefined;
    const text = (await res.text()).slice(0, MAX_METADATA_BYTES);
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a preview for a collection.
 *
 * `totalSupply` picks a token that is known to exist; without it we fall back
 * to the ids most collections start at.
 */
export async function fetchNftPreview(
  client: RpcClient,
  contract: Address,
  totalSupply?: bigint,
): Promise<NftPreview> {
  const candidateIds: bigint[] = [];
  if (totalSupply !== undefined && totalSupply > 0n) candidateIds.push(totalSupply - 1n, 1n);
  candidateIds.push(1n, 0n);

  for (const tokenId of [...new Set(candidateIds)]) {
    for (const signature of ['tokenURI(uint256)', 'uri(uint256)']) {
      const raw = await readTokenUri(client, contract, signature, tokenId);
      if (!raw) continue;

      const metadataUrl = resolveUri(raw);
      if (!metadataUrl) continue;

      const metadata = await fetchMetadata(metadataUrl);
      if (!metadata) continue;

      const image = metadata.image ?? metadata.image_url ?? metadata.imageUrl;
      const imageUrl = typeof image === 'string' ? resolveUri(image) : undefined;
      if (!imageUrl) continue;

      return {
        imageUrl,
        tokenName: typeof metadata.name === 'string' ? metadata.name : undefined,
        tokenId: tokenId.toString(),
      };
    }
  }

  return { note: 'no preview image could be read from this contract' };
}
