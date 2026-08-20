import { formatEther, parseEther, type Hex } from 'viem';
import {
  loadConfig,
  loadHuntConfig,
  loadTrackerConfig,
  loadWalletKeys,
  type BotConfig,
} from './config.js';
import { chainFor, explorerTxUrl } from './chain.js';
import { RpcClient } from './rpc.js';
import { loadWallets, checkBalances } from './wallet.js';
import { runPreflight } from './preflight.js';
import { totalCommitment } from './presign.js';
import { run } from './bot.js';
import { FeedConsumer } from './feed.js';
import { MintTracker, type TrackedCollection } from './tracker.js';
import { parseExtraSelectors } from './mintdetect.js';
import { criteriaForDisplay } from './hunt.js';
import { errorMessage } from './http.js';

/**
 * Service layer behind the web UI.
 *
 * Each function is a complete unit of work that a serverless invocation can
 * finish: connect, do the job, tear down. Nothing here assumes state survives
 * between requests, because on Vercel it does not.
 */

/**
 * Fields the UI may override per request.
 *
 * Deliberately a fixed allowlist rather than a spread of arbitrary keys: the
 * request body reaches a process holding private keys, so it may choose *what*
 * to mint but never things like PRIVATE_KEYS, RPC_URLS, or the spend ceiling.
 */
const OVERRIDABLE = {
  contract: 'CONTRACT_ADDRESS',
  network: 'NETWORK',
  mintFunction: 'MINT_FUNCTION',
  mintArgs: 'MINT_ARGS',
  calldata: 'MINT_CALLDATA',
  priceEth: 'MINT_PRICE_ETH',
  quantity: 'MINT_QUANTITY',
  valueEth: 'MINT_VALUE_ETH',
  gasLimit: 'GAS_LIMIT',
  maxFeeGwei: 'MAX_FEE_GWEI',
  txPerWallet: 'TX_PER_WALLET',
  requireSimulation: 'REQUIRE_SIMULATION',
  dryRun: 'DRY_RUN',
} as const;

export type OverrideKey = keyof typeof OVERRIDABLE;

/** Merge an allowlisted request body over the process environment. */
export function buildEnv(
  body: Record<string, unknown>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [field, envName] of Object.entries(OVERRIDABLE)) {
    const value = body[field];
    if (value === undefined || value === null || value === '') continue;
    merged[envName] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  // The API can only fire immediately; a function cannot outlive its request to
  // wait for a drop. Scheduling belongs to Vercel Cron calling this endpoint.
  merged.TRIGGER_MODE = 'now';
  return merged;
}

export class SpendLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendLimitError';
  }
}

/**
 * Ceiling on what a single API-triggered run may commit.
 *
 * A typo in the UI, or a request from someone who got hold of the token,
 * should not be able to spend the whole wallet. Defaults deliberately low.
 */
export function spendCeilingWei(env: NodeJS.ProcessEnv = process.env): bigint {
  return parseEther(env.MAX_MINT_VALUE_ETH?.trim() || '0.05');
}

export function assertWithinCeiling(
  committedWei: bigint,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const ceiling = spendCeilingWei(env);
  if (committedWei > ceiling) {
    throw new SpendLimitError(
      `This run would commit up to ${formatEther(committedWei)} ETH, above the ` +
        `MAX_MINT_VALUE_ETH ceiling of ${formatEther(ceiling)} ETH. ` +
        `Lower the quantity or wallet count, or raise the ceiling deliberately.`,
    );
  }
}

export interface StatusResult {
  network: string;
  chainId: number;
  observedChainId?: number;
  blockNumber?: string;
  baseFeeWei?: string;
  rpcEndpoints: Array<{ url: string; medianRttMs?: number; error?: string }>;
  wallets: Array<{ address: string; balanceEth: string }>;
  spendCeilingEth: string;
  explorer?: string;
  /** Auto-hunt thresholds, so the UI can explain them without running a cycle. */
  criteria: Record<string, unknown>;
}

/**
 * Chain reachability, endpoint latency, and wallet balances.
 *
 * Uses `loadWalletKeys` rather than the full config on purpose: checking that
 * your wallets are funded and the chain is reachable is something you want to
 * do *before* choosing a contract, so it must not require one.
 */
export async function getStatus(env: NodeJS.ProcessEnv = process.env): Promise<StatusResult> {
  const config = loadWalletKeys(env);
  const chain = chainFor(config.network);

  const endpoints: StatusResult['rpcEndpoints'] = [];
  const clients = config.rpcUrls.map((url) => new RpcClient(url, { timeoutMs: 6_000 }));

  try {
    await Promise.all(
      clients.map(async (client) => {
        try {
          const rtt = await client.measureLatency(3);
          endpoints.push({ url: client.label, medianRttMs: Number(rtt.toFixed(1)) });
        } catch (err) {
          endpoints.push({ url: client.label, error: errorMessage(err) });
        }
      }),
    );

    // Matched on the redacted label, because that is what was recorded above.
    const healthy = clients.find((c) =>
      endpoints.some((e) => e.url === c.label && e.error === undefined),
    );

    let observedChainId: number | undefined;
    let blockNumber: string | undefined;
    let baseFeeWei: string | undefined;
    const wallets: StatusResult['wallets'] = [];

    if (healthy) {
      observedChainId = Number(BigInt(await healthy.call<Hex>('eth_chainId')));
      const block = await healthy.call<{ number?: Hex; baseFeePerGas?: Hex }>(
        'eth_getBlockByNumber',
        ['latest', false],
      );
      if (block?.number) blockNumber = BigInt(block.number).toString();
      if (block?.baseFeePerGas) baseFeeWei = BigInt(block.baseFeePerGas).toString();

      for (const wallet of loadWallets(config.privateKeys)) {
        const balance = await healthy.call<Hex>('eth_getBalance', [wallet.address, 'latest']);
        wallets.push({ address: wallet.address, balanceEth: formatEther(BigInt(balance)) });
      }
    }

    return {
      network: config.network,
      chainId: config.chainId,
      observedChainId,
      blockNumber,
      baseFeeWei,
      rpcEndpoints: endpoints,
      wallets,
      spendCeilingEth: formatEther(spendCeilingWei(env)),
      explorer: chain.blockExplorers?.default.url,
      criteria: criteriaForDisplay(loadHuntConfig(env).criteria),
    };
  } finally {
    for (const client of clients) client.destroy();
  }
}

export interface PreflightResult {
  ok: boolean;
  chainId: number;
  contract: string;
  simulationOk: boolean;
  revertReason?: string;
  gasSource: string;
  gasEstimate: string;
  gasLimit: string;
  baseFeeWei?: string;
  warnings: string[];
  wallets: Array<{
    address: string;
    balanceEth: string;
    requiredEth: string;
    sufficient: boolean;
  }>;
  worstCaseEth: string;
  withinCeiling: boolean;
  spendCeilingEth: string;
}

/** Validate a mint configuration without sending anything. */
export async function runPreflightService(
  body: Record<string, unknown>,
  base: NodeJS.ProcessEnv = process.env,
): Promise<PreflightResult> {
  const env = buildEnv(body, base);
  const config = loadConfig(env);
  const client = new RpcClient(config.rpcUrls[0], { timeoutMs: 8_000 });

  try {
    const wallets = loadWallets(config.privateKeys);
    const report = await runPreflight(client, config, wallets);

    const balances = await checkBalances(
      client,
      wallets,
      config.mint.value,
      report.gasLimit,
      config.gas.maxFeePerGas,
      config.txPerWallet,
    );

    const worstCase =
      (config.mint.value + report.gasLimit * config.gas.maxFeePerGas) *
      BigInt(config.txPerWallet * wallets.length);
    const ceiling = spendCeilingWei(env);

    return {
      ok: report.simulation.ok && balances.every((b) => b.sufficient),
      chainId: report.observedChainId,
      contract: config.mint.contract,
      simulationOk: report.simulation.ok,
      revertReason: report.simulation.revertReason,
      gasSource: report.gas.source,
      gasEstimate: report.gas.total.toString(),
      gasLimit: report.gasLimit.toString(),
      baseFeeWei: report.baseFeePerGas?.toString(),
      warnings: report.warnings,
      wallets: balances.map((b) => ({
        address: b.wallet.address,
        balanceEth: formatEther(b.balanceWei),
        requiredEth: formatEther(b.requiredWei),
        sufficient: b.sufficient,
      })),
      worstCaseEth: formatEther(worstCase),
      withinCeiling: worstCase <= ceiling,
      spendCeilingEth: formatEther(ceiling),
    };
  } finally {
    client.destroy();
  }
}

export interface MintResult {
  ok: boolean;
  dryRun: boolean;
  contract: string;
  submitted: number;
  accepted: number;
  minted: number;
  failed: number;
  maxCommittedEth: string;
  transactions: Array<{
    hash: string;
    from: string;
    nonce: number;
    accepted: boolean;
    error?: string;
    url: string;
  }>;
}

/**
 * Execute a mint now.
 *
 * Reuses the same pipeline the CLI drives — preflight, pre-sign, broadcast,
 * confirm — so the web path cannot drift from the tested one.
 */
export async function runMintService(
  body: Record<string, unknown>,
  base: NodeJS.ProcessEnv = process.env,
): Promise<MintResult> {
  const env = buildEnv(body, base);
  const config: BotConfig = loadConfig(env);

  // Bound the damage before anything is signed.
  const perTx =
    config.mint.value +
    (config.gas.gasLimit ?? 400_000n) * config.gas.maxFeePerGas;
  const projected = perTx * BigInt(config.txPerWallet * config.privateKeys.length);
  assertWithinCeiling(projected, env);

  const result = await run({ config });

  const maxCommitted = totalCommitment(result.prepared);
  const accepted = result.outcomes.filter((o) => o.accepted).length;

  return {
    ok: result.minted > 0 || config.dryRun,
    dryRun: config.dryRun,
    contract: config.mint.contract,
    submitted: result.outcomes.length,
    accepted,
    minted: result.minted,
    failed: result.failed,
    maxCommittedEth: formatEther(maxCommitted),
    transactions: result.prepared.map((tx) => {
      const outcome = result.outcomes.find((o) => o.tx.hash === tx.hash);
      return {
        hash: tx.hash,
        from: tx.from,
        nonce: tx.nonce,
        accepted: outcome?.accepted ?? false,
        error: outcome?.error,
        url: explorerTxUrl(config.network, tx.hash),
      };
    }),
  };
}

export interface ScanResult {
  sampledSeconds: number;
  feedUrl: string;
  connected: boolean;
  stats: Record<string, unknown>;
  collections: TrackedCollection[];
  note: string;
}

/**
 * Sample the sequencer feed for a fixed window and return a velocity ranking.
 *
 * This is the tracker adapted to a request/response world: a serverless
 * function cannot hold the feed open between calls, so instead of watching
 * continuously it takes a snapshot of whatever is happening right now. Longer
 * windows see more, bounded by the function's max duration.
 */
export async function scanFeedService(
  seconds: number,
  base: NodeJS.ProcessEnv = process.env,
): Promise<ScanResult> {
  const cfg = loadTrackerConfig(base);
  const windowSec = Math.min(Math.max(seconds, 3), 55);

  const tracker = new MintTracker({
    velocityWindowSec: cfg.velocityWindowSec,
    minAttempts: cfg.minAttempts,
    minUniqueMinters: cfg.minUniqueMinters,
    maxContractAgeSec: cfg.maxContractAgeSec,
    freeOnly: false,
    // Sender recovery is too slow to be worth it inside a short sample window.
    trackUniqueMinters: false,
    maxContracts: cfg.maxContracts,
    evictAfterSec: cfg.evictAfterSec,
    extraSelectors: parseExtraSelectors(cfg.extraSelectorsRaw),
  });

  const feed = new FeedConsumer({ url: cfg.feedUrl });
  let connected = false;
  feed.on('open', () => {
    connected = true;
  });
  feed.on('error', () => {
    /* logged by the consumer; sampling continues and may reconnect */
  });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  feed.start();

  await new Promise((resolve) => setTimeout(resolve, windowSec * 1000));
  feed.stop();

  return {
    sampledSeconds: windowSec,
    feedUrl: cfg.feedUrl,
    connected,
    stats: tracker.stats(),
    collections: tracker.snapshot(50),
    note: connected
      ? 'Snapshot of a single sample window. A continuously running tracker sees more.'
      : 'Could not connect to the sequencer feed within the window.',
  };
}
