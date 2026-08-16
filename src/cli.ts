#!/usr/bin/env node
import { formatEther } from 'viem';
import { describeConfig, loadConfig } from './config.js';
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
