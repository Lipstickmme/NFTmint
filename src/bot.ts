import { formatEther } from 'viem';
import { explorerTxUrl } from './chain.js';
import { RpcClient } from './rpc.js';
import { FeedConsumer } from './feed.js';
import { runPreflight, type PreflightReport } from './preflight.js';
import { presignAll, summarize, totalCommitment, type PreparedTx } from './presign.js';
import { submitAll, summarizeOutcomes, waitForReceipts, type SubmitOutcome } from './submit.js';
import { waitForTrigger } from './triggers.js';
import { checkBalances, formatBalanceReport, loadWallets, NonceManager } from './wallet.js';
import { flushHot, hot, log } from './logger.js';
import type { BotConfig } from './config.js';

/**
 * End-to-end run.
 *
 * The shape of this function is the whole strategy: a long, unhurried
 * preparation phase, then a trigger, then a critical section that does as
 * close to nothing as possible.
 */

export interface RunResult {
  preflight: PreflightReport;
  prepared: PreparedTx[];
  outcomes: SubmitOutcome[];
  minted: number;
  failed: number;
}

export interface RunOptions {
  config: BotConfig;
  signal?: AbortSignal;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { config } = options;
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  // ── Endpoints ────────────────────────────────────────────────────────────
  const clients = config.rpcUrls.map(
    (url) => new RpcClient(url, { timeoutMs: 10_000, maxSockets: 16 }),
  );
  const primary = clients[0];

  log.info('Warming RPC connections', { endpoints: clients.length });
  const latencies = await Promise.all(
    clients.map(async (client) => {
      try {
        const rtt = await client.measureLatency(3);
        log.info('endpoint ready', { endpoint: client.endpoint, medianRttMs: rtt.toFixed(1) });
        return { client, rtt };
      } catch (err) {
        log.warn('endpoint unreachable', {
          endpoint: client.endpoint,
          error: err instanceof Error ? err.message : String(err),
        });
        return { client, rtt: Number.POSITIVE_INFINITY };
      }
    }),
  );

  const healthy = latencies.filter((l) => Number.isFinite(l.rtt));
  if (healthy.length === 0) {
    throw new Error(
      'No RPC endpoint responded. Check RPC_URLS and your network connection.',
    );
  }
  // Fire at the fastest endpoint first; on a FCFS chain this ordering is the
  // difference between winning and losing.
  healthy.sort((a, b) => a.rtt - b.rtt);

  // Submit-only endpoints (the sequencer) are added ahead of the RPC providers.
  // They are not latency-probed, because they need not answer read calls — and
  // they skip the provider's relay hop, which is the whole point of using them.
  const submitOnlyClients = (config.submitOnlyUrls ?? []).map(
    (url) => new RpcClient(url, { timeoutMs: 10_000, maxSockets: 16 }),
  );
  for (const client of submitOnlyClients) {
    clients.push(client);
    log.info('submit-only endpoint armed', { endpoint: client.endpoint });
  }

  const submitClients = [...submitOnlyClients, ...healthy.map((h) => h.client)];

  try {
    // ── Wallets & preflight ────────────────────────────────────────────────
    const wallets = loadWallets(config.privateKeys);
    log.info('Wallets loaded', {
      count: wallets.length,
      addresses: wallets.map((w) => w.address),
    });

    const preflight = await runPreflight(primary, config, wallets);
    log.info('Preflight complete', {
      chainId: preflight.observedChainId,
      simulationOk: preflight.simulation.ok,
      gasSource: preflight.gas.source,
      gasLimit: preflight.gasLimit,
      baseFeeWei: preflight.baseFeePerGas,
    });
    for (const warning of preflight.warnings) log.warn(warning);

    if (config.requireSimulation && !preflight.simulation.ok) {
      throw new Error(
        `Simulation failed and REQUIRE_SIMULATION is on: ${
          preflight.simulation.revertReason ?? preflight.simulation.rawError
        }\n` +
          `  Set REQUIRE_SIMULATION=false to proceed anyway (expected when waiting for a sale to open).`,
      );
    }

    // ── Funding ────────────────────────────────────────────────────────────
    const balances = await checkBalances(
      primary,
      wallets,
      config.mint.value,
      preflight.gasLimit,
      config.gas.maxFeePerGas,
      config.txPerWallet,
    );
    log.info('Balances:\n' + formatBalanceReport(balances));
    const underfunded = balances.filter((b) => !b.sufficient);
    if (underfunded.length > 0) {
      throw new Error(
        `${underfunded.length} wallet(s) cannot cover value + worst-case gas. ` +
          `Fund them or lower MINT_QUANTITY / TX_PER_WALLET / MAX_FEE_GWEI.`,
      );
    }

    // ── Pre-sign ───────────────────────────────────────────────────────────
    const nonces = new NonceManager();
    await nonces.prime(primary, wallets);

    const prepared = await presignAll({
      config,
      wallets,
      nonces,
      gasLimit: preflight.gasLimit,
    });
    log.info('Transactions pre-signed', summarize(prepared));
    log.info('Maximum ETH at risk this run', {
      eth: formatEther(totalCommitment(prepared)),
    });

    if (config.dryRun) {
      log.warn('DRY_RUN is set — stopping before broadcast.');
      for (const tx of prepared) {
        log.info('would send', {
          from: tx.from,
          nonce: tx.nonce,
          hash: tx.hash,
          valueWei: tx.value,
          gas: tx.gas,
        });
      }
      return { preflight, prepared, outcomes: [], minted: 0, failed: 0 };
    }

    // ── Feed (only when it is the trigger source) ───────────────────────────
    let feed: FeedConsumer | undefined;
    if (config.trigger.mode === 'feed') {
      feed = new FeedConsumer({ url: config.feedUrl });
      feed.start();
      // Give the socket a moment to establish before we start depending on it.
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      // ── Trigger ──────────────────────────────────────────────────────────
      const trigger = await waitForTrigger({
        config,
        client: primary,
        feed,
        signal: controller.signal,
      });
      hot('trigger', { reason: trigger.reason, ...trigger.detail });
      log.info('TRIGGER FIRED', { reason: trigger.reason, ...trigger.detail });

      // ── Critical section ─────────────────────────────────────────────────
      const outcomes = await submitAll(submitClients, prepared);
      flushHot();
      log.info('Broadcast complete', summarizeOutcomes(outcomes));

      for (const outcome of outcomes) {
        if (outcome.accepted) {
          log.info('accepted', {
            nonce: outcome.tx.nonce,
            hash: outcome.tx.hash,
            viaMs: outcome.elapsedMs.toFixed(1),
            endpoint: outcome.endpoint,
          });
        } else {
          log.error('rejected', {
            nonce: outcome.tx.nonce,
            from: outcome.tx.from,
            error: outcome.error,
          });
        }
      }

      // ── Confirmation ─────────────────────────────────────────────────────
      const acceptedHashes = outcomes.filter((o) => o.accepted).map((o) => o.tx.hash);
      if (acceptedHashes.length === 0) {
        return { preflight, prepared, outcomes, minted: 0, failed: outcomes.length };
      }

      log.info('Waiting for receipts', { count: acceptedHashes.length });
      const receipts = await waitForReceipts(primary, acceptedHashes);

      let minted = 0;
      let failed = 0;
      for (const [hash, receipt] of receipts) {
        const url = explorerTxUrl(config.network, hash);
        if (!receipt) {
          failed += 1;
          log.warn('no receipt within timeout', { hash, url });
        } else if (BigInt(receipt.status) === 1n) {
          minted += 1;
          log.info('MINTED', {
            hash,
            block: BigInt(receipt.blockNumber),
            gasUsed: BigInt(receipt.gasUsed),
            url,
          });
        } else {
          failed += 1;
          log.error('reverted on chain', {
            hash,
            block: BigInt(receipt.blockNumber),
            url,
          });
        }
      }

      log.info('Run finished', { minted, failed });
      return { preflight, prepared, outcomes, minted, failed };
    } finally {
      feed?.stop();
    }
  } finally {
    for (const client of clients) client.destroy();
  }
}
