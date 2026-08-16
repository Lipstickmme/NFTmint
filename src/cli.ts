#!/usr/bin/env node
import { formatEther } from 'viem';
import {
  describeConfig,
  loadAutopilotConfig,
  loadConfig,
  loadTrackerConfig,
} from './config.js';
import { MintTracker, type HotCollection } from './tracker.js';
import { parseExtraSelectors } from './mintdetect.js';
import { runAutopilot } from './autopilot.js';
import { chainFor, defaultRpcFor, feedFor } from './chain.js';
import { RpcClient } from './rpc.js';
import { FeedConsumer } from './feed.js';
import { runPreflight } from './preflight.js';
import { loadWallets, checkBalances, formatBalanceReport } from './wallet.js';
import { run } from './bot.js';
import { COMMON_MINT_SIGNATURES, COMMON_READY_SIGNATURES, selectorOf } from './calldata.js';
import { log, setLevel, type Level } from './logger.js';

const USAGE = `
Robinhood Chain NFT mint bot

Usage: npm run <command>   (or: npx tsx src/cli.ts <command>)

Commands:
  run         Full run: preflight, pre-sign, wait for trigger, broadcast.
  preflight   Validate config, simulate the mint, and report gas. Sends nothing.
  latency     Measure round-trip time to each configured RPC endpoint.
  feed        Stream the sequencer feed. Optionally filter by contract/selector.
  track       Watch the feed and rank collections by mint velocity. Sends nothing.
  serve       Run the tracker plus an HTTP dashboard/API. Holds no keys.
  auto        Autopilot: track, then mass-mint hot free mints across all wallets.
  selector    Print the 4-byte selector for a function signature.
  networks    Show built-in network parameters.

Environment is read from .env — see .env.example for every option.

Flags:
  --log <debug|info|warn|error>   Verbosity (default: info)
`;

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

async function cmdPreflight(): Promise<void> {
  const config = loadConfig();
  log.info('Configuration', describeConfig(config));

  const client = new RpcClient(config.rpcUrls[0]);
  try {
    const wallets = loadWallets(config.privateKeys);
    const report = await runPreflight(client, config, wallets);

    log.info('Preflight result', {
      chainId: report.observedChainId,
      contractHasCode: report.contractHasCode,
      simulationOk: report.simulation.ok,
      revertReason: report.simulation.revertReason,
      gasSource: report.gas.source,
      gasEstimateTotal: report.gas.total,
      gasForL1: report.gas.forL1,
      gasForL2: report.gas.forL2,
      gasLimitToUse: report.gasLimit,
      baseFeeWei: report.baseFeePerGas,
    });
    for (const warning of report.warnings) log.warn(warning);

    const balances = await checkBalances(
      client,
      wallets,
      config.mint.value,
      report.gasLimit,
      config.gas.maxFeePerGas,
      config.txPerWallet,
    );
    log.info('Balances:\n' + formatBalanceReport(balances));

    const worstCase =
      (config.mint.value + report.gasLimit * config.gas.maxFeePerGas) *
      BigInt(config.txPerWallet * wallets.length);
    log.info('Worst-case total spend', { eth: formatEther(worstCase) });

    if (balances.every((b) => b.sufficient) && report.simulation.ok) {
      log.info('Preflight PASSED — ready to run.');
    } else {
      log.warn('Preflight completed with issues; review the output above.');
    }
  } finally {
    client.destroy();
  }
}

async function cmdLatency(): Promise<void> {
  const config = loadConfig();
  log.info('Measuring endpoint latency', { samples: 7 });

  for (const url of config.rpcUrls) {
    const client = new RpcClient(url);
    try {
      // Warm first so the reported number reflects steady state rather than a
      // one-off TLS handshake.
      await client.warm(1);
      const median = await client.measureLatency(7);
      log.info('endpoint', { url, medianRttMs: median.toFixed(2) });
    } catch (err) {
      log.error('endpoint failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      client.destroy();
    }
  }

  log.info(
    'On a FCFS chain the fastest endpoint wins mints. If these numbers are above ~50ms, ' +
      'consider a provider with a region closer to the sequencer.',
  );
}

async function cmdFeed(flags: Record<string, string>): Promise<void> {
  const network = (process.env.NETWORK ?? 'testnet') as 'mainnet' | 'testnet';
  const url = process.env.FEED_URL ?? feedFor(network);
  const contractFilter = flags.contract?.toLowerCase();
  const selectorFilter = flags.selector?.toLowerCase();

  log.info('Connecting to sequencer feed', { url, contractFilter, selectorFilter });

  const consumer = new FeedConsumer({ url });
  let seen = 0;

  consumer.on('tx', (tx) => {
    if (contractFilter && tx.to?.toLowerCase() !== contractFilter) return;
    if (selectorFilter && tx.selector !== selectorFilter) return;
    seen += 1;
    log.info('tx', {
      hash: tx.hash,
      to: tx.to,
      selector: tx.selector,
      valueWei: tx.value,
    });
  });

  consumer.start();

  process.on('SIGINT', () => {
    consumer.stop();
    log.info('Feed closed', { matched: seen });
    process.exit(0);
  });

  await new Promise(() => {
    /* run until interrupted */
  });
}

/**
 * Read-only tracker. Prints a periodically refreshed leaderboard of what is
 * being minted hardest right now. Never signs or sends anything, so it is safe
 * to leave running while you decide.
 */
async function cmdTrack(flags: Record<string, string>): Promise<void> {
  const { FeedConsumer } = await import('./feed.js');
  const cfg = loadTrackerConfig();
  const refreshMs = Number(flags.refresh ?? 5_000);

  const tracker = new MintTracker({
    velocityWindowSec: cfg.velocityWindowSec,
    minAttempts: cfg.minAttempts,
    minUniqueMinters: cfg.minUniqueMinters,
    maxContractAgeSec: cfg.maxContractAgeSec,
    freeOnly: flags.free === 'true' ? true : cfg.freeOnly,
    trackUniqueMinters: cfg.trackUniqueMinters,
    maxContracts: cfg.maxContracts,
    evictAfterSec: cfg.evictAfterSec,
    extraSelectors: parseExtraSelectors(cfg.extraSelectorsRaw),
  });

  log.info('Tracking mint velocity', {
    feed: cfg.feedUrl,
    windowSec: cfg.velocityWindowSec,
    minMintsInWindow: cfg.minAttempts,
    minUniqueMinters: cfg.minUniqueMinters,
    freeOnly: tracker.config.freeOnly,
  });

  const feed = new FeedConsumer({ url: cfg.feedUrl });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  tracker.on('hot', (hot: HotCollection) => {
    log.warn('>>> HOT', {
      contract: hot.contract,
      inWindow: hot.attemptsInWindow,
      unique: hot.uniqueMinters,
      free: hot.isFree,
      ageSec: hot.ageSec.toFixed(1),
    });
  });
  feed.start();

  const timer = setInterval(() => {
    const rows = tracker.snapshot(Number(flags.top ?? 15));
    if (rows.length === 0) return;
    process.stdout.write(
      `\n── mint leaderboard ── ${new Date().toISOString()} ── ` +
        `${JSON.stringify(tracker.stats())}\n`,
    );
    process.stdout.write(
      'contract                                    in-win  total  unique  free  age(s)\n',
    );
    for (const r of rows) {
      process.stdout.write(
        `${r.contract}  ${String(r.attemptsInWindow).padStart(6)}  ` +
          `${String(r.attempts).padStart(5)}  ${String(r.uniqueMinters).padStart(6)}  ` +
          `${(r.isFree ? 'yes' : 'no').padStart(4)}  ${String(r.ageSec).padStart(6)}\n`,
      );
    }
  }, refreshMs);

  process.on('SIGINT', () => {
    clearInterval(timer);
    feed.stop();
    log.info('Tracker stopped', tracker.stats());
    process.exit(0);
  });

  await new Promise(() => {
    /* until interrupted */
  });
}

/**
 * Durable tracker + HTTP status server.
 *
 * This is the process a Vercel dashboard points at. It holds the sequencer
 * feed open — which a serverless function cannot do — and serves the tracker
 * snapshot over HTTP. It holds no private keys and never signs anything.
 */
async function cmdServe(flags: Record<string, string>): Promise<void> {
  const { FeedConsumer } = await import('./feed.js');
  const { startStatusServer } = await import('./server.js');
  const cfg = loadTrackerConfig();

  const tracker = new MintTracker({
    velocityWindowSec: cfg.velocityWindowSec,
    minAttempts: cfg.minAttempts,
    minUniqueMinters: cfg.minUniqueMinters,
    maxContractAgeSec: cfg.maxContractAgeSec,
    freeOnly: cfg.freeOnly,
    trackUniqueMinters: cfg.trackUniqueMinters,
    maxContracts: cfg.maxContracts,
    evictAfterSec: cfg.evictAfterSec,
    extraSelectors: parseExtraSelectors(cfg.extraSelectorsRaw),
  });

  const feed = new FeedConsumer({ url: cfg.feedUrl });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  feed.start();

  const port = Number(flags.port ?? process.env.PORT ?? 8080);
  const server = startStatusServer(tracker, {
    port,
    authToken: process.env.TRACKER_AUTH_TOKEN,
    corsOrigin: process.env.DASHBOARD_ORIGIN,
  });

  log.info('Serving tracker', {
    feed: cfg.feedUrl,
    dashboard: `http://localhost:${port}/`,
    api: `http://localhost:${port}/api/collections`,
  });

  process.on('SIGINT', () => {
    feed.stop();
    server.close();
    log.info('Stopped', tracker.stats());
    process.exit(0);
  });

  await new Promise(() => {
    /* until interrupted */
  });
}

/**
 * Autopilot. This one spends money without asking, so it prints exactly what
 * it is allowed to do before arming, and refuses to start without a budget.
 */
async function cmdAuto(): Promise<void> {
  const botConfig = loadConfig();
  const auto = loadAutopilotConfig();
  const tracker = loadTrackerConfig();

  log.warn('AUTOPILOT — this mints contracts nobody has vetted. Use burner wallets.');
  log.info('Autopilot limits', {
    freeOnly: auto.freeOnly,
    totalBudgetEth: formatEther(auto.totalBudgetWei),
    perCollectionEth: formatEther(auto.perCollectionBudgetWei),
    maxGasLimit: auto.maxGasLimit,
    maxCollectionsPerHour: auto.maxCollectionsPerHour,
    wallets: botConfig.privateKeys.length,
    txPerWallet: auto.txPerWallet,
    mintsPerCollection: botConfig.privateKeys.length * auto.txPerWallet,
    allowlist: auto.allowlist.size || 'any',
    denylist: auto.denylist.size,
    dryRun: auto.dryRun,
  });

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  const pilot = await runAutopilot({
    botConfig,
    autopilot: {
      ...auto,
      denylist: auto.denylist,
      allowlist: auto.allowlist,
    },
    tracker: {
      velocityWindowSec: tracker.velocityWindowSec,
      minAttempts: tracker.minAttempts,
      minUniqueMinters: tracker.minUniqueMinters,
      maxContractAgeSec: tracker.maxContractAgeSec,
      trackUniqueMinters: tracker.trackUniqueMinters,
      maxContracts: tracker.maxContracts,
      evictAfterSec: tracker.evictAfterSec,
      extraSelectors: parseExtraSelectors(tracker.extraSelectorsRaw),
    },
    signal: controller.signal,
  });

  log.info('Autopilot stopped', pilot.summary());
}

function cmdSelector(argv: string[]): void {
  const signature = argv.find((a) => !a.startsWith('--') && a.includes('('));
  if (!signature) {
    log.info('Common mint signatures and their selectors:');
    for (const sig of COMMON_MINT_SIGNATURES) {
      log.info('  ' + sig.padEnd(36) + selectorOf(sig));
    }
    log.info('Common "sale is open" views:');
    for (const sig of COMMON_READY_SIGNATURES) {
      log.info('  ' + sig.padEnd(36) + selectorOf(sig.replace(/\s*\(bool\)$/, '')));
    }
    log.info('Pass a signature to compute one, e.g. selector "mint(uint256)"');
    return;
  }
  log.info(signature, { selector: selectorOf(signature) });
}

function cmdNetworks(): void {
  for (const network of ['mainnet', 'testnet'] as const) {
    const chain = chainFor(network);
    log.info(chain.name, {
      chainId: chain.id,
      rpc: defaultRpcFor(network),
      feed: feedFor(network),
      explorer: chain.blockExplorers?.default.url,
      gasToken: chain.nativeCurrency.symbol,
    });
  }
  log.info(
    'Ordering: first-come-first-served, private mempool, no Timeboost. ' +
      'Latency decides mints, not fees.',
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = parseFlags(argv);

  if (flags.log) setLevel(flags.log as Level);

  switch (command) {
    case 'run':
      await run({ config: loadConfig() });
      break;
    case 'preflight':
      await cmdPreflight();
      break;
    case 'latency':
      await cmdLatency();
      break;
    case 'feed':
      await cmdFeed(flags);
      break;
    case 'track':
      await cmdTrack(flags);
      break;
    case 'serve':
      await cmdServe(flags);
      break;
    case 'auto':
      await cmdAuto();
      break;
    case 'selector':
      cmdSelector(argv.slice(1));
      break;
    case 'networks':
      cmdNetworks();
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.DEBUG_STACK && err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
