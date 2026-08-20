import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  buildAutoMintCall,
  buildAutoMintCalls,
  findAddressWords,
  findQuantityWord,
  recoverSampleSender,
  setQuantity,
  swapAddressWords,
} from '../src/mintcall.js';
import { parseFunction, selectorOf } from '../src/calldata.js';

/**
 * Turning calldata observed from a stranger into calldata that mints to US.
 *
 * The failure this guards against is silent and total: replaying an observed
 * `mint(address,uint256)` verbatim mints the NFT to the wallet it was copied
 * from, while still costing full gas and returning a successful receipt.
 *
 * The strategy changed shape here. It used to require the entrypoint to be one
 * of two dozen hardcoded signatures and refuse everything else, which is why
 * most real collections could not be minted at all. Now several candidates are
 * produced and the caller simulates them — so the tests are about generating
 * the right *set*, and about the address swap that works with no ABI at all.
 */

const OUR_WALLET = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_MINTER = '0x2222222222222222222222222222222222222222' as Address;

function encode(signature: string, args: unknown[]): Hex {
  const fn = parseFunction(signature);
  return encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args });
}

function strategies(calls: { strategy: string }[]): string[] {
  return calls.map((c) => c.strategy);
}

describe('findAddressWords', () => {
  it('finds an address argument at its word boundary', () => {
    const data = encode('mint(address,uint256)', [OTHER_MINTER, 2n]);
    expect(findAddressWords(data, OTHER_MINTER)).toEqual([0]);
  });

  it('finds every occurrence', () => {
    const data = encode('mint(address,address)', [OTHER_MINTER, OTHER_MINTER]);
    expect(findAddressWords(data, OTHER_MINTER)).toEqual([0, 64]);
  });

  it('finds nothing when the address is absent', () => {
    const data = encode('mint(address,uint256)', [OUR_WALLET, 2n]);
    expect(findAddressWords(data, OTHER_MINTER)).toEqual([]);
  });

  it('ignores an address that is not word-aligned', () => {
    // A run of matching bytes inside a bytes32 or a proof is not an argument,
    // and rewriting it would corrupt the payload.
    const embedded = ('0xaabbccdd' + '11'.repeat(6) + OTHER_MINTER.slice(2) + '00'.repeat(6)) as Hex;
    expect(findAddressWords(embedded, OTHER_MINTER)).toEqual([]);
  });

  it('does not treat the selector as part of the arguments', () => {
    expect(findAddressWords('0xa0712d68' as Hex, OTHER_MINTER)).toEqual([]);
  });
});

describe('swapAddressWords', () => {
  it('replaces the address and leaves everything else byte-identical', () => {
    const data = encode('mint(address,uint256)', [OTHER_MINTER, 7n]);
    const swapped = swapAddressWords(data, OTHER_MINTER, OUR_WALLET)!;

    const decoded = decodeFunctionData({
      abi: [parseFunction('mint(address,uint256)')] as Abi,
      data: swapped,
    });
    expect(decoded.args?.[0]).toBe(OUR_WALLET);
    expect(decoded.args?.[1]).toBe(7n);
  });

  it('returns nothing when there is no address to swap', () => {
    // The caller needs to know the difference between "swapped" and "nothing
    // to swap", because only the second means verbatim replay is correct.
    expect(swapAddressWords(encode('mint(uint256)', [1n]), OTHER_MINTER, OUR_WALLET))
      .toBeUndefined();
  });

  it('works on an entrypoint nobody has ever seen', () => {
    // The whole point: no ABI, no signature, no decode.
    const unknown = ('0xdeadbeef' +
      '0'.repeat(24) + OTHER_MINTER.slice(2).toLowerCase() +
      'ff'.repeat(32)) as Hex;
    const swapped = swapAddressWords(unknown, OTHER_MINTER, OUR_WALLET)!;

    expect(swapped.toLowerCase()).toContain(OUR_WALLET.slice(2).toLowerCase());
    expect(swapped.toLowerCase()).not.toContain(OTHER_MINTER.slice(2).toLowerCase());
    // Everything after the address is untouched.
    expect(swapped.toLowerCase().endsWith('ff'.repeat(32))).toBe(true);
    expect(swapped.slice(0, 10)).toBe('0xdeadbeef');
  });
});

describe('buildAutoMintCalls', () => {
  it('offers an address swap first when the minter is known', () => {
    // Highest confidence: their own address, found in their own calldata.
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 2n]);
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'),
      observed,
      observedSender: OTHER_MINTER,
    });
    expect(strategies(calls)[0]).toBe('address-swap');
  });

  it('mints to us, never to the wallet it copied', () => {
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 2n]);
    const [call] = buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'),
      observed,
      observedSender: OTHER_MINTER,
    });

    const built = call.buildFor(OUR_WALLET);
    expect(built.toLowerCase()).toContain(OUR_WALLET.slice(2).toLowerCase());
    expect(built.toLowerCase()).not.toContain(OTHER_MINTER.slice(2).toLowerCase());

    const decoded = decodeFunctionData({
      abi: [parseFunction('mint(address,uint256)')] as Abi,
      data: built,
    });
    // The quantity a real minter used survives.
    expect(decoded.args?.[1]).toBe(2n);
  });

  it('handles an entrypoint it has never seen, given the sender', () => {
    // This is the case the old implementation refused outright, and the reason
    // most collections could not be auto-minted.
    const unknown = ('0xdeadbeef' +
      '0'.repeat(24) + OTHER_MINTER.slice(2).toLowerCase() +
      '0'.repeat(63) + '3') as Hex;
    const calls = buildAutoMintCalls({
      selector: '0xdeadbeef' as Hex,
      observed: unknown,
      observedSender: OTHER_MINTER,
    });

    expect(strategies(calls)).toContain('address-swap');
    expect(calls[0].buildFor(OUR_WALLET).toLowerCase())
      .toContain(OUR_WALLET.slice(2).toLowerCase());
  });

  it('still offers verbatim replay for an unknown entrypoint with no sender', () => {
    // No ABI and no address to swap. Replaying exactly is the only remaining
    // option, and it is the right one whenever there is no recipient encoded.
    const calls = buildAutoMintCalls({
      selector: '0xdeadbeef' as Hex,
      observed: '0xdeadbeef0000000000000000000000000000000000000000000000000000000000000001' as Hex,
    });
    expect(strategies(calls)).toEqual(['verbatim']);
  });

  it('offers an ABI decode for a recognised signature', () => {
    const observed = encode('safeMint(address,uint256)', [OTHER_MINTER, 1n]);
    const calls = buildAutoMintCalls({
      selector: selectorOf('safeMint(address,uint256)'),
      observed,
    });
    expect(strategies(calls)).toContain('abi-decode');
  });

  it('collapses candidates that produce identical calldata', () => {
    // With no recipient there is nothing to rewrite, so every route lands on
    // the same bytes and offering three of them would just cost round trips.
    const observed = encode('mint(uint256)', [3n]);
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(uint256)'),
      observed,
      observedSender: OTHER_MINTER,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].buildFor(OUR_WALLET)).toBe(observed);
  });

  it('preserves extra arguments such as a merkle proof', () => {
    const proof = [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ] as Hex[];
    const observed = encode('whitelistMint(uint256,bytes32[])', [5n, proof]);
    const calls = buildAutoMintCalls({
      selector: selectorOf('whitelistMint(uint256,bytes32[])'),
      observed,
    });
    expect(calls[0].buildFor(OUR_WALLET)).toBe(observed);
  });

  it('builds distinct calldata per wallet, so each mints to itself', () => {
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 1n]);
    const [call] = buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'),
      observed,
      observedSender: OTHER_MINTER,
    });
    const walletB = '0x3333333333333333333333333333333333333333' as Address;
    expect(call.buildFor(OUR_WALLET)).not.toBe(call.buildFor(walletB));
    expect(call.buildFor(walletB).toLowerCase()).toContain(walletB.slice(2).toLowerCase());
  });

  it('produces nothing without observed calldata', () => {
    // There is no fallback to guessing: with nothing to copy there is nothing
    // to send, and saying so beats inventing a call.
    expect(buildAutoMintCalls({ selector: selectorOf('mint(uint256)') })).toEqual([]);
    expect(buildAutoMintCalls({ observed: '0x' as Hex })).toEqual([]);
  });

  it('skips an ABI decode that does not match, keeping the other routes', () => {
    // Right selector, truncated arguments. The decode fails; replay does not.
    const malformed = `${selectorOf('mint(address,uint256)')}1234` as Hex;
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'),
      observed: malformed,
    });
    expect(strategies(calls)).not.toContain('abi-decode');
    expect(strategies(calls)).toContain('verbatim');
  });

  it('explains each candidate in words', () => {
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 1n]);
    for (const call of buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'), observed, observedSender: OTHER_MINTER,
    })) {
      expect(call.describe.length).toBeGreaterThan(20);
    }
  });
});

describe('taking the whole per-wallet allowance', () => {
  it('finds the quantity in a single-argument mint', () => {
    expect(findQuantityWord(encode('mint(uint256)', [1n]))).toBe(0);
  });

  it('refuses when two arguments could both be the quantity', () => {
    // Guessing wrong here corrupts the call, and there is no way to tell
    // `mint(uint256 id, uint256 qty)` from its opposite without an ABI.
    expect(findQuantityWord(encode('mint(uint256,uint256)', [2n, 3n]))).toBeUndefined();
  });

  it('refuses a payload carrying an address', () => {
    // An address is a huge number; treating it as a count would be absurd, and
    // overwriting it would send the mint somewhere else entirely.
    expect(findQuantityWord(encode('mint(address,uint256)', [OTHER_MINTER, 1n])))
      .toBeUndefined();
  });

  it('refuses a merkle proof', () => {
    const proof = ['0x' + 'ab'.repeat(32)] as Hex[];
    expect(findQuantityWord(encode('whitelistMint(uint256,bytes32[])', [1n, proof])))
      .toBeUndefined();
  });

  it('refuses a token id far too large to be a count', () => {
    expect(findQuantityWord(encode('mint(uint256)', [99_999_999n]))).toBeUndefined();
  });

  it('rewrites the quantity and nothing else', () => {
    const bumped = setQuantity(encode('mint(uint256)', [1n]), 5n)!;
    const decoded = decodeFunctionData({
      abi: [parseFunction('mint(uint256)')] as Abi, data: bumped,
    });
    expect(decoded.args?.[0]).toBe(5n);
    expect(bumped.slice(0, 10)).toBe(selectorOf('mint(uint256)'));
  });

  it('offers the full allowance first, and the observed quantity after', () => {
    // First because it is strictly better when it works; still followed by the
    // original, because a contract can cap per transaction more tightly than
    // per wallet and the simulation has to have something to fall back to.
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(uint256)'),
      observed: encode('mint(uint256)', [1n]),
      quantity: 5n,
    });
    expect(calls[0].label).toBe('take all 5 at once');
    expect(calls).toHaveLength(2);

    const decoded = decodeFunctionData({
      abi: [parseFunction('mint(uint256)')] as Abi, data: calls[0].buildFor(OUR_WALLET),
    });
    expect(decoded.args?.[0]).toBe(5n);
  });

  it('still mints to us when the payload also carries a recipient', () => {
    // mint(address,uint256) has no locatable quantity, so the bulk candidate is
    // skipped — but the address swap must still be there.
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(address,uint256)'),
      observed: encode('mint(address,uint256)', [OTHER_MINTER, 1n]),
      observedSender: OTHER_MINTER,
      quantity: 5n,
    });
    expect(strategies(calls)[0]).toBe('address-swap');
    expect(calls[0].buildFor(OUR_WALLET).toLowerCase())
      .not.toContain(OTHER_MINTER.slice(2).toLowerCase());
  });

  it('does nothing when the allowance is one', () => {
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(uint256)'),
      observed: encode('mint(uint256)', [1n]),
      quantity: 1n,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].label).not.toMatch(/take all/);
  });

  it('ignores an allowance too large to be real', () => {
    const calls = buildAutoMintCalls({
      selector: selectorOf('mint(uint256)'),
      observed: encode('mint(uint256)', [1n]),
      quantity: 10n ** 30n,
    });
    expect(calls.every((c) => !/take all/.test(c.label))).toBe(true);
  });
});

describe('buildAutoMintCall', () => {
  it('returns the best single candidate', () => {
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 2n]);
    const call = buildAutoMintCall(
      selectorOf('mint(address,uint256)'), observed, OTHER_MINTER,
    );
    expect(call?.strategy).toBe('address-swap');
  });

  it('returns nothing when there is nothing to copy', () => {
    expect(buildAutoMintCall(selectorOf('mint(uint256)'), undefined)).toBeUndefined();
  });
});

describe('recoverSampleSender', () => {
  const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  it('recovers the address that signed the sampled transaction', async () => {
    // This is what makes the ABI-free swap possible at all.
    const account = privateKeyToAccount(KEY);
    const raw = await account.signTransaction({
      to: '0x00000000000000000000000000000000000000aa',
      value: 0n,
      data: encode('mint(address,uint256)', [account.address, 1n]),
      nonce: 0, gas: 250_000n, maxFeePerGas: 500_000_000n, maxPriorityFeePerGas: 0n,
      chainId: 46630, type: 'eip1559',
    } as never);

    expect(await recoverSampleSender(raw as Hex)).toBe(account.address);
  });

  it('returns nothing rather than throwing on junk', async () => {
    expect(await recoverSampleSender('0xdead' as Hex)).toBeUndefined();
    expect(await recoverSampleSender(undefined)).toBeUndefined();
  });
});
