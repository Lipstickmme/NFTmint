import { describe, it, expect } from 'vitest';
import { resolveUri } from '../src/nftimage.js';

/**
 * Metadata URLs come from unaudited contracts, so this is untrusted input:
 * anything not recognised must resolve to nothing rather than be followed.
 */
describe('resolveUri', () => {
  it('rewrites ipfs:// to a gateway URL', () => {
    expect(resolveUri('ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'))
      .toBe('https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco');
  });

  it('handles the ipfs://ipfs/ double-prefix form', () => {
    expect(resolveUri('ipfs://ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'))
      .toBe('https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco');
  });

  it('passes http and https through unchanged', () => {
    expect(resolveUri('https://cdn.example.com/1.png')).toBe('https://cdn.example.com/1.png');
    expect(resolveUri('http://cdn.example.com/1.png')).toBe('http://cdn.example.com/1.png');
  });

  it('keeps data: URIs, which are fully on-chain art', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    expect(resolveUri(svg)).toBe(svg);
  });

  it('accepts a bare CID', () => {
    expect(resolveUri('QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco'))
      .toContain('https://ipfs.io/ipfs/Qm');
  });

  it('refuses schemes that should never be fetched', () => {
    // A contract returning any of these must not cause a request.
    expect(resolveUri('file:///etc/passwd')).toBeUndefined();
    expect(resolveUri('ftp://example.com/x')).toBeUndefined();
    expect(resolveUri('javascript:alert(1)')).toBeUndefined();
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(resolveUri('')).toBeUndefined();
    expect(resolveUri('   ')).toBeUndefined();
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(resolveUri('  https://x.test/a.png  ')).toBe('https://x.test/a.png');
  });
});
