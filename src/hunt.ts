import { formatEther, type Address, type Hex } from 'viem';
import {
  loadHuntRuntime,
  loadTrackerConfig,
  type HuntRuntime,
} from './config.js';
import { RpcClient } from './rpc.js';
import { FeedConsumer } from './feed.js';
import { MintTracker, type TrackedCollection } from './tracker.js';
import { parseExtraSelectors } from './mintdetect.js';
import { inspectContract, type ContractInfo } from './inspect.js';
import { evaluate, formatDuration, type Evaluation, type HuntCriteria } from './criteria.js';
import { buildAutoMintCalls, recoverSampleSender, type AutoMintCall } from './mintcall.js';
import { signOne, type PreparedTx } from './presign.js';
import { submitAll, waitForReceipts } from './submit.js';
import { loadWallets, NonceManager, type Wallet } from './wallet.js';
import { explorerTxUrl } from './chain.js';
import { errorMessage } from './http.js';
import { isClose, toFinding } from './findings.js';
import { recordFinding } from './store.js';
import { log } from './logger.js';

/**
 * One hunt cycle: watch, judge, and buy.
 *
 * Designed to complete inside a single serverless invocation, so a scheduler
 * can call it on a loop and get continuous coverage without any process
 * needing to stay alive between runs. Each cycle is self-contained:
 *
 *   1. sample the sequencer feed for a fixed window
 *   2. cheaply rule out collections that cannot qualify (no network calls)
 *   3. read supply, price, and sale state from the survivors' contracts
 *   4. score every candidate against the criteria, keeping the reasoning
 *   5. mint the ones that pass, across every wallet
 *
 * State between cycles is deliberately kept ON CHAIN rather than in a
 * database. Before minting, the wallet's balance for that contract is checked;
 * a non-zero balance means a previous cycle already bought it. That makes the
 * loop idempotent without any storage to provision, lose, or get out of sync.
 */

export interface HuntConfig {
  /** Seconds to sample the feed. Must leave room for minting inside the budget. */
  windowSec: number;
  /** How many top candidates to spend contract reads on. */
  inspectTop: number;
  /** Maximum collections to mint in one cycle. */
  maxMintsPerCycle: number;
  /** Report what would happen without broadcasting. */
  dryRun: boolean;
  criteria: HuntCriteria;
}

export interface Candidate {
  collection: TrackedCollection;
  info?: ContractInfo;
  evaluation: Evaluation;
  minted?: {
    attempted: number;
    accepted: number;
    confirmed: number;
    txs: Array<{ hash: string; url: string; accepted: boolean }>;
    /** How the calldata was produced, once one was proven against the chain. */
    strategy?: string;
    /** Plain-language account of what was sent. */
    how?: string;
    error?: string;
  };
}

export interface HuntReport {
  startedAt: string;
  durationMs: number;
  sampledSeconds: number;
  feedConnected: boolean;
  feedUrl: string;
  observed: {
    feedTxSeen: number;
    mintsSeen: number;
    contractsTracked: number;
  };
  candidates: Candidate[];
  qualified: number;
  mintedCollections: number;
  dryRun: boolean;
  criteria: HuntCriteria;
  note: string;
}

/** Serializable form of the criteria, for the API and UI. */
export function criteriaForDisplay(c: HuntCriteria): Record<string, unknown> {
  return {
    minMintsPerMinute: c.minMintsPerMinute,
    minUniqueMinters: c.minUniqueMinters,
    minAttemptsInWindow: c.minAttemptsInWindow,
    maxAgeSec: c.maxAgeSec,
    requireLive: c.requireLive,
    maxSelloutSec: c.maxSelloutSec,
    maxSupplyProgressPct: c.maxSupplyProgressPct,
    freeOnly: c.freeOnly,
    maxPriceEth: formatEther(c.maxPriceWei),
    requireSaleOpen: c.requireSaleOpen,
    skipIfOwned: c.skipIfOwned,
  };
}

/**
 * Cheap pre-filter, run before any contract reads.
 *
 * Contract inspection costs several RPC round trips per collection, and a busy
 * feed window can surface dozens. Discarding the obvious misses first keeps a
 * cycle inside its time budget.
 */
function couldQualify(c: TrackedCollection, criteria: HuntCriteria): boolean {
  if (criteria.requireLive && c.status !== 'live') return false;
  if (c.ageSec > criteria.maxAgeSec) return false;
  if (c.attemptsInWindow < criteria.minAttemptsInWindow) return false;
  if (c.attemptsPerMinute < criteria.minMintsPerMinute) return false;
  if (c.uniqueMinters < criteria.minUniqueMinters) return false;
  if (criteria.freeOnly && !c.isFree) return false;
  return true;
}

/**
 * Whose wallets a cycle mints from, and through whose endpoint.
 *
 * Supplied when a signed-up account drives the hunt: its ten generated wallets
 * replace PRIVATE_KEYS, and its own RPC — if it set one — is preferred over the
 * deployment's. Absent, the cycle runs on the operator's own configuration,
 * which is how the CLI and the cron path use it.
 */
export interface HuntIdentity {
  privateKeys: Hex[];
  /** The account's own endpoint, tried ahead of the deployment's. */
  rpcUrls?: string[];
  /** Keeps one account's history out of another's. */
  namespace?: string;
}

export async function runHuntCycle(
  hunt: HuntConfig,
  base: NodeJS.ProcessEnv = process.env,
  identity?: HuntIdentity,
): Promise<HuntReport> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const trackerCfg = loadTrackerConfig(base);

  // ── 1. Sample the feed ───────────────────────────────────────────────────
  const tracker = new MintTracker({
    velocityWindowSec: trackerCfg.velocityWindowSec,
    minAttempts: trackerCfg.minAttempts,
    minUniqueMinters: trackerCfg.minUniqueMinters,
    maxContractAgeSec: trackerCfg.maxContractAgeSec,
    freeOnly: hunt.criteria.freeOnly,
    // Unique minters are a hard gate here, so recovery must be on despite the cost.
    trackUniqueMinters: true,
    maxContracts: trackerCfg.maxContracts,
    evictAfterSec: trackerCfg.evictAfterSec,
    extraSelectors: parseExtraSelectors(trackerCfg.extraSelectorsRaw),
  });

  const feed = new FeedConsumer({ url: trackerCfg.feedUrl });
  let feedConnected = false;
  feed.on('open', () => {
    feedConnected = true;
  });
  feed.on('error', () => {
    /* the consumer logs and reconnects; sampling continues */
  });
  feed.on('tx', (tx, msg) => tracker.ingest(tx, msg?.sequenceNumber));
  feed.start();

  await new Promise((r) => setTimeout(r, hunt.windowSec * 1000));
  feed.stop();

  const snapshot = tracker.snapshot(100);
  const observed = {
    feedTxSeen: tracker.totalSeen,
    mintsSeen: tracker.totalMints,
    contractsTracked: tracker.size(),
  };

  // ── 2. Pre-filter, then inspect survivors ────────────────────────────────
  const shortlist = snapshot
    .filter((c) => couldQualify(c, hunt.criteria))
    .slice(0, hunt.inspectTop);

  // Only what hunting actually needs. It finds its target on the feed, so
  // requiring CONTRACT_ADDRESS or MINT_FUNCTION here would be wrong -- and was
  // the bug that made every round fail once those variables existed but blank.
  const base_ = loadHuntRuntime(base, identity === undefined);
  // An account's own endpoint goes first: it is the one the user chose, and on
  // a FCFS chain the endpoint you submit through is the whole race.
  const config: HuntRuntime = identity
    ? {
        ...base_,
        privateKeys: identity.privateKeys,
        rpcUrls: [...(identity.rpcUrls ?? []), ...base_.rpcUrls],
      }
    : base_;

  const clients = [
    ...config.rpcUrls.map((u) => new RpcClient(u, { maxSockets: 16 })),
  ];
  const submitOnly = (config.submitOnlyUrls ?? []).map(
    (u) => new RpcClient(u, { maxSockets: 16 }),
  );
  const primary = clients[0];
  const wallets = loadWallets(config.privateKeys);

  const candidates: Candidate[] = [];
  let mintedCollections = 0;

  try {
    for (const collection of shortlist) {
      let info: ContractInfo | undefined;
      try {
        info = await inspectContract(
          primary,
          collection.contract as Address,
          wallets[0].address,
        );
      } catch (err) {
        log.debug('inspect failed', {
          contract: collection.contract,
          error: errorMessage(err),
        });
      }

      const evaluation = evaluate(collection, hunt.criteria, info);
      const candidate: Candidate = { collection, info, evaluation };
      candidates.push(candidate);

      if (!evaluation.passed) continue;
      if (mintedCollections >= hunt.maxMintsPerCycle) {
        candidate.minted = {
          attempted: 0, accepted: 0, confirmed: 0, txs: [],
          error:
            `already bought ${mintedCollections} collection(s) this round — ` +
            `raise HUNT_MAX_MINTS_PER_CYCLE to buy more per round`,
        };
        continue;
      }

      log.info('QUALIFIED', {
        contract: collection.contract,
        reason: evaluation.reason,
        sellout: evaluation.projectedSelloutSec
          ? formatDuration(evaluation.projectedSelloutSec)
          : 'unknown',
      });

      candidate.minted = await mintCandidate({
        collection, info, config, wallets, primary,
        submitClients: [...submitOnly, ...clients],
        dryRun: hunt.dryRun,
        freeOnly: hunt.criteria.freeOnly,
        maxValueWei: hunt.criteria.maxPriceWei,
      });
      if (!candidate.minted.error) mintedCollections += 1;
    }
  } finally {
    for (const c of [...clients, ...submitOnly]) c.destroy();
  }

  const qualified = candidates.filter((c) => c.evaluation.passed).length;

  // ── 6. Remember what was worth remembering ───────────────────────────────
  // Written after the loop so every record carries its final mint outcome
  // rather than the state it had mid-round. Only passers and near misses are
  // kept: a collection scoring 12 is noise, but one scoring 94 is exactly what
  // an operator wants to see when deciding whether the criteria are too tight.
  const worthKeeping = candidates
    .map((c) => toFinding(c))
    .filter((f) => f.passed || isClose(f.score));
  await Promise.all(
    worthKeeping.map((f) => recordFinding(f, base, identity?.namespace)),
  );

  return {
    startedAt,
    durationMs: Math.round(performance.now() - started),
    sampledSeconds: hunt.windowSec,
    feedConnected,
    feedUrl: trackerCfg.feedUrl,
    observed,
    candidates,
    qualified,
    mintedCollections,
    dryRun: hunt.dryRun,
    criteria: hunt.criteria,
    note: feedConnected
      ? `Sampled ${hunt.windowSec}s; ${shortlist.length} of ${snapshot.length} collections were worth inspecting.`
      : 'Could not connect to the sequencer feed — nothing was observed this cycle.',
  };
}

interface MintCandidateParams {
  collection: TrackedCollection;
  info?: ContractInfo;
  config: HuntRuntime;
  wallets: Wallet[];
  primary: RpcClient;
  submitClients: RpcClient[];
  dryRun: boolean;
  /** When true, send zero value regardless of what was observed. */
  freeOnly: boolean;
  /** Hard ceiling on the value attached to a single mint. */
  maxValueWei: bigint;
}

/** Mint one qualifying collection across every wallet. */
async function mintCandidate(
  params: MintCandidateParams,
): Promise<NonNullable<Candidate['minted']>> {
  const { collection, config, wallets, primary, submitClients, dryRun, freeOnly, maxValueWei } =
    params;
  const empty = { attempted: 0, accepted: 0, confirmed: 0, txs: [] };

  // In free-only mode send nothing, whatever the feed showed. Otherwise pay
  // what real minters were observed paying — but never more than the ceiling,
  // whatever the observation said.
  //
  // The criteria already reject an over-priced collection, so this clamp should
  // never bind. It is here because `observedValueWei` is an average of numbers
  // an attacker can push up by spamming the contract, and a single divergence
  // between the check and the spend would be paid for in ETH. Two independent
  // bounds on the same number is the cheap insurance.
  const observedValue = BigInt(collection.observedValueWei);
  const value = freeOnly
    ? 0n
    : observedValue > maxValueWei
      ? maxValueWei
      : observedValue;
  const contract = collection.contract as Address;

  // Who sent the calldata we sampled. One ECDSA recovery, which is far too slow
  // over a live feed but nothing at all here — and it is what lets the address
  // swap work on an entrypoint nobody has ever seen.
  const observedSender = await recoverSampleSender(collection.sampleRaw);

  const candidates = buildAutoMintCalls({
    selector: collection.topSelector,
    observed: collection.sampleCalldata,
    observedSender,
  });

  if (candidates.length === 0) {
    return {
      ...empty,
      error:
        `no working mint transaction was captured for this collection, so there is ` +
        `nothing to copy. This usually means it was flagged from very few attempts. ` +
        `It will resolve on its own once more people mint it.`,
    };
  }

  // Let the chain decide. Every candidate is a guess about where the recipient
  // sits in the calldata; a simulation from our own wallet settles it for the
  // price of a round trip, and nothing is broadcast until one passes.
  let call: AutoMintCall | undefined;
  const rejected: string[] = [];
  for (const candidate of candidates) {
    try {
      await primary.call('eth_call', [
        {
          from: wallets[0].address,
          to: contract,
          data: candidate.buildFor(wallets[0].address),
          value: `0x${value.toString(16)}`,
        },
        'latest',
      ]);
      call = candidate;
      break;
    } catch (err) {
      rejected.push(`${candidate.strategy}: ${errorMessage(err)}`);
    }
  }

  if (!call) {
    return {
      ...empty,
      error:
        `every way of reproducing this mint was rejected on chain, so nothing was sent. ` +
        `Tried ${rejected.length} — ${rejected.join(' | ')}. Common causes are a ` +
        `per-wallet limit already reached, an allowlist you are not on, or the sale ` +
        `closing between the scan and the attempt.`,
    };
  }

  log.info('MINT CALL CHOSEN', {
    contract,
    strategy: call.strategy,
    signature: call.signature ?? 'unknown entrypoint',
    rejected: rejected.length,
  });

  let gasLimit = 300_000n;
  try {
    const hex = await primary.call<Hex>('eth_estimateGas', [
      {
        from: wallets[0].address,
        to: contract,
        data: call.buildFor(wallets[0].address),
        value: `0x${value.toString(16)}`,
      },
    ]);
    gasLimit = (BigInt(hex) * 13n) / 10n;
  } catch {
    /* keep the conservative default */
  }

  // Only mint from wallets that can actually pay. A wallet short of gas fails
  // at broadcast, which on a FCFS chain means losing the race while still
  // holding up the batch — so it is filtered out here rather than discovered
  // mid-flight. Funded wallets still go ahead; one empty wallet must not stop
  // the others.
  const perTxCost = value + gasLimit * config.gas.maxFeePerGas;
  const funded: Wallet[] = [];
  const unfunded: string[] = [];
  await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const hex = await primary.call<Hex>('eth_getBalance', [wallet.address, 'latest']);
        if (BigInt(hex) >= perTxCost) funded.push(wallet);
        else unfunded.push(wallet.address);
      } catch {
        // Treat an unreadable balance as unfunded rather than risk a revert.
        unfunded.push(wallet.address);
      }
    }),
  );

  if (funded.length === 0) {
    return {
      ...empty,
      error:
        `no wallet holds enough ETH for gas (${formatEther(perTxCost)} needed per mint). ` +
        `Fund them with ETH bridged onto this chain.`,
    };
  }
  if (unfunded.length > 0) {
    log.warn('skipping unfunded wallets', { count: unfunded.length, needed: formatEther(perTxCost) });
  }

  const nonces = new NonceManager();
  await nonces.prime(primary, funded);

  const prepared: PreparedTx[] = [];
  for (const wallet of funded) {
    prepared.push(
      await signOne({
        wallet,
        nonce: nonces.allocate(wallet.address),
        gasLimit,
        // signOne reads only these three; building them explicitly keeps the
        // hunt runtime from having to masquerade as a full mint config.
        config: {
          chainId: config.chainId,
          gas: config.gas,
          mint: { contract, rawCalldata: call.buildFor(wallet.address), args: [], value },
        },
      }),
    );
  }

  if (dryRun) {
    return {
      attempted: prepared.length,
      accepted: 0,
      confirmed: 0,
      strategy: call.strategy,
      how: call.describe,
      txs: prepared.map((t) => ({
        hash: t.hash,
        url: explorerTxUrl(config.network, t.hash),
        accepted: false,
      })),
      error:
        'practice mode — everything was prepared and signed, but nothing was sent. ' +
        'Switch to live in the header to buy for real.',
    };
  }

  const outcomes = await submitAll(submitClients, prepared);
  const accepted = outcomes.filter((o) => o.accepted);
  const receipts = await waitForReceipts(
    primary,
    accepted.map((o) => o.tx.hash),
    30_000,
  );

  let confirmed = 0;
  for (const [, receipt] of receipts) {
    if (receipt && BigInt(receipt.status) === 1n) confirmed += 1;
  }

  return {
    attempted: prepared.length,
    accepted: accepted.length,
    confirmed,
    strategy: call.strategy,
    how: call.describe,
    txs: outcomes.map((o) => ({
      hash: o.tx.hash,
      url: explorerTxUrl(config.network, o.tx.hash),
      accepted: o.accepted,
    })),
  };
}
