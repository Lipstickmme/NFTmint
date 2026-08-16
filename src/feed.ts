import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { keccak256, parseTransaction, type Address, type Hex } from 'viem';
import { log } from './logger.js';

/**
 * Sequencer feed consumer.
 *
 * The Nitro sequencer publishes its ordering decisions on a WebSocket relay
 * before downstream RPC nodes have re-executed the resulting block. Anything
 * serving you a receipt has to do that re-execution first, so reading the feed
 * directly is structurally ahead of polling — not by a tunable amount, but by
 * however long execution and propagation take.
 *
 * That makes the feed the best available trigger source: when a team flips
 * their sale live, the feed carries that transaction before `eth_call` against
 * a normal node would report the new state.
 *
 * Feed messages are SOFT confirmations. The sequencer has committed to an
 * order, but nothing is settled on Ethereum yet and a reorg remains possible.
 * That is an acceptable basis for "start the race", not for "consider funds
 * final".
 *
 * ── Wire format ────────────────────────────────────────────────────────────
 * Each frame is JSON: { version, messages: [{ sequenceNumber, message, ... }] }
 * where `message.message.l2Msg` is base64. The decoded bytes begin with a
 * one-byte L2 message kind:
 *   3 = Batch      -> a sequence of 8-byte big-endian length-prefixed submessages
 *   4 = SignedTx   -> the remainder is an RLP-encoded signed Ethereum transaction
 * Batches nest, so decoding recurses.
 */

/** Arbitrum L2 message kinds relevant to transaction extraction. */
const L2_MESSAGE_KIND_BATCH = 3;
const L2_MESSAGE_KIND_SIGNED_TX = 4;

export interface FeedTx {
  hash: Hex;
  to?: Address;
  from?: Address;
  /** 4-byte function selector, lowercased, when calldata is present. */
  selector?: Hex;
  value: bigint;
  data: Hex;
  /**
   * The RLP-encoded signed transaction as it appeared on the feed.
   *
   * Retained so the sender can be recovered later if needed. Recovery is ECDSA
   * work and far too slow to do while decoding a busy feed, so consumers that
   * want a `from` address do it on their own schedule.
   */
  raw: Hex;
}

export interface FeedMessage {
  sequenceNumber: number;
  txs: FeedTx[];
  /** Monotonic receive time, for latency accounting. */
  receivedAt: number;
}

/** Decode one L2 message payload into signed transactions. */
export function decodeL2Message(payload: Uint8Array, depth = 0): FeedTx[] {
  if (payload.length === 0 || depth > 4) return [];

  const kind = payload[0];
  const body = payload.subarray(1);

  if (kind === L2_MESSAGE_KIND_SIGNED_TX) {
    const tx = decodeSignedTx(body);
    return tx ? [tx] : [];
  }

  if (kind === L2_MESSAGE_KIND_BATCH) {
    const out: FeedTx[] = [];
    let offset = 0;
    while (offset + 8 <= body.length) {
      const view = new DataView(body.buffer, body.byteOffset + offset, 8);
      const length = Number(view.getBigUint64(0, false));
      offset += 8;
      if (length < 0 || offset + length > body.length) break;
      out.push(...decodeL2Message(body.subarray(offset, offset + length), depth + 1));
      offset += length;
    }
    return out;
  }

  // Other kinds (unsigned user txs, contract txs) are not mint-relevant.
  return [];
}

function decodeSignedTx(rlp: Uint8Array): FeedTx | undefined {
  if (rlp.length === 0) return undefined;
  const hex = `0x${Buffer.from(rlp).toString('hex')}` as Hex;
  try {
    const parsed = parseTransaction(hex);
    const data = (parsed.data ?? '0x') as Hex;
    return {
      hash: keccak256(hex),
      to: parsed.to ?? undefined,
      value: parsed.value ?? 0n,
      data,
      selector: data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : undefined,
      raw: hex,
    };
  } catch {
    // Malformed or an unsupported transaction type; skip rather than throw, so
    // one bad entry cannot stall the consumer.
    return undefined;
  }
}

interface RawFeedFrame {
  version?: number;
  messages?: Array<{
    sequenceNumber?: number;
    message?: {
      message?: {
        l2Msg?: string;
      };
    };
  }>;
}

export function parseFeedFrame(raw: string): FeedMessage[] {
  let frame: RawFeedFrame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(frame.messages)) return [];

  const receivedAt = performance.now();
  const out: FeedMessage[] = [];
  for (const entry of frame.messages) {
    const b64 = entry?.message?.message?.l2Msg;
    if (typeof b64 !== 'string' || b64.length === 0) continue;
    let payload: Buffer;
    try {
      payload = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    out.push({
      sequenceNumber: entry.sequenceNumber ?? -1,
      txs: decodeL2Message(new Uint8Array(payload)),
      receivedAt,
    });
  }
  return out;
}

export interface FeedConsumerOptions {
  url: string;
  /** Reconnect backoff bounds, in milliseconds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  headers?: Record<string, string>;
}

/**
 * Resilient feed consumer.
 *
 * Emits `message` (FeedMessage), `tx` (FeedTx), `open`, `close`, and `error`.
 * Reconnects with exponential backoff, because a dropped feed during a drop
 * window is exactly when reconnection matters most.
 */
export class FeedConsumer extends EventEmitter {
  private ws?: WebSocket;
  private closed = false;
  private backoff: number;
  private readonly opts: Required<Omit<FeedConsumerOptions, 'headers'>> & {
    headers?: Record<string, string>;
  };

  constructor(options: FeedConsumerOptions) {
    super();
    this.opts = {
      url: options.url,
      minBackoffMs: options.minBackoffMs ?? 250,
      maxBackoffMs: options.maxBackoffMs ?? 10_000,
      headers: options.headers,
    };
    this.backoff = this.opts.minBackoffMs;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    const ws = new WebSocket(this.opts.url, {
      headers: {
        // Nitro relays gate on a client-version header in some deployments.
        'Arbitrum-Feed-Client-Version': '2',
        ...this.opts.headers,
      },
      perMessageDeflate: false, // decompression would add latency
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = this.opts.minBackoffMs;
      log.info('Sequencer feed connected', { url: this.opts.url });
      this.emit('open');
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      for (const msg of parseFeedFrame(text)) {
        this.emit('message', msg);
        for (const tx of msg.txs) this.emit('tx', tx, msg);
      }
    });

    ws.on('error', (err: Error) => {
      log.warn('Sequencer feed error', { error: err.message });
      // A bare `emit('error')` with no registered listener makes EventEmitter
      // throw, which would take the whole bot down on a transient feed blip —
      // exactly when we most need it to stay up and reconnect. Feed errors are
      // already logged and handled by the reconnect path, so surface them only
      // to callers who asked.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    ws.on('close', () => {
      this.emit('close');
      if (this.closed) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
      log.warn('Sequencer feed disconnected, reconnecting', { delayMs: delay });
      setTimeout(() => this.connect(), delay).unref?.();
    });
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = undefined;
  }
}

/**
 * Resolve as soon as the feed shows a transaction to `contract` carrying
 * `selector` — typically the team's own `setSaleActive`-style call.
 */
export function waitForFeedSignal(
  consumer: FeedConsumer,
  contract: Address,
  selector: Hex,
  signal?: AbortSignal,
): Promise<FeedTx> {
  const wantedTo = contract.toLowerCase();
  const wantedSelector = selector.toLowerCase();

  return new Promise((resolve, reject) => {
    const onTx = (tx: FeedTx): void => {
      if (tx.to?.toLowerCase() !== wantedTo) return;
      if (tx.selector !== wantedSelector) return;
      cleanup();
      resolve(tx);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('Feed wait aborted'));
    };
    const cleanup = (): void => {
      consumer.off('tx', onTx);
      signal?.removeEventListener('abort', onAbort);
    };

    consumer.on('tx', onTx);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
