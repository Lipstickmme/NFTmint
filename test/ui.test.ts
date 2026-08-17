import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

/**
 * Guards on the shipped control panel.
 *
 * These exist because a syntax error once made it to production. The page is a
 * single file of inline JavaScript that nothing compiled or type-checked, so a
 * broken template literal parsed fine as *HTML*, deployed cleanly, and then
 * failed silently in the browser: the whole script aborted, every onclick
 * handler was left undefined, and the entire UI appeared dead with no error
 * anywhere in the build.
 *
 * Parsing the script here turns that class of failure into a failing test.
 */

const uiPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'index.html',
);
const html = readFileSync(uiPath, 'utf8');

function inlineScripts(source: string): string[] {
  return [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
}

describe('control panel', () => {
  it('has exactly one inline script', () => {
    expect(inlineScripts(html)).toHaveLength(1);
  });

  it('parses as valid JavaScript', () => {
    // The regression guard. `new vm.Script` compiles without executing, so a
    // syntax error throws here instead of silently killing the page.
    for (const script of inlineScripts(html)) {
      expect(() => new vm.Script(script)).not.toThrow();
    }
  });

  it('defines every function referenced by an onclick handler', () => {
    // A handler naming a function that does not exist is the same failure as a
    // parse error from the user's point of view: the button does nothing.
    const handlers = [...html.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]);
    expect(handlers.length).toBeGreaterThan(0);

    const script = inlineScripts(html)[0];
    for (const name of new Set(handlers)) {
      const declared = new RegExp(`function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=`);
      expect(declared.test(script), `onclick="${name}()" has no definition`).toBe(true);
    }
  });

  it('references only element ids that exist in the markup', () => {
    // $('foo') on a missing element returns null, and the first property access
    // throws — taking the rest of the script's execution with it.
    const script = inlineScripts(html)[0];
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

    const missing = [...used].filter((id) => !ids.has(id));
    expect(missing, `script reads ids that are not in the HTML: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('keeps the page version in step with the server', async () => {
    const { UI_VERSION } = await import('../src/version.js');
    const declared = /(?:const|let|var)\s+PAGE_VERSION\s*=\s*'([^']+)'/.exec(html)?.[1];
    // A mismatch would make every correctly-served page claim to be stale.
    expect(declared).toBe(UI_VERSION);
  });

  it('escapes interpolated values before putting them in the DOM', () => {
    const script = inlineScripts(html)[0];
    expect(script).toMatch(/function esc\(/);
    // Chain data and server errors both reach the page as text.
    expect(script).toMatch(/esc\(/);
  });
});
