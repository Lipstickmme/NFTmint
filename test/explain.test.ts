import { describe, it, expect } from 'vitest';
import { explainChainError, revertReason, stripNoise } from '../src/explain.js';

/**
 * Turning node errors into sentences.
 *
 * Two jobs, and the second is why this is not cosmetic: the raw strings say
 * nothing useful to the person watching a bot, and they carry the endpoint —
 * which is how an operator's API key ended up rendered in the browser.
 */

describe('stripNoise', () => {
  it('removes the code and the endpoint', () => {
    expect(stripNoise('execution reverted (code 3) [rpc.example.com]')).toBe('');
  });

  it('leaves a plain message alone', () => {
    expect(stripNoise('something odd happened')).toBe('something odd happened');
  });
});

describe('revertReason', () => {
  it('pulls out the reason the contract gave', () => {
    // The single most useful thing in the whole message, when it exists.
    expect(revertReason('execution reverted: Sale not started (code 3)'))
      .toBe('Sale not started');
  });

  it('finds nothing when the node gave no reason', () => {
    expect(revertReason('execution reverted (code 3)')).toBeUndefined();
  });

  it('ignores a wall of hex echoed back as a reason', () => {
    expect(revertReason('execution reverted: 0x08c379a0000000000000000000'))
      .toBeUndefined();
  });
});

describe('explainChainError', () => {
  it('never repeats an endpoint, so a key cannot ride along', () => {
    const raw = 'execution reverted (code 3) [https://x.g.alchemy.com/v2/My-secret-key]';
    const explained = explainChainError(raw);
    expect(explained).not.toContain('alchemy');
    expect(explained).not.toContain('My-secret-key');
    expect(explained).toBe('the contract refused it');
  });

  it('keeps the revert reason when there is one', () => {
    expect(explainChainError('execution reverted: Max per wallet (code 3) [host]'))
      .toBe('the contract refused it: "Max per wallet"');
  });

  for (const [raw, expected] of [
    ['insufficient funds for gas * price + value', 'that wallet does not hold enough ETH for gas'],
    ['nonce too low', 'that transaction slot was already used'],
    ['already known', 'that transaction slot was already used'],
    ['replacement transaction underpriced', 'a transaction from that wallet is already in flight'],
    ['intrinsic gas too low', 'the gas limit was too low for this contract'],
    ['max fee per gas less than block base fee', 'the fee ceiling is below the current base fee — raise MAX_FEE_GWEI'],
    ['RPC timeout after 10000ms [host]', 'the RPC endpoint did not answer'],
    ['socket hang up', 'the RPC endpoint did not answer'],
    ['fetch failed', 'the RPC endpoint did not answer'],
    ['Your app has exceeded its rate limit', 'the RPC endpoint is rate limiting us'],
    ['Unauthorized', 'the RPC endpoint rejected our key'],
  ] as const) {
    it(`explains "${raw.slice(0, 34)}"`, () => {
      expect(explainChainError(raw)).toBe(expected);
    });
  }

  it('passes an unrecognised message through, minus the machine parts', () => {
    // Better than replacing it with a guess: the original still says something.
    expect(explainChainError('the moon is in the wrong phase (code 7) [host]'))
      .toBe('the moon is in the wrong phase');
  });

  it('handles an Error object and an empty value alike', () => {
    expect(explainChainError(new Error('nonce too low'))).toContain('slot');
    expect(explainChainError(undefined)).toBe('it failed for an unknown reason');
  });
});
