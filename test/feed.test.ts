import { describe, it, expect } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeL2Message, parseFeedFrame } from '../src/feed.js';

/**
 * These tests build synthetic Nitro relay frames byte for byte, then assert the
 * decoder recovers the original transactions. That exercises the exact framing
 * the live feed uses: a kind byte, 8-byte big-endian length prefixes, base64
 * transport, and RLP transaction bodies.
 */

const TEST_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const account = privateKeyToAccount(TEST_KEY);

const L2_KIND_BATCH = 3;
const L2_KIND_SIGNED_TX = 4;

async function signSample(overrides: Record<string, unknown> = {}): Promise<Hex> {
  return account.signTransaction({
    to: '0x00000000000000000000000000000000000000aa',
    value: 1n,
    data: '0xa0712d680000000000000000000000000000000000000000000000000000000000000001',
    nonce: 0,
    gas: 250_000n,
    maxFeePerGas: 500_000_000n,
    maxPriorityFeePerGas: 0n,
    chainId: 46630,
    type: 'eip1559',
    ...overrides,
  } as never);
}

function wrapSignedTx(serialized: Hex): Uint8Array {
  const raw = Buffer.from(serialized.slice(2), 'hex');
  return new Uint8Array(Buffer.concat([Buffer.from([L2_KIND_SIGNED_TX]), raw]));
}

function wrapBatch(messages: Uint8Array[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from([L2_KIND_BATCH])];
  for (const msg of messages) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(msg.length));
    parts.push(len, Buffer.from(msg));
  }
  return new Uint8Array(Buffer.concat(parts));
}

function makeFrame(payloads: Uint8Array[], startSeq = 1000): string {
  return JSON.stringify({
    version: 1,
    messages: payloads.map((payload, i) => ({
      sequenceNumber: startSeq + i,
      message: {
        message: {
          header: { kind: 3 },
          l2Msg: Buffer.from(payload).toString('base64'),
        },
        delayedMessagesRead: 0,
      },
    })),
  });
}

describe('decodeL2Message', () => {
  it('decodes a bare signed transaction', async () => {
    const serialized = await signSample();
    const txs = decodeL2Message(wrapSignedTx(serialized));

    expect(txs).toHaveLength(1);
    expect(txs[0].hash).toBe(keccak256(serialized));
    expect(txs[0].to?.toLowerCase()).toBe('0x00000000000000000000000000000000000000aa');
    expect(txs[0].selector).toBe('0xa0712d68');
    expect(txs[0].value).toBe(1n);
  });

  it('decodes a batch of several transactions in order', async () => {
    const a = await signSample({ nonce: 0 });
    const b = await signSample({ nonce: 1 });
    const c = await signSample({ nonce: 2 });

    const txs = decodeL2Message(
      wrapBatch([wrapSignedTx(a), wrapSignedTx(b), wrapSignedTx(c)]),
    );

    expect(txs.map((t) => t.hash)).toEqual([keccak256(a), keccak256(b), keccak256(c)]);
  });

  it('handles nested batches', async () => {
    const a = await signSample({ nonce: 0 });
    const b = await signSample({ nonce: 1 });
    const inner = wrapBatch([wrapSignedTx(b)]);

    const txs = decodeL2Message(wrapBatch([wrapSignedTx(a), inner]));
    expect(txs.map((t) => t.hash)).toEqual([keccak256(a), keccak256(b)]);
  });

  it('ignores message kinds that cannot contain a user mint', () => {
    // Kind 0 is an unsigned user transaction.
    expect(decodeL2Message(new Uint8Array([0, 1, 2, 3]))).toEqual([]);
  });

  it('returns nothing for an empty payload', () => {
    expect(decodeL2Message(new Uint8Array([]))).toEqual([]);
  });

  it('skips a corrupt entry instead of throwing', () => {
    const garbage = new Uint8Array([L2_KIND_SIGNED_TX, 0xff, 0xff, 0xff]);
    expect(() => decodeL2Message(garbage)).not.toThrow();
    expect(decodeL2Message(garbage)).toEqual([]);
  });

  it('stops cleanly on a truncated length prefix rather than over-reading', () => {
    const truncated = new Uint8Array([L2_KIND_BATCH, 0, 0, 0]);
    expect(decodeL2Message(truncated)).toEqual([]);
  });

  it('stops when a declared length exceeds the remaining buffer', async () => {
    const serialized = await signSample();
    const raw = Buffer.from(serialized.slice(2), 'hex');
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(raw.length * 10)); // lies about the length
    const payload = new Uint8Array(
      Buffer.concat([Buffer.from([L2_KIND_BATCH]), len, raw]),
    );
    expect(decodeL2Message(payload)).toEqual([]);
  });

  it('bounds recursion on maliciously deep nesting', () => {
    let payload = wrapBatch([]);
    for (let i = 0; i < 20; i++) payload = wrapBatch([payload]);
    expect(() => decodeL2Message(payload)).not.toThrow();
  });
});

describe('FeedConsumer resilience', () => {
  it('does not crash the process when the feed errors with no error listener', async () => {
    // Regression: EventEmitter throws on an unhandled 'error' event, so a bare
    // emit here took down the whole bot on any transient feed failure — a 403,
    // a dropped connection, a DNS blip. The consumer must survive and reconnect.
    const { FeedConsumer } = await import('../src/feed.js');
    const consumer = new FeedConsumer({
      url: 'ws://127.0.0.1:1', // nothing listening: connection refused
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });

    expect(() => consumer.start()).not.toThrow();
    // Long enough for several failed connects and reconnect attempts.
    await new Promise((r) => setTimeout(r, 250));
    consumer.stop();
  });

  it('delivers errors to a listener when one is registered', async () => {
    const { FeedConsumer } = await import('../src/feed.js');
    const consumer = new FeedConsumer({
      url: 'ws://127.0.0.1:1',
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });

    const errors: Error[] = [];
    consumer.on('error', (err: Error) => errors.push(err));
    consumer.start();
    await new Promise((r) => setTimeout(r, 250));
    consumer.stop();

    expect(errors.length).toBeGreaterThan(0);
  });

  it('stops reconnecting once stopped', async () => {
    const { FeedConsumer } = await import('../src/feed.js');
    const consumer = new FeedConsumer({
      url: 'ws://127.0.0.1:1',
      minBackoffMs: 20,
      maxBackoffMs: 40,
    });

    let closes = 0;
    consumer.on('close', () => closes += 1);
    consumer.start();
    await new Promise((r) => setTimeout(r, 120));
    consumer.stop();

    const afterStop = closes;
    await new Promise((r) => setTimeout(r, 200));
    // At most the one close from stop() itself; no new connection attempts.
    expect(closes - afterStop).toBeLessThanOrEqual(1);
  });
});

describe('parseFeedFrame', () => {
  it('parses a relay frame into messages with sequence numbers', async () => {
    const serialized = await signSample();
    const frame = makeFrame([wrapSignedTx(serialized)], 20555512);

    const messages = parseFeedFrame(frame);
    expect(messages).toHaveLength(1);
    expect(messages[0].sequenceNumber).toBe(20555512);
    expect(messages[0].txs).toHaveLength(1);
    expect(messages[0].txs[0].hash).toBe(keccak256(serialized));
    expect(typeof messages[0].receivedAt).toBe('number');
  });

  it('parses several messages in a single frame', async () => {
    const a = await signSample({ nonce: 0 });
    const b = await signSample({ nonce: 1 });
    const messages = parseFeedFrame(makeFrame([wrapSignedTx(a), wrapSignedTx(b)]));

    expect(messages).toHaveLength(2);
    expect(messages[0].txs[0].hash).toBe(keccak256(a));
    expect(messages[1].txs[0].hash).toBe(keccak256(b));
  });

  it('returns nothing for non-JSON input rather than throwing', () => {
    expect(parseFeedFrame('not json at all')).toEqual([]);
  });

  it('tolerates a frame with no messages array', () => {
    expect(parseFeedFrame(JSON.stringify({ version: 1 }))).toEqual([]);
  });

  it('skips entries missing an l2Msg payload', () => {
    const frame = JSON.stringify({
      version: 1,
      messages: [{ sequenceNumber: 1, message: { message: {} } }],
    });
    expect(parseFeedFrame(frame)).toEqual([]);
  });
});
