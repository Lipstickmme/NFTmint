import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { buildAutoMintCall } from '../src/autopilot.js';
import { parseFunction, selectorOf } from '../src/calldata.js';

/**
 * The safety-critical path in autopilot: turning calldata observed from a
 * stranger into calldata that mints to US.
 *
 * The failure this guards against is silent and total — replaying an observed
 * `mint(address,uint256)` verbatim mints the NFT to the wallet we copied it
 * from, while still costing full gas and producing a successful receipt.
 */

const OUR_WALLET = '0x1111111111111111111111111111111111111111' as Address;
const OTHER_MINTER = '0x2222222222222222222222222222222222222222' as Address;

function encode(signature: string, args: unknown[]): Hex {
  const fn = parseFunction(signature);
  return encodeFunctionData({ abi: [fn] as Abi, functionName: fn.name, args });
}

describe('buildAutoMintCall', () => {
  it('replays calldata verbatim when there is no recipient argument', () => {
    const observed = encode('mint(uint256)', [3n]);
    const call = buildAutoMintCall(selectorOf('mint(uint256)'), observed);

    expect(call).toBeDefined();
    expect(call!.verbatim).toBe(true);
    expect(call!.buildFor(OUR_WALLET)).toBe(observed);
    expect(call!.signature).toBe('mint(uint256)');
  });

  it('rewrites the recipient to our wallet instead of the observed minter', () => {
    const observed = encode('mint(address,uint256)', [OTHER_MINTER, 2n]);
    const call = buildAutoMintCall(selectorOf('mint(address,uint256)'), observed);

    expect(call).toBeDefined();
    expect(call!.verbatim).toBe(false);

    const built = call!.buildFor(OUR_WALLET);
    expect(built).not.toBe(observed);
    expect(built.toLowerCase()).toContain(OUR_WALLET.slice(2).toLowerCase());
    expect(built.toLowerCase()).not.toContain(OTHER_MINTER.slice(2).toLowerCase());

    // The quantity a real minter used is preserved.
    const decoded = decodeFunctionData({
      abi: [parseFunction('mint(address,uint256)')] as Abi,
      data: built,
    });
    expect(decoded.args?.[0]).toBe(OUR_WALLET);
    expect(decoded.args?.[1]).toBe(2n);
  });

  it('builds distinct calldata per wallet, so each mints to itself', () => {
    const observed = encode('safeMint(address,uint256)', [OTHER_MINTER, 1n]);
    const call = buildAutoMintCall(selectorOf('safeMint(address,uint256)'), observed)!;

    const walletB = '0x3333333333333333333333333333333333333333' as Address;
    expect(call.buildFor(OUR_WALLET)).not.toBe(call.buildFor(walletB));
    expect(call.buildFor(walletB).toLowerCase()).toContain(walletB.slice(2).toLowerCase());
  });

  it('preserves extra arguments such as a merkle proof', () => {
    const proof = [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ] as Hex[];
    const observed = encode('whitelistMint(uint256,bytes32[])', [5n, proof]);
    const call = buildAutoMintCall(selectorOf('whitelistMint(uint256,bytes32[])'), observed)!;

    // No address argument, so verbatim replay keeps the proof intact.
    expect(call.verbatim).toBe(true);
    expect(call.buildFor(OUR_WALLET)).toBe(observed);
  });

  it('refuses an unknown selector rather than guessing', () => {
    // Sending unrecognized calldata to an unaudited contract is how wallets
    // get drained; declining is the correct behaviour.
    expect(buildAutoMintCall('0xdeadbeef' as Hex, '0xdeadbeef' as Hex)).toBeUndefined();
  });

  it('refuses when there is no observed calldata to learn from', () => {
    expect(buildAutoMintCall(selectorOf('mint(uint256)'), undefined)).toBeUndefined();
    expect(buildAutoMintCall(undefined, '0xa0712d68' as Hex)).toBeUndefined();
  });

  it('refuses calldata that does not decode against its own selector', () => {
    // Right selector, truncated arguments — malformed or a different ABI.
    const malformed = `${selectorOf('mint(address,uint256)')}1234` as Hex;
    expect(buildAutoMintCall(selectorOf('mint(address,uint256)'), malformed)).toBeUndefined();
  });

  it('handles a zero-argument mint', () => {
    const observed = encode('mint()', []);
    const call = buildAutoMintCall(selectorOf('mint()'), observed)!;
    expect(call.verbatim).toBe(true);
    expect(call.buildFor(OUR_WALLET)).toBe(observed);
  });

  it('rewrites a single-address mint(address)', () => {
    const observed = encode('mint(address)', [OTHER_MINTER]);
    const call = buildAutoMintCall(selectorOf('mint(address)'), observed)!;

    const built = call.buildFor(OUR_WALLET);
    expect(built.toLowerCase()).toContain(OUR_WALLET.slice(2).toLowerCase());
    expect(built.toLowerCase()).not.toContain(OTHER_MINTER.slice(2).toLowerCase());
  });
});
