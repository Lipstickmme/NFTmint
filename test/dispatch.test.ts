import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The single serverless entrypoint.
 *
 * Two failures live here, and both were expensive to diagnose, so both get a
 * test rather than a comment.
 *
 * **The build crash.** Vercel scans every file in `api/` with ts-morph, which
 * bundles TypeScript 4.4.4. Walking an entrypoint's types reaches abitype's
 * declarations, whose syntax 4.4 cannot parse; it then tries to report
 * "Type alias name cannot be '{0}'", omits the argument, and its own formatter
 * asserts. What surfaces is `Error: Debug Failure.` — no file, no line, no
 * hint that the problem is a transitive dependency's type definitions. Keeping
 * the entrypoint free of static `src/` imports is what avoids it.
 *
 * **The empty bundle.** Vercel's tracer follows literal `import()` specifiers
 * and not variables. Routing through a variable built a function that deployed
 * green and then failed every request on a missing module.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatcher = readFileSync(path.join(here, '..', 'api', '[...path].ts'), 'utf8');
const devserver = readFileSync(path.join(here, '..', 'src', 'devserver.ts'), 'utf8');

/** Route names on the left of the dispatcher's table. */
function deployedRoutes(source: string): string[] {
  return [...source.matchAll(/^\s{2}([a-z][a-z0-9-]*): \(\) => import\(/gm)]
    .map((m) => m[1])
    .sort();
}

/** Route names the local dev server mounts. */
function localRoutes(source: string): string[] {
  return [...source.matchAll(/'\/api\/([a-z][a-z0-9-]*)':/g)].map((m) => m[1]).sort();
}

describe('the api entrypoint', () => {
  it('is the only file in api/', async () => {
    // One function serves every route, which is also what keeps the
    // deployment under the twelve-function cap on a Hobby plan.
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(path.join(here, '..', 'api')).filter((f) => f.endsWith('.ts'));
    expect(files).toEqual(['[...path].ts']);
  });

  it('imports nothing from src/ at the top level', () => {
    // The guard against the build crash. A static import here drags the whole
    // type graph — viem, abitype — into a parser that cannot read it.
    const staticImports = [...dispatcher.matchAll(/^import\s.*from\s+'([^']+)'/gm)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('node:'));
    expect(staticImports).toEqual([]);
  });

  it('reaches its routes through literal import() specifiers', () => {
    // The guard against the empty bundle: a variable specifier is invisible to
    // Vercel's tracer, and the modules simply would not ship.
    const routes = deployedRoutes(dispatcher);
    expect(routes.length).toBeGreaterThan(10);
    for (const name of routes) {
      expect(dispatcher).toContain(`import('../src/routes/${name}.js')`);
    }
  });

  it('never builds a module specifier out of the request', () => {
    // These are import() targets. Deriving one from the URL would let a caller
    // load any file on disk, so every argument must be a literal.
    const code = dispatcher
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');       // line comments

    const args = [...code.matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(args.length).toBeGreaterThan(10);
    for (const arg of args) {
      expect(arg, `import(${arg}) is not a literal`).toMatch(/^'[^']+'$/);
    }
  });

  it('serves exactly the routes the dev server does', () => {
    // Drift between the two tables means a route that works locally 404s in
    // production, which is a miserable thing to debug.
    expect(deployedRoutes(dispatcher)).toEqual(localRoutes(devserver));
  });

  it('points every route at a file that exists', async () => {
    const { existsSync } = await import('node:fs');
    for (const name of deployedRoutes(dispatcher)) {
      const file = path.join(here, '..', 'src', 'routes', `${name}.ts`);
      expect(existsSync(file), `src/routes/${name}.ts is missing`).toBe(true);
    }
  });
});

describe('route handlers', () => {
  it('use no inline type modifiers in their imports', async () => {
    // `import { a, type B }` is TypeScript 4.5 syntax. The 4.4.4 parser Vercel
    // runs over this tree emits a diagnostic for every one, and diagnostics are
    // the path that crashes it.
    const { readdirSync } = await import('node:fs');
    const dir = path.join(here, '..', 'src', 'routes');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      if (/^import \{[^}]*\btype /m.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
