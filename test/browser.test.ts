import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Loads the real app in a real browser and uses it.
 *
 * The unit guards catch a script that fails to parse. This catches everything
 * after that: a handler that throws on click, a screen that renders blank, a
 * credential that silently fails to save. The page had shipped completely dead
 * once, and no test at the time could have noticed, because nothing ever
 * executed it.
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

const ACCOUNT = { id: 'k7m2qphx4t', token: 'stub-account-key' };

/** Four collections spanning passed, close, and far-off. */
function seedFindings(): Record<string, unknown>[] {
  const now = new Date().toISOString();
  return [
    {
      contract: '0x00000000000000000000000000000000000000aa', name: 'Solar Cats',
      firstSeenAt: now, lastSeenAt: now, timesSeen: 6,
      mintsPerMinute: 412, uniqueMinters: 180, remaining: '640', progressPct: 68,
      projectedSelloutSec: 93, isFree: true, passed: true, score: 100, failedChecks: [],
      reason: 'qualified: 412/min from 180 wallets', outcome: 'bought', minted: 10,
      txUrls: ['https://explorer.example/tx/0xaaa'],
      floor: '0.084', floorCurrency: 'ETH', floorCheckedAt: now, missedValue: '0.84',
    },
    {
      contract: '0x00000000000000000000000000000000000000bb', name: 'Night Foxes',
      firstSeenAt: now, lastSeenAt: now, timesSeen: 3,
      mintsPerMinute: 96, uniqueMinters: 7, remaining: '1200', progressPct: 40,
      projectedSelloutSec: 750, isFree: true, passed: false, score: 88,
      failedChecks: ['unique minters'], reason: '88/100 — short on unique minters',
      floor: '0.031', floorCurrency: 'ETH', floorCheckedAt: now, missedValue: '0.31',
      // Artwork and explorer links are attacker-influenced: token metadata is
      // written by whoever deployed the contract.
      imageUrl: 'javascript:alert(1)',
    },
    {
      contract: '0x00000000000000000000000000000000000000cc', name: 'Paper Moons',
      firstSeenAt: now, lastSeenAt: now, timesSeen: 1,
      mintsPerMinute: 38, uniqueMinters: 11, isFree: true, passed: false, score: 74,
      failedChecks: ['supply left', 'mint rate'], reason: '74/100 — short on supply left',
    },
    {
      contract: '0x00000000000000000000000000000000000000dd', name: 'Dust',
      firstSeenAt: now, lastSeenAt: now, timesSeen: 1,
      mintsPerMinute: 4, uniqueMinters: 2, isFree: true, passed: false, score: 22,
      failedChecks: ['unique minters', 'mint rate', 'burst size'], reason: '22/100',
    },
  ];
}

/** Serves the page plus just enough of the API for the app to work. */
function startStubServer(): Promise<{ server: http.Server; url: string; reset: () => void }> {
  const html = readFileSync(uiPath, 'utf8');
  let findings = seedFindings();
  let account: Record<string, unknown> = {
    id: ACCOUNT.id, createdAt: new Date().toISOString(), walletCount: 10,
    addresses: Array.from({ length: 10 }, (_, i) => `0x${String(i).repeat(40)}`),
    autoMint: true, rpcUrl: undefined as string | undefined,
  };
  let huntCalls = 0;
  let mintNowCalls: string[] = [];

  // Four rows spanning the states the board has to render: about to sell out,
  // an allowlist round, one already gone, and one barely moving.
  const liveRows: Record<string, unknown>[] = [
    {
      contract: '0x00000000000000000000000000000000000000aa', name: 'Solar Cats',
      ageSec: 120, lastSeenSecAgo: 1, status: 'live', mints: 640, mintsPerMinute: 320,
      uniqueMinters: 60, mintsInWindow: 90, totalSupply: '820', maxSupply: '1000',
      progressPct: 82, remaining: '180', soldOut: false, priceWei: '0', priceEth: '0',
      isFree: true, phase: 'public', maxPerWallet: '3', projectedSelloutSec: 34,
      kind: 'confirmed',
      events: [
        { kind: 'minting-out', text: 'Minting out — about 34s left', tone: 'good' },
        { kind: 'crowd', text: '60 wallets in 2m', tone: 'good' },
      ],
      metrics: [
        { label: 'speed', value: '320/min', short: '320/min', tone: 'good' },
        { label: 'wallets', value: '60', short: '60', tone: 'good' },
        { label: 'price', value: 'free', short: 'free', tone: 'good' },
        { label: 'minted', value: '82%', short: '82%', tone: 'neutral' },
        { label: 'max each', value: '3', short: '3', tone: 'good' },
        { label: 'gone in', value: '34s', short: '34s', tone: 'good' },
        { label: 'round', value: 'public', short: 'public', tone: 'good' },
      ],
    },
    {
      contract: '0x00000000000000000000000000000000000000bb', name: 'Night Foxes',
      ageSec: 300, lastSeenSecAgo: 3, status: 'live', mints: 210, mintsPerMinute: 42,
      uniqueMinters: 31, mintsInWindow: 20, totalSupply: '400', maxSupply: '2000',
      progressPct: 20, remaining: '1600', soldOut: false, priceWei: '5000000000000000',
      priceEth: '0.005', isFree: false, phase: 'allowlist', projectedSelloutSec: 2280,
      kind: 'confirmed',
      events: [{ kind: 'crowd', text: '31 wallets in 5m', tone: 'good' }],
      metrics: [
        { label: 'speed', value: '42/min', short: '42/min', tone: 'neutral' },
        { label: 'wallets', value: '31', short: '31', tone: 'good' },
        { label: 'price', value: '0.005 ETH', short: '0.005 ETH', tone: 'neutral' },
        { label: 'minted', value: '20%', short: '20%', tone: 'good' },
        { label: 'round', value: 'allowlist', short: 'allowlist', tone: 'bad' },
      ],
    },
    {
      contract: '0x00000000000000000000000000000000000000cc', name: 'Paper Moons',
      ageSec: 90, lastSeenSecAgo: 200, status: 'quiet', mints: 500, mintsPerMinute: 333,
      uniqueMinters: 44, mintsInWindow: 0, totalSupply: '500', maxSupply: '500',
      progressPct: 100, remaining: '0', soldOut: true, priceWei: '0', priceEth: '0',
      isFree: true, kind: 'likely',
      events: [
        { kind: 'sold-out', text: 'Minted out', tone: 'bad' },
        { kind: 'fast', text: 'Gone in 90s', tone: 'neutral' },
      ],
      metrics: [
        { label: 'speed', value: '333/min', short: '333/min', tone: 'good' },
        { label: 'wallets', value: '44', short: '44', tone: 'good' },
        { label: 'price', value: 'free', short: 'free', tone: 'good' },
        { label: 'minted', value: '100%', short: '100%', tone: 'bad' },
      ],
    },
    {
      // Barely moving, and carrying artwork — it exercises both the volume
      // filter and the image that has to survive a refresh.
      contract: '0x00000000000000000000000000000000000000dd', name: 'Quiet Ducks',
      ageSec: 40, lastSeenSecAgo: 8, status: 'live', mints: 4, mintsPerMinute: 6,
      uniqueMinters: 3, mintsInWindow: 2, totalSupply: '4', maxSupply: '900',
      progressPct: 0.4, remaining: '896', soldOut: false, priceWei: '0', priceEth: '0',
      isFree: true, phase: 'public', kind: 'likely',
      imageUrl:
        'data:image/svg+xml;base64,' +
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
          .toString('base64'),
      events: [{ kind: 'steady', text: '4 minted so far', tone: 'neutral' }],
      metrics: [
        { label: 'speed', value: '6/min', short: '6/min', tone: 'bad' },
        { label: 'wallets', value: '3', short: '3', tone: 'bad' },
        { label: 'price', value: 'free', short: 'free', tone: 'good' },
        { label: 'minted', value: '0%', short: '0%', tone: 'good' },
      ],
    },
  ];

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const asAccount = req.headers['x-account-id'] === ACCOUNT.id;
    const asOperator = req.headers.authorization === 'Bearer operator-token-long-enough';
    const signedIn = asAccount || asOperator;

    const readBody = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
      catch { return {}; }
    };

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        build: { uiVersion: '14-budget', commit: 'testing', deployedAt: 'local' },
        configured: {
          apiToken: true, privateKeys: true, rpcUrls: true, network: 'testnet',
          spendCeilingEth: '0.05', upstreamTracker: false,
          accounts: true, accountsDurable: true, marketPrices: true,
        },
        criteria: {
          minMintsPerMinute: 30, minUniqueMinters: 8, minAttemptsInWindow: 15,
          maxAgeSec: 300, maxSelloutSec: 900, maxSupplyProgressPct: 90,
          freeOnly: true, requireLive: true, requireSaleOpen: true, skipIfOwned: true,
        },
        problems: [],
      });
    }

    if (url.pathname === '/api/account') {
      if (req.method === 'POST') {
        return json({ ...account, token: ACCOUNT.token, storage: 'redis', durable: true,
          notice: 'Save this key now. It is shown once and cannot be recovered.' });
      }
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      if (req.method === 'PATCH') {
        return void readBody().then((body) => {
          if ('rpcUrl' in body) account = { ...account, rpcUrl: String(body.rpcUrl) || undefined };
          if ('autoMint' in body) account = { ...account, autoMint: Boolean(body.autoMint) };
          json({ ...account, saved: true });
        });
      }
      if (url.searchParams.get('reveal') === '1') {
        return json({
          ...account,
          keys: (account.addresses as string[]).map((address, i) => ({
            address, privateKey: `0x${String(i).repeat(64)}`,
          })),
          warning: 'Anyone with these keys can spend anything the wallets hold.',
        });
      }
      return json({
        ...account,
        wallets: (account.addresses as string[]).map((address, i) => ({
          address, balanceEth: i < 3 ? '0.0100' : '0', funded: i < 3,
        })),
        defaultRpcHost: 'rpc.testnet.default',
      });
    }

    if (url.pathname === '/api/findings') {
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      if (req.method === 'DELETE') { findings = []; return json({ cleared: true }); }
      return json({
        storage: 'redis', durable: true, minScore: 70, marketConfigured: true,
        count: findings.length,
        passed: findings.filter((f) => f.passed).length,
        close: findings.filter((f) => !f.passed && Number(f.score) >= 70).length,
        findings,
      });
    }

    if (url.pathname === '/api/origin') {
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      return json({
        network: 'testnet', chainId: 46630,
        sequencer: { url: 'sequencer.testnet', host: 'sequencer.testnet',
          provider: 'Robinhood sequencer', role: 'submit', rttMs: 18 },
        feed: { url: 'feed.testnet', host: 'feed.testnet', provider: 'Robinhood feed', role: 'feed' },
        endpoints: [
          { url: 'arb.g.alchemy.com', host: 'arb.g.alchemy.com', provider: 'Alchemy',
            region: 'US East', role: 'read', rttMs: 42 },
          { url: 'rpc.testnet', host: 'rpc.testnet', provider: 'Robinhood public RPC',
            role: 'read', rttMs: 210 },
        ],
        submitsThrough: { url: 'arb.g.alchemy.com', host: 'arb.g.alchemy.com',
          provider: 'Alchemy', region: 'US East', role: 'read', rttMs: 42 },
        summary: 'Mints leave through Alchemy in US East, 42ms away.',
        note: 'This is where your own transactions enter the chain.',
      });
    }

    if (url.pathname === '/api/live') {
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      const min = Number(url.searchParams.get('minMints') ?? 12);
      return json({
        startedAt: new Date().toISOString(), sampledSeconds: 20, feedConnected: true,
        observed: { feedTxSeen: 900, mintsSeen: 240, contractsTracked: 12 },
        minMints: min,
        note: 'Watched 20s. 3 contract(s) seen, 3 shown.',
        excluded: { seen: 3, belowFloor: 0, notNft: 0, notInspected: 0, unreadable: 0 },
        mints: liveRows.filter((m) => Number(m.mints) >= min),
      });
    }

    if (url.pathname === '/api/mintnow') {
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      return void readBody().then((body) => {
        mintNowCalls.push(String(body.contract));
        json({
          contract: body.contract, name: 'Solar Cats', dryRun: Boolean(body.dryRun),
          attempted: 10, accepted: 10, confirmed: 10,
          strategy: 'address-swap', how: 'took all 3 at once',
          txs: [{ hash: '0xaaa', url: 'https://explorer/tx/0xaaa', accepted: true }],
        });
      });
    }

    if (url.pathname === '/api/status') {
      if (req.headers.authorization !== 'Bearer operator-token-long-enough') {
        return json({ error: 'invalid token' }, 401);
      }
      return json({
        network: 'testnet', chainId: 46630, observedChainId: 46630, blockNumber: '4242',
        rpcEndpoints: [{ url: 'rpc.testnet', medianRttMs: 12 }],
        wallets: [{ address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', balanceEth: '0.5' }],
        spendCeilingEth: '0.05',
      });
    }

    if (url.pathname === '/api/hunt') {
      if (!signedIn) return json({ error: 'Sign in first.' }, 401);
      huntCalls += 1;
      return json({
        startedAt: new Date().toISOString(), durationMs: 10, sampledSeconds: 5,
        feedConnected: true, feedUrl: 'wss://stub',
        observed: { feedTxSeen: 120, mintsSeen: 40, contractsTracked: 3 },
        qualified: huntCalls === 1 ? 1 : 0, mintedCollections: 0, dryRun: true,
        note: 'stub', candidates: [],
      });
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  // Reset is explicit rather than tied to serving the page: a test that reloads
  // to prove something survived must not have the reload be what clears it.
  const reset = (): void => {
    findings = seedFindings();
    huntCalls = 0;
    mintNowCalls = [];
    account = { ...account, autoMint: true, rpcUrl: undefined };
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
async function openPage(signedIn = true): Promise<{ page: Page; errors: string[] }> {
  resetStub();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Google Fonts is blocked in CI sandboxes and the page has a fallback stack,
    // so a font that does not load is not a failure.
    if (m.type() === 'error' && !/fonts\.g|favicon|ERR_CONNECTION/.test(m.text())) {
      errors.push(m.text());
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  if (signedIn) {
    await page.evaluate((a) => localStorage.setItem('fm_account', JSON.stringify(a)), ACCOUNT);
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('#app .card');
  return { page, errors };
}

/**
 * Locate a Chromium to drive.
 *
 * `playwright-core` deliberately downloads nothing — bundling the full
 * `playwright` package would have added a ~150MB browser fetch to every
 * production install, which is a poor trade for a test dependency. So we find
 * an existing browser instead, and skip rather than fail when there is none.
 */
function findChromium(): string | undefined {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const found = candidates.find((p) => existsSync(p));
  if (found) return found;

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

describe.skipIf(!chromiumPath)('the app in a browser', () => {
  it('loads with no JavaScript errors', async () => {
    const { page, errors } = await openPage(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('offers sign-up before anything else when signed out', async () => {
    const { page, errors } = await openPage(false);
    expect(await page.textContent('#app')).toContain('Get started');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('creates an account and shows the key exactly once', async () => {
    const { page, errors } = await openPage(false);
    await page.click('button:has-text("Get started")');
    await page.click('button:has-text("Create 10 wallets")');
    await page.waitForSelector('button:has-text("Show private keys")', { timeout: 15_000 });

    // Shown once, and only once — it cannot be recovered afterwards.
    expect(await page.textContent('#app')).toContain(ACCOUNT.token);
    expect(await page.textContent('#app')).toMatch(/shown once/i);

    const stored = await page.evaluate(() => localStorage.getItem('fm_account'));
    expect(JSON.parse(stored ?? '{}').id).toBe(ACCOUNT.id);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('keeps the ten addresses out of the way until asked for', async () => {
    // Ten addresses is a wall, and not what you open this screen for. The
    // number that matters stays visible; the list is one tap away.
    const { page, errors } = await openPage();
    await page.click('#navAccount');
    await page.waitForSelector('summary:has-text("Wallet addresses")', { timeout: 8000 });

    expect(await page.textContent('#app')).toContain('3 of 10 wallets funded');
    expect(await page.locator('.row.static:visible').count()).toBe(0);

    await page.click('summary:has-text("Wallet addresses")');
    await page.waitForSelector('.row.static:visible', { timeout: 8000 });
    expect(await page.locator('.row.static:visible').count()).toBe(10);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('reveals the private keys only after a confirmation', async () => {
    const { page, errors } = await openPage();
    await page.click('#navAccount');
    await page.waitForSelector('button:has-text("Show private keys")', { timeout: 8000 });

    page.once('dialog', (d) => d.accept());
    await page.click('button:has-text("Show private keys")');
    await page.waitForSelector('.keyrow', { timeout: 8000 });
    expect(await page.locator('.keyrow').count()).toBe(10);
    expect(await page.textContent('#app')).toMatch(/spend anything/i);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('saves the user\'s own RPC endpoint', async () => {
    const { page, errors } = await openPage();
    await page.click('#navAccount');
    await page.waitForSelector('#rpc', { timeout: 8000 });

    await page.fill('#rpc', 'https://arb-mainnet.g.alchemy.com/v2/demo');
    await page.click('button:has-text("Save")');
    await page.waitForFunction(
      () => (document.getElementById('rpc') as HTMLInputElement | null)?.value ===
        'https://arb-mainnet.g.alchemy.com/v2/demo',
      null, { timeout: 10_000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('separates the mints that passed from the ones that came close', async () => {
    const { page, errors } = await openPage();
    await page.waitForSelector('.row', { timeout: 8000 });

    // Passed: everything cleared, and only that one.
    expect(await page.textContent('#app')).toContain('Solar Cats');
    expect(await page.textContent('#app')).not.toContain('Night Foxes');

    await page.click('button:has-text("Close 2")');
    await page.waitForFunction(
      () => (document.getElementById('app')?.textContent ?? '').includes('Night Foxes'),
      null, { timeout: 8000 });

    const close = await page.textContent('#app');
    expect(close).toContain('Night Foxes');
    expect(close).toContain('Paper Moons');
    // 22/100 is not "close" by any reading, and listing it would bury the two
    // that a small change to the rules would actually have caught.
    expect(close).not.toContain('Dust');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows the score as the oversized number on both the list and the detail', async () => {
    const { page, errors } = await openPage();
    await page.waitForSelector('.row', { timeout: 8000 });
    expect(await page.textContent('.row .num')).toBe('100');

    await page.click('.row:has-text("Solar Cats")');
    await page.waitForSelector('.num.xxl', { timeout: 8000 });
    expect(await page.textContent('.num.xxl')).toBe('100');

    // The whole visual idea: this numeral dominates the screen.
    const size = await page.evaluate(
      () => Number.parseFloat(getComputedStyle(document.querySelector('.num.xxl')!).fontSize),
    );
    expect(size).toBeGreaterThan(80);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('says what a missed free mint turned out to be worth', async () => {
    const { page, errors } = await openPage();
    await page.click('button:has-text("Close 2")');
    await page.waitForFunction(
      () => (document.getElementById('app')?.textContent ?? '').includes('Night Foxes'),
      null, { timeout: 8000 });
    await page.click('.row:has-text("Night Foxes")');
    await page.waitForSelector('.num.xxl', { timeout: 8000 });

    const detail = await page.textContent('#app');
    expect(detail).toContain('0.031');
    // The point of the number: what skipping it cost across ten wallets.
    expect(detail).toContain('0.31');
    expect(detail).toMatch(/short on unique minters/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('lists every collection minting, one line each', async () => {
    // A card per collection meant three fitted on a screen. The job is
    // comparing a dozen at a glance, so the rows are dense.
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    const live = await page.textContent('#app');
    expect(live).toContain('Solar Cats');
    expect(live).toContain('320/min');
    expect(live).toContain('0.005 ETH');   // a paid mint's price
    expect(live).toContain('allowlist');   // which round is running
    expect(live).toContain('3');           // per-wallet cap
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('colours the numbers by what they mean', async () => {
    // Green and red are decided on the server next to the hunter's own
    // thresholds; the page only paints them. A row that reads green here is
    // one the automatic side would look at twice.
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    const solar = page.locator('.mintcard:has-text("Solar Cats")');
    expect(await solar.locator('.strip b.good').count()).toBeGreaterThan(2);

    // An allowlist round is a closed door unless you are on the list.
    const foxes = page.locator('.mintcard:has-text("Night Foxes")');
    expect(await foxes.locator('.strip b.bad').count()).toBeGreaterThan(0);

    // Barely moving, from almost nobody.
    const ducks = page.locator('.mintcard:has-text("Quiet Ducks")');
    expect(await ducks.locator('.strip b.bad').count()).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('draws the supply bar to the real proportion', async () => {
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    const width = await page.evaluate(() =>
      (document.querySelector('.mintcard .minibar > div') as HTMLElement | null)?.style.width);
    // The browser normalises 82.0% to 82%.
    expect(width).toBe('82%');
    // A bar still filling sweeps; a finished one does not.
    expect(await page.locator('.minibar.moving').count()).toBeGreaterThan(0);
    expect(await page.locator('.minibar.done').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('mints a row in one press', async () => {
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    await page.click('.mintcard:has-text("Solar Cats") button:has-text("test")');
    await page.waitForSelector('.mintcard:has-text("Solar Cats") .good:has-text("done")',
      { timeout: 15_000 });

    // A dense row has no space for a paragraph, so the detail is in the title.
    const title = await page.getAttribute(
      '.mintcard:has-text("Solar Cats") button[title]', 'title');
    expect(title).toMatch(/Minted 10/);
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('will not offer a mint button on a sold-out row', async () => {
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    const soldOut = page.locator('.mintcard:has-text("Paper Moons")');
    expect(await soldOut.locator('button:has-text("out")').isDisabled()).toBe(true);
    // An allowlist round is offered, but not as a confident one.
    const foxes = page.locator('.mintcard:has-text("Night Foxes")');
    expect(await foxes.locator('button.solid').count()).toBe(0);
    expect(await foxes.locator('button:has-text("try")').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('puts the newest drop at the top', async () => {
    // A drop is worth knowing about while there is supply left, so the row
    // that should catch the eye is the one that just started.
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    const first = await page.locator('#liveList .mintcard').first().textContent();
    expect(first).toContain('Solar Cats');
    expect(errors).toEqual([]);
    await page.close();
  }, 25_000);

  it('shows the rule defaults without needing an operator token', async () => {
    const { page, errors } = await openPage(false);
    await page.click('#navRules');
    await page.waitForSelector('#app input[type=number]', { timeout: 8000 });

    expect(await page.locator('#app input[type=number]').count()).toBe(6);
    // Straight from /api/health, which is public — otherwise the settings
    // screen could not even label its own inputs before sign-in.
    expect(await page.inputValue('#app input[type=number]')).toBe('30');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('runs a hunt round and logs what it saw', async () => {
    const { page, errors } = await openPage();
    await page.waitForSelector('button:has-text("Start hunting")', { timeout: 8000 });
    await page.click('button:has-text("Start hunting")');
    await page.waitForFunction(
      () => (document.getElementById('app')?.textContent ?? '').includes('40 mints seen'),
      null, { timeout: 15_000 });

    // Stop it before the test ends, or the loop keeps firing at the stub.
    await page.click('button:has-text("Stop")');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('stops watching when the tab goes into the background', async () => {
    // Every refresh holds the sequencer feed open on the server and is billed
    // as active CPU. A backgrounded tab is a request nobody reads and an
    // invoice somebody pays — one left open overnight cost eight hours of
    // compute and paused the account it was billed to.
    const { page, errors } = await openPage();

    // Headless Chromium never reports a page as hidden, so drive the property
    // the handler actually reads. This tests our logic, not the browser's.
    await page.evaluate(() => {
      let hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
      (window as unknown as { setHidden: (v: boolean) => void }).setHidden = (v) => {
        hidden = v;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });

    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });
    await page.evaluate(() => {
      const w = window as unknown as {
        stopBoard: () => void; startBoard: () => void; BOARD_INTERVAL_MS: number;
      };
      w.stopBoard();
      w.BOARD_INTERVAL_MS = 400;
      w.startBoard();
    });

    await page.waitForTimeout(1200);
    const before = await page.evaluate(
      () => (window as unknown as { boardIdle: number }).boardIdle);
    expect(before).toBeGreaterThan(0);

    await page.evaluate(() =>
      (window as unknown as { setHidden: (v: boolean) => void }).setHidden(true));
    const atPause = await page.evaluate(
      () => (window as unknown as { boardIdle: number }).boardIdle);
    await page.waitForTimeout(1500);

    // Nothing advanced while hidden.
    expect(await page.evaluate(
      () => (window as unknown as { boardIdle: number }).boardIdle)).toBe(atPause);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it('stops watching on its own after a long quiet stretch', async () => {
    // The other half: a tab left in the foreground and forgotten.
    const { page, errors } = await openPage();
    await page.click('#navLive');
    await page.waitForSelector('.mintcard', { timeout: 15_000 });

    await page.evaluate(() => {
      const w = window as unknown as {
        stopBoard: () => void; startBoard: () => void;
        BOARD_INTERVAL_MS: number; BOARD_IDLE_LIMIT: number;
      };
      w.stopBoard();
      w.BOARD_INTERVAL_MS = 300;
      w.BOARD_IDLE_LIMIT = 2;
      w.startBoard();
    });

    await page.waitForFunction(
      () => (document.getElementById('liveNote')?.textContent ?? '').includes('Stopped watching'),
      null, { timeout: 15_000 });

    // And it says why, with a way to carry on.
    const note = await page.textContent('#liveNote');
    expect(note).toMatch(/spending compute/i);
    expect(await page.locator('#liveNote button:has-text("Watch again")').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  it('refuses to render a javascript: URL from collection metadata', async () => {
    const { page, errors } = await openPage();
    await page.click('button:has-text("Close 2")');
    await page.waitForFunction(
      () => (document.getElementById('app')?.textContent ?? '').includes('Night Foxes'),
      null, { timeout: 8000 });

    const hostile = await page.evaluate(() =>
      [...document.querySelectorAll('[src],[href]')]
        .map((el) => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
        .filter((v) => v.toLowerCase().startsWith('javascript:')),
    );
    expect(hostile).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('moves between every screen without dying', async () => {
    const { page, errors } = await openPage();
    for (const nav of ['#navLive', '#navAccount', '#navRules', '#navMints']) {
      await page.click(nav);
      await page.waitForSelector('#app .card');
      expect((await page.textContent('#app'))?.length ?? 0).toBeGreaterThan(20);
    }
    expect(errors).toEqual([]);
    await page.close();
  });
  it('signs the operator in, and changes the screen when it does', async () => {
    // The failure this replaces: a correct token was accepted by the API but
    // the screen kept offering sign-up, so it looked like nothing happened.
    const { page, errors } = await openPage(false);
    await page.click('#navAccount');
    await page.click('summary:has-text("Run this as the operator")');
    await page.fill('#opTok', 'operator-token-long-enough');
    await page.click('#app >> button:has-text("Sign in") >> nth=1');

    // Wait for the status to land, not just for the heading to switch.
    await page.waitForFunction(
      () => (document.getElementById('app')?.textContent ?? '').includes('Deployment'),
      null, { timeout: 10_000 });

    const shown = await page.textContent('#app');
    expect(shown).toContain('Operator');
    expect(shown).toContain('testnet');
    expect(shown).toContain('4242');
    expect(shown).not.toContain('Create 10 wallets');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('lets the operator reach the hunt screen', async () => {
    const { page, errors } = await openPage(false);
    await page.evaluate(() => localStorage.setItem('fm_optoken', 'operator-token-long-enough'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button:has-text("Start hunting")', { timeout: 10_000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('names the shared endpoint when an account has not set its own', async () => {
    const { page, errors } = await openPage();
    await page.click('#navAccount');
    await page.waitForSelector('#rpc', { timeout: 8000 });
    expect(await page.textContent('#app')).toContain('rpc.testnet.default');
    // The question this answers: "there is already an RPC, so why is it asking
    // me for one?" — because the shared one is a default, not the only option.
    expect(await page.textContent('#app')).toMatch(/shared endpoint/i);
    expect(errors).toEqual([]);
    await page.close();
  });
});
