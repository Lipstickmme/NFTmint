/**
 * Chain and RPC errors, in words.
 *
 * The raw strings are written for whoever is debugging a node, not for whoever
 * is watching a bot: `execution reverted (code 3) [rpc.example.com]` says
 * almost nothing to someone wondering why their mint did not happen, and the
 * error that prompted this also carried an API key.
 *
 * Every branch here answers the same question — what does this mean for me, and
 * is there anything I can do? Anything unrecognised is passed through with its
 * machine decoration stripped rather than replaced by a guess.
 */

/** Strip `(code N)`, `[host]`, and JSON-RPC prefixes from a raw message. */
export function stripNoise(raw: string): string {
  return raw
    .replace(/\s*\(code -?\d+\)/g, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/^(Error|JsonRpcError):\s*/i, '')
    .replace(/^execution reverted:?\s*/i, '')
    .trim();
}

/**
 * A revert reason, when the node bothered to include one.
 *
 * This is the single most useful thing in the whole message when it exists —
 * "Sale not started", "Max per wallet" — so it is worth digging out.
 */
export function revertReason(raw: string): string | undefined {
  if (!/revert/i.test(raw)) return undefined;
  // Strip first, then read what is left. Trying to match the reason in place
  // means competing with `(code 3)` and `[host]` for the same trailing text.
  const reason = stripNoise(raw).replace(/^["']|["']$/g, '').trim();
  if (reason.length < 2) return undefined;
  // Some nodes echo the whole payload back; a wall of hex is not a reason.
  if (/^0x[0-9a-fA-F]{8,}$/.test(reason)) return undefined;
  return reason;
}

export function explainChainError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? '');
  const lower = text.toLowerCase();

  if (lower.includes('execution reverted') || lower.includes('revert')) {
    const reason = revertReason(text);
    return reason
      ? `the contract refused it: "${reason}"`
      : 'the contract refused it';
  }
  if (lower.includes('insufficient funds')) {
    return 'that wallet does not hold enough ETH for gas';
  }
  if (lower.includes('nonce too low') || lower.includes('already known')) {
    return 'that transaction slot was already used';
  }
  if (lower.includes('replacement transaction underpriced')) {
    return 'a transaction from that wallet is already in flight';
  }
  if (lower.includes('intrinsic gas too low') || lower.includes('gas required exceeds')) {
    return 'the gas limit was too low for this contract';
  }
  if (lower.includes('max fee per gas less than block base fee')) {
    return 'the fee ceiling is below the current base fee — raise MAX_FEE_GWEI';
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return 'the RPC endpoint is rate limiting us';
  }
  if (
    lower.includes('timeout') ||
    lower.includes('socket hang up') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed')
  ) {
    return 'the RPC endpoint did not answer';
  }
  if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) {
    return 'the RPC endpoint rejected our key';
  }

  const cleaned = stripNoise(text);
  return cleaned.length > 0 ? cleaned : 'it failed for an unknown reason';
}

/**
 * Why a mint that passed every rule still did not happen.
 *
 * Kept separate from the error itself because the useful half is usually not
 * the message — it is the short list of things that actually cause this.
 */
export const WHY_A_MINT_FAILS =
  'Usually that means a per-wallet limit is already reached, the wallet is not ' +
  'on the allowlist, or the sale closed between the scan and the attempt.';
