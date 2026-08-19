import { formatEther, type Address, type Hex } from 'viem';
import { buildAutoMintCall, type AutoMintCall } from './mintcall.js';
import { FeedConsumer } from './feed.js';
import { MintTracker, type HotCollection, type TrackerConfig } from './tracker.js';
import { RpcClient } from './rpc.js';
import { signOne } from './presign.js';
import { submitAll, waitForReceipts } from './submit.js';
import { NonceManager, loadWallets, type Wallet } from './wallet.js';
import { flushHot, log } from './logger.js';
import { explorerTxUrl } from './chain.js';
import type { BotConfig } from './config.js';

/**
 * Autopilot: watch the feed, spot collections being minted hard, and mint them
 * across every configured wallet.
 *
 * This is the highest-risk mode in the project. It sends transactions to
 * contracts nobody has vetted, chosen by a heuristic, with no human in the
 * loop. The rails below are not optional garnish — they are what keeps a bad
 * night from being an expensive one:
 *
 *   - a hard global ETH budget, and a per-collection cap;
 *   - free-only mode by default, so value sent is zero;
 *   - a mandatory successful simulation before anything is broadcast;
 *   - a denylist, an optional allowlist, and a per-hour collection cap;
 *   - a gas-limit ceiling, because even a free mint can burn a full tank of
 *     gas in a hostile contract.
 *
 * Even with all of that: a "free" mint still costs gas, and a malicious
 * contract can consume the entire gas limit on every wallet you own. Run this
 * with burner wallets holding only what you can afford to lose.
 */

export interface AutopilotConfig {
  /** Only mint collections where the observed mint attaches no ETH. */
  freeOnly: boolean;
  /** Total ETH (in wei) this process may spend on gas + value, ever. */
  totalBudgetWei: bigint;
  /** Max ETH (in wei) committed to any single collection. */
  perCollectionBudgetWei: bigint;
  /** Refuse a collection whose gas estimate exceeds this. */
  maxGasLimit: bigint;
  /** Contracts never to touch. */
  denylist: ReadonlySet<Address>;
  /** When non-empty, the only contracts that may be minted. */
  allowlist: ReadonlySet<Address>;
  /** Cap on collections minted per rolling hour. */
  maxCollectionsPerHour: number;
  /** Transactions per wallet per collection. */
  txPerWallet: number;
  /** Report what it would do without broadcasting. */
  dryRun: boolean;
}

export { buildAutoMintCall, type AutoMintCall };

export interface AutopilotResult {
  contract: Address;
  attempted: number;
  minted: number;
  failed: number;
  spentWei: bigint;
  skippedReason?: string;
}

export class Autopilot {
  private readonly config: AutopilotConfig;
  private readonly botConfig: BotConfig;
  private readonly clients: RpcClient[];
  private readonly wallets: Wallet[];
  private spentWei = 0n;
  private readonly mintedAt: number[] = [];
  private readonly handled = new Set<Address>();
  private busy = false;

  readonly results: AutopilotResult[] = [];

  constructor(params: {
    botConfig: BotConfig;
    autopilot: AutopilotConfig;
    clients: RpcClient[];
  }) {
    this.botConfig = params.botConfig;
    this.config = params.autopilot;
    this.clients = params.clients;
    this.wallets = loadWallets(params.botConfig.privateKeys);
  }

  get budgetRemainingWei(): bigint {
    return this.config.totalBudgetWei - this.spentWei;
  }

  /** Reasons a hot collection is rejected before any network call. */
  private screen(hot: HotCollection): string | undefined {
    const contract = hot.contract.toLowerCase() as Address;

    if (this.handled.has(contract)) return 'already handled';
    if (this.config.denylist.has(contract)) return 'denylisted';
    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(contract)) {
      return 'not in allowlist';
    }
    if (this.config.freeOnly && !hot.isFree) return 'not a free mint';
    if (this.config.freeOnly && hot.observedValueWei > 0n) {
      return 'observed mints attach ETH';
    }

    const hourAgo = Date.now() - 3_600_000;
    const recent = this.mintedAt.filter((t) => t >= hourAgo).length;
    if (recent >= this.config.maxCollectionsPerHour) return 'hourly collection cap reached';

    if (this.budgetRemainingWei <= 0n) return 'total budget exhausted';

    return undefined;
  }

  /**
   * Handle one hot collection. Serialized: minting is latency-sensitive and
   * running two collections concurrently would have them contend for nonces
   * on the same wallets.
   */
  async handle(hot: HotCollection): Promise<AutopilotResult> {
    const contract = hot.contract.toLowerCase() as Address;

    const skip = this.screen(hot);
    if (skip) {
      log.debug('autopilot skip', { contract, reason: skip });
      return { contract, attempted: 0, minted: 0, failed: 0, spentWei: 0n, skippedReason: skip };
    }

    if (this.busy) {
      return {
        contract,
        attempted: 0,
        minted: 0,
        failed: 0,
        spentWei: 0n,
        skippedReason: 'busy with another collection',
      };
    }

    this.busy = true;
    this.handled.add(contract);

    try {
      return await this.mintCollection(hot, contract);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('autopilot aborted collection', { contract, error: message });
      return {
        contract,
        attempted: 0,
        minted: 0,
        failed: 0,
        spentWei: 0n,
        skippedReason: message,
      };
    } finally {
      this.busy = false;
    }
  }

  private async mintCollection(
    hot: HotCollection,
    contract: Address,
  ): Promise<AutopilotResult> {
    const primary = this.clients[0];

    const call = buildAutoMintCall(hot.topSelector, hot.sampleCalldata);
    if (!call) {
      throw new Error(
        `cannot construct a safe mint call for selector ${hot.topSelector ?? 'none'}`,
      );
    }

    const value = this.config.freeOnly ? 0n : hot.observedValueWei;

    // Confirm there is really a contract here before spending anything.
    const code = await primary.call<Hex>('eth_getCode', [contract, 'latest']);
    if (!code || code === '0x') throw new Error('no contract code at address');

    // Simulate from the first wallet. A revert here means the mint would fail,
    // and auto-minting into a revert wastes gas on every wallet at once.
    const probeData = call.buildFor(this.wallets[0].address);
    try {
      await primary.call('eth_call', [
        {
          from: this.wallets[0].address,
          to: contract,
          data: probeData,
          value: `0x${value.toString(16)}`,
        },
        'latest',
      ]);
    } catch (err) {
      throw new Error(
        `simulation reverted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Estimate gas, then cap it. An unbounded estimate on a hostile contract is
    // exactly how a "free" mint becomes expensive.
    let gasLimit: bigint;
    try {
      const hex = await primary.call<Hex>('eth_estimateGas', [
        {
          from: this.wallets[0].address,
          to: contract,
          data: probeData,
          value: `0x${value.toString(16)}`,
        },
      ]);
      gasLimit = (BigInt(hex) * 13n) / 10n;
    } catch {
      gasLimit = this.config.maxGasLimit;
    }
    if (gasLimit > this.config.maxGasLimit) {
      throw new Error(
        `gas estimate ${gasLimit} exceeds AUTO_MAX_GAS_LIMIT ${this.config.maxGasLimit}`,
      );
    }

    // Budget check against the true worst case, before committing.
    const perTx = value + gasLimit * this.botConfig.gas.maxFeePerGas;
    const totalTx = BigInt(this.wallets.length * this.config.txPerWallet);
    const worstCase = perTx * totalTx;

    if (worstCase > this.config.perCollectionBudgetWei) {
      throw new Error(
        `worst-case ${formatEther(worstCase)} ETH exceeds per-collection cap ` +
          `${formatEther(this.config.perCollectionBudgetWei)} ETH`,
      );
    }
    if (worstCase > this.budgetRemainingWei) {
      throw new Error(
        `worst-case ${formatEther(worstCase)} ETH exceeds remaining budget ` +
          `${formatEther(this.budgetRemainingWei)} ETH`,
      );
    }

    log.info('AUTOPILOT MINTING', {
      contract,
      signature: call.signature,
      strategy: call.strategy,
      wallets: this.wallets.length,
      txPerWallet: this.config.txPerWallet,
      valueWei: value,
      gasLimit,
      worstCaseEth: formatEther(worstCase),
      attemptsInWindow: hot.attemptsInWindow,
      uniqueMinters: hot.uniqueMinters,
    });

    // One transaction per wallet is what turns a one-per-wallet limit into
    // `wallets` mints: each wallet has its own nonce sequence and its own
    // recipient address.
    const nonces = new NonceManager();
    await nonces.prime(primary, this.wallets);

    const prepared = [];
    for (const wallet of this.wallets) {
      for (let i = 0; i < this.config.txPerWallet; i++) {
        prepared.push(
          await signOne({
            wallet,
            nonce: nonces.allocate(wallet.address),
            gasLimit,
            config: {
              ...this.botConfig,
              mint: {
                contract,
                rawCalldata: call.buildFor(wallet.address),
                args: [],
                value,
              },
            } as BotConfig,
          }),
        );
      }
    }

    if (this.config.dryRun) {
      log.warn('AUTO_DRY_RUN set — not broadcasting', {
        contract,
        wouldSend: prepared.length,
      });
      return {
        contract,
        attempted: prepared.length,
        minted: 0,
        failed: 0,
        spentWei: 0n,
        skippedReason: 'dry run',
      };
    }

    const outcomes = await submitAll(this.clients, prepared);
    flushHot();

    this.spentWei += worstCase;
    this.mintedAt.push(Date.now());

    const accepted = outcomes.filter((o) => o.accepted);
    const hashes = accepted.map((o) => o.tx.hash);
    const receipts = await waitForReceipts(primary, hashes, 45_000);

    let minted = 0;
    let failed = outcomes.length - accepted.length;
    for (const [hash, receipt] of receipts) {
      if (receipt && BigInt(receipt.status) === 1n) {
        minted += 1;
        log.info('AUTO MINTED', {
          contract,
          hash,
          url: explorerTxUrl(this.botConfig.network, hash),
        });
      } else {
        failed += 1;
      }
    }

    const result: AutopilotResult = {
      contract,
      attempted: prepared.length,
      minted,
      failed,
      spentWei: worstCase,
    };
    this.results.push(result);

    log.info('AUTOPILOT COLLECTION DONE', {
      contract,
      minted,
      failed,
      budgetRemainingEth: formatEther(this.budgetRemainingWei),
    });

    return result;
  }

  summary(): Record<string, unknown> {
    return {
      collections: this.results.length,
      minted: this.results.reduce((n, r) => n + r.minted, 0),
      failed: this.results.reduce((n, r) => n + r.failed, 0),
      spentEth: formatEther(this.spentWei),
      budgetRemainingEth: formatEther(this.budgetRemainingWei),
    };
  }
}

/** Wire a feed, a tracker, and an autopilot together and run until aborted. */
export async function runAutopilot(params: {
  botConfig: BotConfig;
  autopilot: AutopilotConfig;
  tracker: Partial<TrackerConfig>;
  signal?: AbortSignal;
}): Promise<Autopilot> {
  const clients = params.botConfig.rpcUrls.map((url) => new RpcClient(url, { maxSockets: 16 }));

  log.info('Warming endpoints', { count: clients.length });
  await Promise.all(
    clients.map((c) =>
      c.warm(2).catch((err: unknown) => {
        log.warn('warm failed', {
          endpoint: c.endpoint,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ),
  );

  const tracker = new MintTracker({
    ...params.tracker,
    freeOnly: params.autopilot.freeOnly,
  });
  const pilot = new Autopilot({
    botConfig: params.botConfig,
    autopilot: params.autopilot,
    clients,
  });

  const feed = new FeedConsumer({ url: params.botConfig.feedUrl });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  tracker.on('hot', (hot: HotCollection) => {
    void pilot.handle(hot);
  });

  feed.start();

  log.info('Autopilot armed', {
    freeOnly: params.autopilot.freeOnly,
    wallets: params.botConfig.privateKeys.length,
    budgetEth: formatEther(params.autopilot.totalBudgetWei),
    velocityWindowSec: tracker.config.velocityWindowSec,
    minAttempts: tracker.config.minAttempts,
    minUniqueMinters: tracker.config.minUniqueMinters,
  });

  const statsTimer = setInterval(() => {
    log.info('tracker', { ...tracker.stats(), ...pilot.summary() });
  }, 60_000);
  statsTimer.unref?.();

  await new Promise<void>((resolve) => {
    if (params.signal?.aborted) return resolve();
    params.signal?.addEventListener('abort', () => resolve(), { once: true });
  });

  clearInterval(statsTimer);
  feed.stop();
  for (const c of clients) c.destroy();
  return pilot;
}
