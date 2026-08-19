import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Loads the real control panel in a real browser and uses it.
 *
 * The unit guards catch a script that fails to parse. This catches everything
 * after that: a handler that throws on click, a token that silently fails to
 * save, a render path that breaks on the first response. The page had shipped
 * completely dead once, and no test at the time could have noticed, because
 * nothing ever executed the page.
 */

const uiPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'index.html',
);

let browser: Browser;
let server: http.Server;
let baseUrl: string;
let resetStub: () => void = () => {};

/** Serves the page plus just enough of the API for the UI to boot. */
function startStubServer(): Promise<{ server: http.Server; url: string; reset: () => void }> {
  const html = readFileSync(uiPath, 'utf8');
  // Rounds after the first return nothing, reproducing the case where a quiet
  // round used to wipe a finding off the screen.
  let huntCalls = 0;
  // Stands in for the server-side history, keyed by contract like the real
  // store, so the persistence tests exercise the round-trip rather than a
  // variable the page happens to be holding.
  let kept: Record<string, unknown>[] = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        build: { uiVersion: '7-history', commit: 'testing', deployedAt: 'local' },
        configured: { apiToken: true, privateKeys: true, rpcUrls: true, network: 'testnet', spendCeilingEth: '0.05', upstreamTracker: false },
        problems: [],
      });
    }
    if (url.pathname === '/api/status') {
      if (!req.headers.authorization) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing bearer token' }));
      }
      return json({
        network: 'testnet', chainId: 46630, observedChainId: 46630, blockNumber: '4242',
        rpcEndpoints: [{ url: 'http://stub', medianRttMs: 12 }],
        wallets: [{ address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', balanceEth: '0.5' }],
        spendCeilingEth: '0.05',
        criteria: {
          minMintsPerMinute: 30, minUniqueMinters: 8, minAttemptsInWindow: 15,
          maxAgeSec: 300, maxSelloutSec: 900, maxSupplyProgressPct: 90,
          freeOnly: true, requireLive: true, requireSaleOpen: true, skipIfOwned: true,
        },
      });
    }
    if (url.pathname === '/api/plan') {
      return json({
        resolvedVia: 'address',
        contract: '0x00000000000000000000000000000000000000aa',
        info: {
          hasCode: true, name: 'Stub Cats', symbol: 'SCAT',
          totalSupply: { value: '300', source: 'totalSupply()' },
          maxSupply: { value: '1000', source: 'maxSupply()' },
          progressPct: 30, remaining: '700', soldOut: false,
          priceWei: { value: '0', source: 'price()' },
          saleOpen: { value: true, source: 'saleIsActive()' },
          summary: 'Stub Cats · 300 of 1000 minted',
        },
        tried: [
          { signature: 'mint(uint256)', selector: '0xa0712d68', outcome: 'ok' },
          { signature: 'publicMint(uint256)', selector: '0x2db11544', outcome: 'revert', reason: 'unknown function' },
        ],
        chosen: { signature: 'mint(uint256)', args: ['1'], valueWei: '0', calldata: '0xa0712d68', gasLimit: '260000' },
        ready: true, blockers: [],
        advice: 'Ready to mint using mint(uint256) (free). Press Mint.',
      });
    }
    if (url.pathname === '/api/findings') {
      if (req.method === 'DELETE') {
        kept = [];
        return json({ cleared: true, storage: 'memory' });
      }
      const filter = url.searchParams.get('filter') ?? 'all';
      const rows = kept.filter((r) =>
        filter === 'passed' ? r.passed : filter === 'near' ? !r.passed : true,
      );
      return json({
        storage: 'memory',
        durable: false,
        count: rows.length,
        passed: rows.filter((r) => r.passed).length,
        nearMisses: rows.filter((r) => !r.passed).length,
        findings: rows,
      });
    }
    if (url.pathname === '/api/hunt') {
      huntCalls += 1;
      if (huntCalls === 1) {
        // The real cycle records passers and near misses before returning.
        const now = new Date().toISOString();
        kept = [
          {
            contract: '0x00000000000000000000000000000000000000aa',
            name: 'Stub Cats', firstSeenAt: now, lastSeenAt: now, timesSeen: 1,
            mintsPerMinute: 90, uniqueMinters: 22, remaining: '700', progressPct: 30,
            projectedSelloutSec: 466, isFree: true, passed: true, failedChecks: [],
            reason: 'qualified: 90/min from 22 wallets',
            outcome: 'practice mode — everything was prepared and signed, but nothing was sent.',
            minted: 0, txUrls: [],
          },
          {
            contract: '0x00000000000000000000000000000000000000bb',
            name: 'Almost Dogs', firstSeenAt: now, lastSeenAt: now, timesSeen: 2,
            mintsPerMinute: 44, uniqueMinters: 6, isFree: true, passed: false,
            failedChecks: ['unique minters'],
            reason: 'skipped: 6 wallets, needs 8',
            // Artwork and explorer URLs are attacker-influenced: token metadata
            // is written by whoever deployed the contract.
            imageUrl: 'javascript:alert(1)',
            txUrls: ['javascript:alert(2)'],
          },
        ];
      }
      if (huntCalls > 1) {
        return json({
          startedAt: new Date().toISOString(), durationMs: 5, sampledSeconds: 5,
          feedConnected: true, feedUrl: 'wss://stub',
          observed: { feedTxSeen: 300, mintsSeen: 90, contractsTracked: 8 },
          qualified: 0, mintedCollections: 0, dryRun: true, serverForcesDryRun: false,
          note: 'Sampled 5s; 0 of 8 collections were worth inspecting.',
          candidates: [],
        });
      }
      return json({
        startedAt: new Date().toISOString(), durationMs: 10, sampledSeconds: 5,
        feedConnected: true, feedUrl: 'wss://stub',
        observed: { feedTxSeen: 120, mintsSeen: 40, contractsTracked: 3 },
        qualified: 1, mintedCollections: 0, dryRun: true, note: 'stub',
        serverForcesDryRun: false,
        candidates: [{
          collection: {
            contract: '0x00000000000000000000000000000000000000aa', status: 'live',
            attemptsPerMinute: 90, uniqueMinters: 22, attemptsInWindow: 30, ageSec: 40,
            lastSeenSecAgo: 2, attempts: 60, isFree: true, observedValueWei: '0',
            freeAttempts: 60, paidAttempts: 0, totalValueWei: '0',
            firstSeenAt: Date.now(), lastSeenAt: Date.now(), flagged: true,
          },
          info: { hasCode: true, name: 'Stub Cats', remaining: '700', progressPct: 30, soldOut: false, summary: '' },
          evaluation: {
            contract: '0x00000000000000000000000000000000000000aa', passed: true,
            projectedSelloutSec: 466, reason: 'qualified: 90/min from 22 wallets',
            checks: [{ name: 'mint rate', passed: true, actual: '90/min', required: '>= 30/min', why: 'Fast means selling out.' }],
          },
          minted: {
            attempted: 0, accepted: 0, confirmed: 0, txs: [],
            error: 'practice mode — everything was prepared and signed, but nothing was sent.',
          },
        }],
      });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  // Reset is explicit rather than tied to serving the page: a test that
  // reloads to prove the history survived must not have the reload be what
  // clears it.
  const reset = (): void => {
    huntCalls = 0;
    kept = [];
  };

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        server: srv,
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        reset,
      });
    });
  });
}

/** Fails the test on any uncaught page error — the exact failure that shipped. */
async function openPage(): Promise<{ page: Page; errors: string[] }> {
  resetStub();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  return { page, errors };
}

/**
 * Locate a Chromium to drive.
 *
 * `playwright-core` deliberately downloads nothing — bundling the full
 * `playwright` package would have added a ~150MB browser fetch to every
 * production install, which is a poor trade for a test dependency. So we find
 * an existing browser instead, and skip rather than fail when there is none:
 * a machine without Chromium should not turn a green suite red.
 */
function findChromium(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const globbed = candidates.find((p) => existsSync(p));
  if (globbed) return globbed;

  // Any pinned build under the shared browsers directory.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const suffix of ['chromium', 'chromium-1194']) {
      const guess = path.join(root, suffix, 'chrome-linux', 'chrome');
      if (existsSync(guess)) return guess;
    }
  }
  return undefined;
}

const chromiumPath = findChromium();

beforeAll(async () => {
  if (!chromiumPath) return;
  browser = await chromium.launch({ executablePath: chromiumPath });
  const started = await startStubServer();
  server = started.server;
  baseUrl = started.url;
  resetStub = started.reset;
}, 90_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
});

// Skip cleanly when no browser is available, rather than failing.
describe.skipIf(!chromiumPath)('control panel in a browser', () => {
  it('loads with no JavaScript errors', async () => {
    const { page, errors } = await openPage();
    expect(errors).toEqual([]);
    await page.close();
  });

  it('defines the click handlers as real functions', async () => {
    const { page } = await openPage();
    for (const fn of ['toggleHunt', 'huntOnce', 'doPlan', 'doMint', 'saveToken', 'clearToken', 'resetRules', 'setPractice', 'pick', 'setRule']) {
      const type = await page.evaluate((name) => typeof (window as never)[name], fn);
      expect(type, `${fn} should be callable from onclick`).toBe('function');
    }
    await page.close();
  });

  it('saves and clears the API token', async () => {
    const { page, errors } = await openPage();
    await page.fill('#token', 'a-token-long-enough-to-pass');
    await page.click('button:has-text("Save")');

    expect(await page.evaluate(() => localStorage.getItem('nftmint_token'))).toBe('a-token-long-enough-to-pass');
    expect(await page.textContent('#tokenState')).toMatch(/saved/);

    await page.click('button:has-text("Clear")');
    expect(await page.evaluate(() => localStorage.getItem('nftmint_token'))).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows chain and wallet status once a token is set', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    const strip = await page.textContent('#stats');
    expect(strip).toContain('testnet');
    expect(strip).toContain('4242');
    expect(strip).toMatch(/1 \/ 1/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('checks a contract and unlocks the Mint button', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    expect(await page.isDisabled('#btnMint')).toBe(true);

    await page.fill('#target', '0x00000000000000000000000000000000000000aa');
    await page.click('#btnCheck');
    await page.waitForFunction(() => !(document.getElementById('btnMint') as HTMLButtonElement).disabled, null, { timeout: 8000 });

    const plan = await page.textContent('#planOut');
    expect(plan).toContain('Ready to mint');
    expect(plan).toContain('mint(uint256)');
    expect(plan).toContain('700');
    expect(plan).toContain('left');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('runs a hunt round and renders the verdict table', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#huntOut .row', { timeout: 8000 });

    // The round panel carries the full reasoning for what it just checked.
    const round = await page.textContent('#huntOut');
    expect(round).toContain('90/min');
    expect(round).toContain('mint rate');
    expect(await page.textContent('#log')).toMatch(/40 mints seen/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows why a passing collection was not bought', async () => {
    // The reported failure: a collection cleared every rule and nothing
    // happened, with the reason hidden inside a collapsed section.
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#huntOut .row', { timeout: 8000 });

    const shown = await page.textContent('#huntOut');
    expect(shown).toContain('Passed, but not bought');
    expect(shown).toContain('practice mode');
    // And it must be visible without expanding anything.
    expect(await page.textContent('#log')).toContain('NOT BOUGHT');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('keeps a passing collection after a later empty round', async () => {
    // The reported failure: a round passed a collection, then the next quiet
    // round replaced the whole panel and the evidence was gone. The record now
    // lives on the server, so the empty round can wipe the panel harmlessly.
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#findings .row', { timeout: 8000 });
    expect(await page.textContent('#findings')).toContain('Stub Cats');

    await page.click('#btnOnce');
    await page.waitForFunction(
      () => (document.getElementById('huntOut')?.textContent ?? '').includes('worth inspecting'),
      null, { timeout: 8000 });

    const kept = await page.textContent('#findings');
    expect(kept).toContain('Stub Cats');
    expect(kept).toContain('Passed, but not bought');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('reloads the saved history after a refresh', async () => {
    // The whole point of the backend: the record must outlive the page.
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#findings .row', { timeout: 8000 });

    // A fresh page holds nothing itself, so anything shown came from the server.
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('#findings .row', { timeout: 8000 });
    expect(await page.textContent('#findings')).toContain('Stub Cats');
    expect(errors).toEqual([]);
    await page.close();
  }, 20_000);

  it('filters the history down to near misses', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#findings .row', { timeout: 8000 });
    expect(await page.textContent('#findings')).toContain('Almost Dogs');

    await page.click('#findings button:has-text("Near misses")');
    await page.waitForFunction(
      () => !(document.getElementById('findings')?.textContent ?? '').includes('Stub Cats'),
      null, { timeout: 8000 });

    const near = await page.textContent('#findings');
    expect(near).toContain('Almost Dogs');
    // A near miss names what to loosen, which is the reason to keep it at all.
    expect(near).toContain('unique minters');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('refuses to render a javascript: URL from collection metadata', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    await page.click('#btnOnce');
    await page.waitForSelector('#findings .row', { timeout: 8000 });

    const hostile = await page.evaluate(() =>
      [...document.querySelectorAll('[src],[href]')]
        .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
        .filter((v) => v.toLowerCase().startsWith('javascript:')),
    );
    expect(hostile).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('toggles between practice and live mode', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    expect(await page.textContent('#stats')).toContain('Live');
    await page.click('button:has-text("practice")');
    await page.waitForFunction(
      () => (document.getElementById('stats')?.textContent ?? '').includes('Practice'),
      null, { timeout: 5000 });

    await page.click('button:has-text("go live")');
    await page.waitForFunction(
      () => (document.getElementById('stats')?.textContent ?? '').includes('Live'),
      null, { timeout: 5000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('renders the editable rules with their defaults', async () => {
    const { page, errors } = await openPage();
    await page.evaluate(() => localStorage.setItem('nftmint_token', 'a-token-long-enough'));
    await page.reload({ waitUntil: 'networkidle' });

    const form = await page.textContent('#rulesForm');
    expect(form).toContain('Min different wallets');
    expect(form).toContain('default');
    expect(await page.inputValue('#rulesForm input[type=number]')).toBe('30');
    expect(errors).toEqual([]);
    await page.close();
  });
});
