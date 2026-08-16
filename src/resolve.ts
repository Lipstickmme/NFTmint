import { getAddress, isAddress, type Address } from 'viem';

/**
 * Accept whatever the user has in their clipboard.
 *
 * People arrive at a mint from a marketplace page, an explorer tab, or a link
 * in a chat — rarely from a bare checksummed address. Making them extract the
 * address by hand is friction at exactly the moment they are in a hurry, so we
 * pull it out of the common URL shapes instead.
 */

export interface ResolvedTarget {
  contract: Address;
  /** How the address was obtained, shown back so the user can sanity-check it. */
  via: string;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError'; // surfaced as a 400 by the API wrapper
  }
}

/** First 0x-prefixed 40-hex-digit run in a string. */
function firstAddress(text: string): string | undefined {
  return /0x[a-fA-F0-9]{40}/.exec(text)?.[0];
}

export function resolveTarget(input: string): ResolvedTarget {
  const raw = input.trim();
  if (raw === '') throw new ResolveError('Paste a contract address or a link to the collection.');

  // Plain address — the common case.
  if (isAddress(raw)) {
    return { contract: getAddress(raw), via: 'address' };
  }

  // Anything URL-shaped: marketplace, explorer, or a share link. Every one of
  // these embeds the contract address in the path.
  if (/^https?:\/\//i.test(raw) || raw.includes('/')) {
    const found = firstAddress(raw);
    if (found && isAddress(found)) {
      let via = 'link';
      if (/opensea\.io/i.test(raw)) via = 'OpenSea link';
      else if (/blockscout/i.test(raw)) via = 'Blockscout link';
      else if (/etherscan|basescan/i.test(raw)) via = 'explorer link';
      return { contract: getAddress(found), via };
    }

    // An OpenSea collection slug has no address in it, and resolving one needs
    // a marketplace API that does not cover this chain. Say so plainly rather
    // than failing with something cryptic.
    if (/opensea\.io\/collection\//i.test(raw)) {
      throw new ResolveError(
        'That OpenSea link only contains a collection name, not a contract address. ' +
          'Open any item in the collection and copy the address from its URL, or ' +
          'take it from the block explorer.',
      );
    }

    throw new ResolveError('No contract address found in that link. Paste the address itself.');
  }

  // Bare hex missing the 0x prefix is a common paste error worth fixing for them.
  if (/^[a-fA-F0-9]{40}$/.test(raw)) {
    return { contract: getAddress(`0x${raw}`), via: 'address (0x added)' };
  }

  throw new ResolveError(
    `"${raw.slice(0, 40)}" is not a contract address. It should be 0x followed by 40 characters.`,
  );
}
