import 'dotenv/config';
import { isAddress, isHex, parseEther, type Address, type Hex } from 'viem';
import {
  defaultRpcFor,
  feedFor,
  sequencerRpcFor,
  type NetworkName,
} from './chain.js';

/**
 * Configuration is resolved once at startup and then frozen. Nothing on the
 * hot path reads `process.env` — every value the submit path needs is already
 * a parsed primitive by the time a mint window opens.
 */

export interface MintCallConfig {
  /** The NFT contract being minted. */
  contract: Address;
  /**
   * Either an explicit function signature plus arguments, or raw calldata.
   *
   * Raw calldata is the most reliable option in practice: copy the input data
   * from a successful mint transaction on the explorer and the bot reproduces
   * it byte for byte, with no guessing about the ABI.
   */
  rawCalldata?: Hex;
  functionSignature?: string;
  args: string[];
  /** Wei sent with each mint transaction (price * quantity). */
  value: bigint;
}

export interface GasConfig {
  /**
   * Hard gas limit. Pre-computed so the bot never calls eth_estimateGas during
   * the race — that round trip alone can cost more than the whole mint window.
   * When unset, preflight fills it in from a simulation.
   */
  gasLimit?: bigint;
  /** Multiplier applied to a simulated gas estimate for headroom. */
  gasLimitMultiplier: number;
  /**
   * Ceiling on the fee per gas, in wei.
   *
   * On Robinhood Chain this is a solvency bound, not a race lever: ordering is
   * FCFS, so paying more does NOT buy priority. Set it high enough to survive
   * a base-fee spike, not high enough to hurt if it is fully consumed.
   */
  maxFeePerGas: bigint;
  /**
   * Priority fee, in wei. Defaults to zero: with no Timeboost auction on this
   * chain there is no ordering benefit to a tip, so a non-zero value is simply
   * money burned. Exposed only because a chain-config change could alter that.
   */
  maxPriorityFeePerGas: bigint;
}

export type TriggerMode = 'now' | 'time' | 'poll' | 'feed';

export interface TriggerConfig {
  mode: TriggerMode;
  /** For `time`: unix milliseconds at which to fire. */
  fireAtMs?: number;
  /**
   * Fire this many milliseconds BEFORE the target, to absorb network flight
   * time. Tune it to your measured RTT to the sequencer.
   */
  leadMs: number;
  /** For `poll`: milliseconds between state checks. */
  pollIntervalMs: number;
  /**
   * For `poll`: a view function that returns true once minting is open, e.g.
   * `saleIsActive() (bool)`. Polled until it flips.
   */
  readySignature?: string;
  /**
   * For `feed`: fire when the sequencer feed shows a transaction to the target
   * contract carrying this 4-byte selector (typically the owner's
   * `setSaleActive` call). This is the earliest possible signal.
   */
  feedSelector?: Hex;
}

export interface BotConfig {
  network: NetworkName;
  chainId: number;
  rpcUrls: string[];
  /**
   * Broadcast-only endpoints, raced alongside `rpcUrls` at fire time.
   *
   * These skip the RPC-provider relay hop and hand the transaction straight to
   * the sequencer. They are never health-checked or used for reads, because a
   * submission endpoint is not obliged to serve them.
   */
  submitOnlyUrls: string[];
  /**
   * Send a throwaway `eth_sendRawTransaction` during warmup.
   *
   * Optional and off by default: it only helps if a provider routes writes
   * through a different handler than reads, and it costs every endpoint a junk
   * request on each run.
   */
  warmSendPath?: boolean;
  feedUrl: string;
  privateKeys: Hex[];
  mint: MintCallConfig;
  gas: GasConfig;
  trigger: TriggerConfig;
  /** Transactions to send per wallet, on consecutive nonces. */
  txPerWallet: number;
  /** Abort if a preflight simulation reverts. Keep this on. */
  requireSimulation: boolean;
  dryRun: boolean;
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Build the config readers over an explicit environment.
 *
 * Taking the environment as a parameter rather than reading `process.env`
 * directly is what lets the web UI supply per-request overrides — a serverless
 * function serves many different mints without a redeploy, and passing a
 * merged map keeps that path free of shared mutable state between concurrent
 * invocations.
 */
function createEnvReader(env: NodeJS.ProcessEnv) {
  const opt = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return undefined;
    return String(raw).trim();
  };

  const req = (name: string): string => {
    const value = opt(name);
    if (value === undefined) {
      throw new ConfigError(`Missing required environment variable ${name}`);
    }
    return value;
  };

  const optNumber = (name: string, fallback: number): number => {
    const raw = opt(name);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new ConfigError(`${name} must be a number, got "${raw}"`);
    }
    return parsed;
  };

  const optBool = (name: string, fallback: boolean): boolean => {
    const raw = opt(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
  };

  return { opt, req, optNumber, optBool };
}

/** Parse a decimal gwei string into wei. Avoids float error on large values. */
export function gweiToWei(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new ConfigError(`Expected a gwei amount, got "${value}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > 9) {
    throw new ConfigError(`gwei value "${value}" has more than 9 decimal places`);
  }
  const padded = frac.padEnd(9, '0');
  return BigInt(whole) * 1_000_000_000n + BigInt(padded);
}

/**
 * Load just the wallet keys and network, without requiring a full mint
 * configuration.
 *
 * Status and balance checks are useful before a contract has been chosen, so
 * they should not be gated behind CONTRACT_ADDRESS and friends.
 */
export function loadWalletKeys(env: NodeJS.ProcessEnv = process.env): {
  network: NetworkName;
  chainId: number;
  rpcUrls: string[];
  privateKeys: Hex[];
} {
  const { opt, req } = createEnvReader(env);
  const network = parseNetwork(opt('NETWORK') ?? 'testnet');
  const rpcUrls = (opt('RPC_URLS') ?? defaultRpcFor(network))
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  return {
    network,
    chainId: network === 'mainnet' ? 4663 : 46630,
    rpcUrls,
    privateKeys: parsePrivateKeys(req('PRIVATE_KEYS')),
  };
}

function parsePrivateKeys(raw: string): Hex[] {
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .map((k) => (k.startsWith('0x') ? k : `0x${k}`));

  const seen = new Set<string>();
  for (const key of keys) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      // Never echo key material, even partially.
      throw new ConfigError(
        'PRIVATE_KEYS contains an entry that is not a 32-byte hex key',
      );
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new ConfigError('PRIVATE_KEYS contains a duplicate key');
    }
    seen.add(lower);
  }
  if (keys.length === 0) throw new ConfigError('PRIVATE_KEYS is empty');
  return keys as Hex[];
}

function parseNetwork(raw: string): NetworkName {
  if (raw === 'mainnet' || raw === 'testnet') return raw;
  throw new ConfigError(`NETWORK must be "mainnet" or "testnet", got "${raw}"`);
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  // JSON array form supports arrays-of-arrays (e.g. merkle proofs).
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new ConfigError('MINT_ARGS JSON must be an array');
    }
    return parsed.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  }
  return trimmed.split(',').map((s) => s.trim());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const { opt, req, optNumber, optBool } = createEnvReader(env);
  const network = parseNetwork(opt('NETWORK') ?? 'testnet');

  const rpcUrls = (opt('RPC_URLS') ?? defaultRpcFor(network))
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (rpcUrls.length === 0) throw new ConfigError('RPC_URLS resolved to an empty list');
  for (const url of rpcUrls) {
    if (!/^https?:\/\//.test(url)) {
      throw new ConfigError(`RPC_URLS entry is not an http(s) URL: ${url}`);
    }
  }

  const contract = req('CONTRACT_ADDRESS');
  if (!isAddress(contract)) {
    throw new ConfigError(`CONTRACT_ADDRESS is not a valid address: ${contract}`);
  }

  const rawCalldata = opt('MINT_CALLDATA');
  if (rawCalldata !== undefined && !isHex(rawCalldata)) {
    throw new ConfigError('MINT_CALLDATA must be 0x-prefixed hex');
  }
  const functionSignature = opt('MINT_FUNCTION');
  if (!rawCalldata && !functionSignature) {
    throw new ConfigError(
      'Provide either MINT_CALLDATA (raw hex, most reliable) or MINT_FUNCTION (e.g. "mint(uint256)")',
    );
  }

  const priceEth = opt('MINT_PRICE_ETH') ?? '0';
  const quantity = BigInt(optNumber('MINT_QUANTITY', 1));
  if (quantity <= 0n) throw new ConfigError('MINT_QUANTITY must be positive');
  // Value is price-per-token * quantity unless explicitly overridden.
  const valueOverride = opt('MINT_VALUE_ETH');
  const value =
    valueOverride !== undefined
      ? parseEther(valueOverride)
      : parseEther(priceEth) * quantity;

  const gas: GasConfig = {
    gasLimit: opt('GAS_LIMIT') !== undefined ? BigInt(req('GAS_LIMIT')) : undefined,
    gasLimitMultiplier: optNumber('GAS_LIMIT_MULTIPLIER', 1.3),
    maxFeePerGas: gweiToWei(opt('MAX_FEE_GWEI') ?? '0.5'),
    maxPriorityFeePerGas: gweiToWei(opt('PRIORITY_FEE_GWEI') ?? '0'),
  };
  if (gas.gasLimitMultiplier < 1) {
    throw new ConfigError('GAS_LIMIT_MULTIPLIER must be >= 1');
  }

  const mode = (opt('TRIGGER_MODE') ?? 'now') as TriggerMode;
  if (!['now', 'time', 'poll', 'feed'].includes(mode)) {
    throw new ConfigError(`TRIGGER_MODE must be one of now|time|poll|feed, got "${mode}"`);
  }

  const fireAtRaw = opt('FIRE_AT');
  let fireAtMs: number | undefined;
  if (fireAtRaw !== undefined) {
    // Accept either an ISO-8601 timestamp or unix seconds.
    const asNumber = Number(fireAtRaw);
    fireAtMs = Number.isFinite(asNumber)
      ? asNumber * 1000
      : new Date(fireAtRaw).getTime();
    if (!Number.isFinite(fireAtMs)) {
      throw new ConfigError(`FIRE_AT is not a valid timestamp: ${fireAtRaw}`);
    }
  }
  if (mode === 'time' && fireAtMs === undefined) {
    throw new ConfigError('TRIGGER_MODE=time requires FIRE_AT');
  }

  const feedSelector = opt('FEED_SELECTOR');
  if (feedSelector !== undefined && !/^0x[0-9a-fA-F]{8}$/.test(feedSelector)) {
    throw new ConfigError('FEED_SELECTOR must be a 4-byte hex selector, e.g. 0x1249c58b');
  }
  if (mode === 'feed' && feedSelector === undefined) {
    throw new ConfigError('TRIGGER_MODE=feed requires FEED_SELECTOR');
  }

  const readySignature = opt('READY_FUNCTION');
  if (mode === 'poll' && readySignature === undefined) {
    throw new ConfigError(
      'TRIGGER_MODE=poll requires READY_FUNCTION, e.g. "saleIsActive() (bool)"',
    );
  }

  const trigger: TriggerConfig = {
    mode,
    fireAtMs,
    leadMs: optNumber('LEAD_MS', 0),
    pollIntervalMs: optNumber('POLL_INTERVAL_MS', 250),
    readySignature,
    feedSelector: feedSelector as Hex | undefined,
  };

  const txPerWallet = optNumber('TX_PER_WALLET', 1);
  if (!Number.isInteger(txPerWallet) || txPerWallet < 1) {
    throw new ConfigError('TX_PER_WALLET must be a positive integer');
  }

  return Object.freeze({
    network,
    chainId: network === 'mainnet' ? 4663 : 46630,
    rpcUrls,
    // Defaults to the chain's sequencer. Read from `env` directly rather than
    // through `opt`, so an explicit empty value disables it — `opt` treats ''
    // as unset, which would silently re-enable the default.
    submitOnlyUrls: (env.SEQUENCER_URLS !== undefined
      ? env.SEQUENCER_URLS
      : sequencerRpcFor(network)
    )
      .split(',')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u)),
    warmSendPath: optBool('WARM_SEND_PATH', false),
    feedUrl: opt('FEED_URL') ?? feedFor(network),
    privateKeys: parsePrivateKeys(req('PRIVATE_KEYS')),
    mint: {
      contract: contract as Address,
      rawCalldata: rawCalldata as Hex | undefined,
      functionSignature,
      args: parseArgs(opt('MINT_ARGS')),
      value,
    },
    gas,
    trigger,
    txPerWallet,
    requireSimulation: optBool('REQUIRE_SIMULATION', true),
    dryRun: optBool('DRY_RUN', false),
  });
}

/**
 * Tracker configuration.
 *
 * Deliberately separate from `loadConfig`, and it never touches PRIVATE_KEYS.
 * The tracker and its dashboard are read-only, so they can run somewhere the
 * signing keys are not — a serverless dashboard should never be able to spend.
 */
export function loadTrackerConfig(env: NodeJS.ProcessEnv = process.env): {
  network: NetworkName;
  feedUrl: string;
  rpcUrls: string[];
  velocityWindowSec: number;
  minAttempts: number;
  minUniqueMinters: number;
  maxContractAgeSec: number;
  freeOnly: boolean;
  trackUniqueMinters: boolean;
  maxContracts: number;
  evictAfterSec: number;
  extraSelectorsRaw?: string;
} {
  const { opt, optNumber, optBool } = createEnvReader(env);
  const network = parseNetwork(opt('NETWORK') ?? 'testnet');
  return {
    network,
    feedUrl: opt('FEED_URL') ?? feedFor(network),
    rpcUrls: (opt('RPC_URLS') ?? defaultRpcFor(network))
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    velocityWindowSec: optNumber('VELOCITY_WINDOW_SEC', 15),
    minAttempts: optNumber('MIN_MINTS_IN_WINDOW', 25),
    minUniqueMinters: optNumber('MIN_UNIQUE_MINTERS', 10),
    maxContractAgeSec: optNumber('MAX_CONTRACT_AGE_SEC', 900),
    freeOnly: optBool('AUTO_FREE_ONLY', true),
    trackUniqueMinters: optBool('TRACK_UNIQUE_MINTERS', true),
    maxContracts: optNumber('TRACKER_MAX_CONTRACTS', 5_000),
    evictAfterSec: optNumber('TRACKER_EVICT_AFTER_SEC', 3_600),
    extraSelectorsRaw: opt('EXTRA_MINT_SELECTORS'),
  };
}

function parseAddressSet(raw: string | undefined, name: string): Set<Address> {
  const out = new Set<Address>();
  if (!raw) return out;
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isAddress(entry)) {
      throw new ConfigError(`${name} contains an invalid address: ${entry}`);
    }
    out.add(entry.toLowerCase() as Address);
  }
  return out;
}

/**
 * Autopilot configuration.
 *
 * The budget fields are required rather than defaulted, because an autopilot
 * with an implicit spending limit is an autopilot whose limit nobody chose.
 */
export function loadAutopilotConfig(env: NodeJS.ProcessEnv = process.env): {
  freeOnly: boolean;
  totalBudgetWei: bigint;
  perCollectionBudgetWei: bigint;
  maxGasLimit: bigint;
  denylist: Set<Address>;
  allowlist: Set<Address>;
  maxCollectionsPerHour: number;
  txPerWallet: number;
  dryRun: boolean;
} {
  const { opt, optNumber, optBool } = createEnvReader(env);
  const totalBudget = opt('AUTO_TOTAL_BUDGET_ETH');
  if (totalBudget === undefined) {
    throw new ConfigError(
      'AUTO_TOTAL_BUDGET_ETH is required for autopilot. Set the maximum ETH this ' +
        'process may ever spend, e.g. AUTO_TOTAL_BUDGET_ETH=0.05',
    );
  }

  return {
    freeOnly: optBool('AUTO_FREE_ONLY', true),
    totalBudgetWei: parseEther(totalBudget),
    perCollectionBudgetWei: parseEther(opt('AUTO_PER_COLLECTION_BUDGET_ETH') ?? '0.01'),
    maxGasLimit: BigInt(opt('AUTO_MAX_GAS_LIMIT') ?? '400000'),
    denylist: parseAddressSet(opt('AUTO_DENYLIST'), 'AUTO_DENYLIST'),
    allowlist: parseAddressSet(opt('AUTO_ALLOWLIST'), 'AUTO_ALLOWLIST'),
    maxCollectionsPerHour: optNumber('AUTO_MAX_COLLECTIONS_PER_HOUR', 20),
    txPerWallet: optNumber('AUTO_TX_PER_WALLET', 1),
    dryRun: optBool('AUTO_DRY_RUN', false),
  };
}

/**
 * Everything auto-hunt needs to sign and broadcast — and nothing more.
 *
 * Hunting discovers its target from the feed and derives the call per
 * candidate, so it must NOT require CONTRACT_ADDRESS or MINT_FUNCTION. It
 * previously borrowed `loadConfig` and fed it placeholder values, which broke
 * the moment those variables existed but were blank: the placeholder used `??`,
 * which only substitutes for null/undefined, so an empty string sailed through
 * and was then rejected as missing.
 */
export interface HuntRuntime {
  network: NetworkName;
  chainId: number;
  rpcUrls: string[];
  submitOnlyUrls: string[];
  privateKeys: Hex[];
  gas: GasConfig;
}

export function loadHuntRuntime(env: NodeJS.ProcessEnv = process.env): HuntRuntime {
  const { opt, req, optNumber } = createEnvReader(env);
  const network = parseNetwork(opt('NETWORK') ?? 'testnet');

  const rpcUrls = (opt('RPC_URLS') ?? defaultRpcFor(network))
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  if (rpcUrls.length === 0) {
    throw new ConfigError('RPC_URLS contains no usable http(s) endpoint');
  }

  return {
    network,
    chainId: network === 'mainnet' ? 4663 : 46630,
    rpcUrls,
    submitOnlyUrls: (env.SEQUENCER_URLS !== undefined
      ? env.SEQUENCER_URLS
      : sequencerRpcFor(network)
    )
      .split(',')
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u)),
    privateKeys: parsePrivateKeys(req('PRIVATE_KEYS')),
    gas: {
      gasLimit: undefined,
      gasLimitMultiplier: optNumber('GAS_LIMIT_MULTIPLIER', 1.3),
      maxFeePerGas: gweiToWei(opt('MAX_FEE_GWEI') ?? '0.5'),
      maxPriorityFeePerGas: gweiToWei(opt('PRIORITY_FEE_GWEI') ?? '0'),
    },
  };
}

/**
 * Hunt configuration — the criteria that decide what gets bought automatically.
 *
 * Defaults are tuned for "a real drop that is minting out fast" rather than
 * "anything with transactions": see src/criteria.ts for what each signal rules
 * out.
 */
export function loadHuntConfig(env: NodeJS.ProcessEnv = process.env): {
  windowSec: number;
  inspectTop: number;
  maxMintsPerCycle: number;
  dryRun: boolean;
  criteria: {
    minMintsPerMinute: number;
    minUniqueMinters: number;
    minAttemptsInWindow: number;
    maxAgeSec: number;
    requireLive: boolean;
    maxSelloutSec: number;
    maxSupplyProgressPct: number;
    freeOnly: boolean;
    maxPriceWei: bigint;
    requireSaleOpen: boolean;
    skipIfOwned: boolean;
  };
} {
  const { optNumber, optBool, opt } = createEnvReader(env);

  return {
    // Leaves room inside a 60s function budget for inspection and minting.
    windowSec: optNumber('HUNT_WINDOW_SEC', 35),
    inspectTop: optNumber('HUNT_INSPECT_TOP', 6),
    maxMintsPerCycle: optNumber('HUNT_MAX_MINTS_PER_CYCLE', 2),
    // Live by default, so the bot actually mints once armed. Set
    // HUNT_DRY_RUN=true to force practice mode server-side; the browser then
    // cannot turn it live, which is the safe way to hand someone a deployment.
    dryRun: optBool('HUNT_DRY_RUN', false),
    criteria: {
      minMintsPerMinute: optNumber('HUNT_MIN_MINTS_PER_MIN', 30),
      minUniqueMinters: optNumber('HUNT_MIN_UNIQUE_MINTERS', 8),
      minAttemptsInWindow: optNumber('HUNT_MIN_ATTEMPTS_IN_WINDOW', 15),
      maxAgeSec: optNumber('HUNT_MAX_AGE_SEC', 300),
      requireLive: optBool('HUNT_REQUIRE_LIVE', true),
      maxSelloutSec: optNumber('HUNT_MAX_SELLOUT_SEC', 900),
      maxSupplyProgressPct: optNumber('HUNT_MAX_SUPPLY_PROGRESS_PCT', 90),
      freeOnly: optBool('HUNT_FREE_ONLY', true),
      maxPriceWei: parseEther(opt('HUNT_MAX_PRICE_ETH') ?? '0'),
      requireSaleOpen: optBool('HUNT_REQUIRE_SALE_OPEN', true),
      skipIfOwned: optBool('HUNT_SKIP_IF_OWNED', true),
    },
  };
}

/** Human-readable summary with all secrets omitted. */
export function describeConfig(cfg: BotConfig): Record<string, unknown> {
  return {
    network: cfg.network,
    chainId: cfg.chainId,
    rpcEndpoints: cfg.rpcUrls.length,
    wallets: cfg.privateKeys.length,
    contract: cfg.mint.contract,
    call: cfg.mint.rawCalldata ? 'raw calldata' : cfg.mint.functionSignature,
    valueWei: cfg.mint.value,
    trigger: cfg.trigger.mode,
    txPerWallet: cfg.txPerWallet,
    dryRun: cfg.dryRun,
  };
}
