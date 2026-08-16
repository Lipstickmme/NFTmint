import type { Address } from 'viem';
import { FeedConsumer, waitForFeedSignal, type FeedTx } from './feed.js';
import { readBooleanView } from './preflight.js';
import { log } from './logger.js';
import type { RpcClient } from './rpc.js';
import type { BotConfig } from './config.js';

/**
 * Triggers decide the single most consequential thing a mint bot does: when to
 * fire. Firing early wastes gas on a revert; firing late loses the race.
 *
 * Four strategies, roughly in order of how early they can detect a launch:
 *
 *   feed  — watch the sequencer feed for the team's own "enable sale"
 *           transaction. Earliest possible signal: it arrives before any node
 *           can serve you the resulting state.
 *   poll  — repeatedly read a view function until it flips. Simple and robust,
 *           but bounded by the poll interval plus a full RPC round trip.
 *   time  — fire at a wall-clock instant. Only as good as your clock, and the
 *           team's punctuality.
 *   now   — fire immediately, for a sale already open.
 */

export interface TriggerResult {
  reason: 'now' | 'time' | 'poll' | 'feed';
  /** Monotonic timestamp at which the trigger fired. */
  firedAt: number;
  detail?: Record<string, unknown>;
}

/**
 * Sleep until a deadline with sub-millisecond accuracy.
 *
 * `setTimeout` is only accurate to a few milliseconds and routinely overshoots
 * under load. For a timed drop that overshoot is pure lost position, so we
 * sleep coarsely until shortly before the target and then spin. The spin window
 * is kept small because it pins a core.
 */
export async function preciseSleepUntil(
  targetMs: number,
  spinWindowMs = 5,
): Promise<void> {
  const coarseDeadline = targetMs - spinWindowMs;
  let remaining = coarseDeadline - Date.now();
  while (remaining > 0) {
    // Cap each sleep so a long wait still re-checks the clock periodically and
    // stays responsive to drift or suspend/resume.
    await new Promise((r) => setTimeout(r, Math.min(remaining, 250)));
    remaining = coarseDeadline - Date.now();
  }
  while (Date.now() < targetMs) {
    // Busy-wait for the final stretch.
  }
}

async function triggerNow(): Promise<TriggerResult> {
  return { reason: 'now', firedAt: performance.now() };
}

async function triggerTime(config: BotConfig): Promise<TriggerResult> {
  const target = config.trigger.fireAtMs;
  if (target === undefined) throw new Error('time trigger requires FIRE_AT');

  // Fire slightly early to absorb flight time to the sequencer.
  const adjusted = target - config.trigger.leadMs;
  const waitMs = adjusted - Date.now();

  log.info('Waiting for scheduled fire time', {
    fireAt: new Date(target).toISOString(),
    leadMs: config.trigger.leadMs,
    waitSeconds: (waitMs / 1000).toFixed(1),
  });
  if (waitMs > 0) await preciseSleepUntil(adjusted);

  return {
    reason: 'time',
    firedAt: performance.now(),
    detail: { scheduled: new Date(target).toISOString(), lateByMs: Date.now() - adjusted },
  };
}

async function triggerPoll(
  client: RpcClient,
  config: BotConfig,
  signal: AbortSignal,
): Promise<TriggerResult> {
  const signature = config.trigger.readySignature;
  if (!signature) throw new Error('poll trigger requires READY_FUNCTION');

  log.info('Polling for sale to open', {
    view: signature,
    intervalMs: config.trigger.pollIntervalMs,
  });

  let polls = 0;
  while (!signal.aborted) {
    polls += 1;
    try {
      const ready = await readBooleanView(client, config.mint.contract, signature);
      if (ready) {
        return { reason: 'poll', firedAt: performance.now(), detail: { polls } };
      }
    } catch (err) {
      log.debug('poll read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await new Promise((r) => setTimeout(r, config.trigger.pollIntervalMs));
  }
  throw new Error('Polling aborted');
}

async function triggerFeed(
  consumer: FeedConsumer,
  config: BotConfig,
  signal: AbortSignal,
): Promise<TriggerResult> {
  const selector = config.trigger.feedSelector;
  if (!selector) throw new Error('feed trigger requires FEED_SELECTOR');

  log.info('Watching sequencer feed for launch signal', {
    contract: config.mint.contract,
    selector,
  });

  const tx: FeedTx = await waitForFeedSignal(
    consumer,
    config.mint.contract as Address,
    selector,
    signal,
  );

  return {
    reason: 'feed',
    firedAt: performance.now(),
    detail: { triggerTx: tx.hash, selector: tx.selector },
  };
}

export interface WaitForTriggerParams {
  config: BotConfig;
  client: RpcClient;
  feed?: FeedConsumer;
  signal: AbortSignal;
}

export async function waitForTrigger(
  params: WaitForTriggerParams,
): Promise<TriggerResult> {
  const { config, client, feed, signal } = params;

  switch (config.trigger.mode) {
    case 'now':
      return triggerNow();
    case 'time':
      return triggerTime(config);
    case 'poll':
      return triggerPoll(client, config, signal);
    case 'feed': {
      if (!feed) throw new Error('feed trigger requires a FeedConsumer');
      return triggerFeed(feed, config, signal);
    }
    default: {
      const exhaustive: never = config.trigger.mode;
      throw new Error(`Unhandled trigger mode: ${String(exhaustive)}`);
    }
  }
}
