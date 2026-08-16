import { describe, it, expect } from 'vitest';
import {
  buildCalldata,
  selectorOf,
  selectorFromCalldata,
  parseFunction,
  CalldataError,
  SENDER_PLACEHOLDER,
} from '../src/calldata.js';

const SENDER = '0x1234567890123456789012345678901234567890' as const;

describe('selectorOf', () => {
  // Cross-checked against well-known public selectors.
  it('computes known selectors', () => {
    expect(selectorOf('mint(uint256)')).toBe('0xa0712d68');
    expect(selectorOf('transfer(address,uint256)')).toBe('0xa9059cbb');
    expect(selectorOf('balanceOf(address)')).toBe('0x70a08231');
    expect(selectorOf('approve(address,uint256)')).toBe('0x095ea7b3');
  });

  it('accepts a signature with or without the function keyword', () => {
    expect(selectorOf('function mint(uint256)')).toBe(selectorOf('mint(uint256)'));
  });
});

describe('buildCalldata', () => {
  it('encodes a uint256 argument', () => {
    const data = buildCalldata({
      functionSignature: 'mint(uint256)',
      args: ['3'],
      sender: SENDER,
    });
    expect(data).toBe(
      '0xa0712d680000000000000000000000000000000000000000000000000000000000000003',
    );
  });

  it('substitutes $SENDER for the minting wallet address', () => {
    const data = buildCalldata({
      functionSignature: 'mint(address,uint256)',
      args: [SENDER_PLACEHOLDER, '2'],
      sender: SENDER,
    });
    // Address is left-padded into a 32-byte word.
    expect(data.slice(0, 10)).toBe(selectorOf('mint(address,uint256)'));
    expect(data.toLowerCase()).toContain(SENDER.slice(2).toLowerCase());
    expect(data.endsWith('2')).toBe(true);
  });

  it('encodes an array argument such as a merkle proof', () => {
    const proof = [
      '0x1111111111111111111111111111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222222222222222222222222222',
    ];
    const data = buildCalldata({
      functionSignature: 'whitelistMint(uint256,bytes32[])',
      args: ['1', JSON.stringify(proof)],
      sender: SENDER,
    });
    expect(data.slice(0, 10)).toBe(selectorOf('whitelistMint(uint256,bytes32[])'));
    expect(data).toContain('1111111111111111111111111111111111111111111111111111111111111111');
    expect(data).toContain('2222222222222222222222222222222222222222222222222222222222222222');
  });

  it('passes raw calldata through untouched', () => {
    const raw = '0xdeadbeef00000000000000000000000000000000000000000000000000000000';
    const data = buildCalldata({ rawCalldata: raw, args: [], sender: SENDER });
    expect(data).toBe(raw);
  });

  it('rejects an argument-count mismatch with a message naming the expected types', () => {
    expect(() =>
      buildCalldata({
        functionSignature: 'mint(uint256)',
        args: ['1', '2'],
        sender: SENDER,
      }),
    ).toThrow(/expects 1 argument\(s\) but 2 were provided/);
  });

  it('rejects a malformed address argument', () => {
    expect(() =>
      buildCalldata({
        functionSignature: 'mint(address,uint256)',
        args: ['not-an-address', '1'],
        sender: SENDER,
      }),
    ).toThrow(CalldataError);
  });

  it('rejects $SENDER in a non-address position', () => {
    expect(() =>
      buildCalldata({
        functionSignature: 'mint(uint256)',
        args: [SENDER_PLACEHOLDER],
        sender: SENDER,
      }),
    ).toThrow(/can only fill an address argument/);
  });

  it('throws when given neither calldata nor a signature', () => {
    expect(() => buildCalldata({ args: [], sender: SENDER })).toThrow(CalldataError);
  });
});

describe('parseFunction', () => {
  it('extracts name and input types', () => {
    const fn = parseFunction('whitelistMint(uint256,bytes32[])');
    expect(fn.name).toBe('whitelistMint');
    expect(fn.inputs.map((i) => i.type)).toEqual(['uint256', 'bytes32[]']);
  });

  it('throws on nonsense input', () => {
    expect(() => parseFunction('this is not a signature')).toThrow(CalldataError);
  });
});

describe('selectorFromCalldata', () => {
  it('extracts the leading four bytes', () => {
    expect(selectorFromCalldata('0xa0712d6800000000')).toBe('0xa0712d68');
  });

  it('returns undefined for calldata shorter than a selector', () => {
    expect(selectorFromCalldata('0x1234')).toBeUndefined();
  });
});
