import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Address } from 'viem';
import { inspectContract, ERC721_INTERFACE, ERC1155_INTERFACE } from '../src/inspect.js';
import { RpcClient } from '../src/rpc.js';
import { selectorOf } from '../src/calldata.js';

/**
 * Asking a contract what it is.
 *
 * This became the safety gate when mint detection stopped requiring a
 * hardcoded selector. On the sequencer feed a busy swap router and a hot drop
 * look identical — same velocity, same crowd of distinct senders — and the only
 * thing that separates them is the contract's own answer. A live Swap Router
 * reached "1 passed" before these existed.
 */

const CONTRACT = '0x00000000000000000000000000000000000000aa' as Address;

function word(v: bigint): string {
  return v.toString(16).padStart(64, '0');
}

interface Shape {
  /** Selector → hex answer. Anything absent reverts, as a real contract does. */
  answers: Record<string, string>;
  /** ERC-165 replies, keyed by interface id. Absent means no ERC-165 at all. */
  interfaces?: Record<string, boolean>;
}

let servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => {
    s.closeAllConnections?.();
    s.close(() => r());
  })));
  servers = [];
});

async function nodeFor(shape: Shape): Promise<RpcClient> {
  const supports = selectorOf('supportsInterface(bytes4)');
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { method, params, id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const send = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(body as object) }));
      };

      if (method === 'eth_getCode') return send({ result: '0x6080604052' });
      if (method !== 'eth_call') return send({ result: '0x' });

      const data = String(params[0]?.data ?? '');
      const selector = data.slice(0, 10);

      if (selector === supports) {
        if (!shape.interfaces) {
          // No ERC-165: a real contract reverts rather than returning nothing.
          return send({ error: { code: 3, message: 'execution reverted' } });
        }
        const asked = `0x${data.slice(10, 18)}`;
        return send({ result: '0x' + word(shape.interfaces[asked] ? 1n : 0n) });
      }

      const answer = shape.answers[selector];
      if (answer === undefined) {
        return send({ error: { code: 3, message: 'execution reverted' } });
      }
      return send({ result: answer });
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return new RpcClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

const NAME = { [selectorOf('name()')]: encodeString('Solar Cats') };
const SUPPLY = { [selectorOf('totalSupply()')]: '0x' + word(300n) };
const MAX = { [selectorOf('maxSupply()')]: '0x' + word(1000n) };
const TOKEN_URI = { [selectorOf('tokenURI(uint256)')]: encodeString('ipfs://x') };
const DECIMALS = { [selectorOf('decimals()')]: '0x' + word(18n) };

function encodeString(text: string): string {
  const hex = Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0');
  return '0x' + word(32n) + word(BigInt(text.length)) + hex;
}

describe('inspectContract — is this an NFT?', () => {
  it('accepts a contract that says ERC-721', async () => {
    const client = await nodeFor({
      answers: { ...NAME, ...SUPPLY, ...MAX },
      interfaces: { [ERC721_INTERFACE]: true, [ERC1155_INTERFACE]: false },
    });
    const info = await inspectContract(client, CONTRACT);
    expect(info.isNft).toBe(true);
    client.destroy();
  });

  it('accepts a contract that says ERC-1155', async () => {
    const client = await nodeFor({
      answers: { ...NAME },
      interfaces: { [ERC721_INTERFACE]: false, [ERC1155_INTERFACE]: true },
    });
    expect((await inspectContract(client, CONTRACT)).isNft).toBe(true);
    client.destroy();
  });

  it('rejects a contract that says it is neither', async () => {
    // A swap router that happens to implement ERC-165.
    const client = await nodeFor({
      answers: {},
      interfaces: { [ERC721_INTERFACE]: false, [ERC1155_INTERFACE]: false },
    });
    const info = await inspectContract(client, CONTRACT);
    expect(info.isNft).toBe(false);
    expect(info.summary).toMatch(/NOT an NFT/);
    client.destroy();
  });

  it('rejects a fungible token even though it has a name and a supply', async () => {
    // The case the shape test alone waves through: every ERC-20 has both.
    // `decimals()` is the tell.
    const client = await nodeFor({ answers: { ...NAME, ...SUPPLY, ...DECIMALS } });
    const info = await inspectContract(client, CONTRACT);
    expect(info.isNft).toBe(false);
    expect(info.looksLikeNft).toBe(false);
    client.destroy();
  });

  it('accepts an older collection with no ERC-165 but a token URI', async () => {
    // Plenty of real ERC-721s predate ERC-165, so silence cannot be fatal —
    // and a per-token URI is something only an NFT has.
    const client = await nodeFor({ answers: { ...NAME, ...TOKEN_URI } });
    const info = await inspectContract(client, CONTRACT);
    expect(info.isNft).toBeUndefined();
    expect(info.looksLikeNft).toBe(true);
    client.destroy();
  });

  it('accepts a name plus a supply as the weaker fallback', async () => {
    const client = await nodeFor({ answers: { ...NAME, ...SUPPLY, ...MAX } });
    expect((await inspectContract(client, CONTRACT)).looksLikeNft).toBe(true);
    client.destroy();
  });

  it('rejects a contract that answers nothing at all', async () => {
    // A router: no ERC-165, no name, no supply, no token URI.
    const client = await nodeFor({ answers: {} });
    const info = await inspectContract(client, CONTRACT);
    expect(info.isNft).toBeUndefined();
    expect(info.looksLikeNft).toBe(false);
    expect(info.summary).toMatch(/does not look like an NFT/);
    client.destroy();
  });

  it('reports a missing contract rather than guessing', async () => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const { id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);

    const client = new RpcClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const info = await inspectContract(client, CONTRACT);
    expect(info.hasCode).toBe(false);
    expect(info.looksLikeNft).toBe(false);
    client.destroy();
  });
});
