import 'dotenv/config';
import { isAddress, isHex, parseEther, type Address, type Hex } from 'viem';
import { defaultRpcFor, feedFor, type NetworkName } from './chain.js';

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

function req(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(`Missing required environment variable ${name}`);
  }
  return raw.trim();
}

function opt(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.trim();
}

function optNumber(name: string, fallback: number): number {
  const raw = opt(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

function optBool(name: string, fallback: boolean): boolean {
  const raw = opt(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean, got "${raw}"`);
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

export function loadConfig(): BotConfig {
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
export function loadTrackerConfig(): {
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
export function loadAutopilotConfig(): {
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
