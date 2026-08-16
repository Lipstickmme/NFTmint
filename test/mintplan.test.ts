import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { RpcClient } from '../src/rpc.js';
import { buildMintPlan } from '../src/mintplan.js';
import { selectorOf } from '../src/calldata.js';

/**
 * A mock NFT contract that accepts exactly one mint signature. The planner
 * must discover which one by simulation, the way it does against a real chain.
 */

const CONTRACT = '0x00000000000000000000000000000000000000aa' as Address;
const WALLET = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;

function word(v: bigint | number): string {
  return BigInt(v).toString(16).padStart(64, '0');
}
function encodeString(s: string): string {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return '0x' + word(32) + word(s.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
}

interface MockOpts {
  /** The only signature the contract accepts. */
  accepts?: string;
  totalSupply?: bigint;
  maxSupply?: bigint;
  priceWei?: bigint;
  saleOpen?: boolean;
  owned?: bigint;
  hasCode?: boolean;
  /** Revert reason returned for every mint attempt. */
  revertWith?: string;
}

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
  }
});

async function mockChain(opts: MockOpts = {}): Promise<string> {
  const acceptSelector = opts.accepts ? selectorOf(opts.accepts).toLowerCase() : undefined;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const { method, params, id } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ok = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      const revert = (message: string): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id,
          error: { code: 3, message: 'execution reverted', data: encodeError(message) },
        }));
      };

      if (method === 'eth_getCode') return ok(opts.hasCode === false ? '0x' : '0x60806040');
      if (method === 'eth_estimateGas') return ok('0x30d40');
      if (method !== 'eth_call') return ok('0x');

      const data = String(params[0]?.data ?? '').toLowerCase();
      const sel = data.slice(0, 10);

      // Read-only getters.
      if (sel === selectorOf('name()')) return ok(encodeString('Mock Cats'));
      if (sel === selectorOf('symbol()')) return ok(encodeString('MCAT'));
      if (sel === selectorOf('totalSupply()'))
        return opts.totalSupply === undefined ? ok('0x') : ok('0x' + word(opts.totalSupply));
      if (sel === selectorOf('maxSupply()'))
        return opts.maxSupply === undefined ? ok('0x') : ok('0x' + word(opts.maxSupply));
      if (sel === selectorOf('price()'))
        return opts.priceWei === undefined ? ok('0x') : ok('0x' + word(opts.priceWei));
      if (sel === selectorOf('saleIsActive()'))
        return opts.saleOpen === undefined ? ok('0x') : ok('0x' + word(opts.saleOpen ? 1 : 0));
      if (sel === selectorOf('balanceOf(address)'))
        return ok('0x' + word(opts.owned ?? 0n));

      // Mint attempts.
      if (opts.revertWith) return revert(opts.revertWith);
      if (acceptSelector && sel === acceptSelector) return ok('0x');
      return revert('unknown function');
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** abi.encodeWithSignature("Error(string)", reason) */
function encodeError(reason: string): Hex {
  const hex = Buffer.from(reason, 'utf8').toString('hex');
  return ('0x08c379a0' + word(32) + word(reason.length) +
    hex.padEnd(Math.ceil(hex.length / 64) * 64, '0')) as Hex;
}

async function plan(url: string, quantity = 1) {
  const client = new RpcClient(url, { timeoutMs: 5_000 });
  try {
    return await buildMintPlan(client, CONTRACT, WALLET, { quantity });
  } finally {
    client.destroy();
  }
}

describe('buildMintPlan', () => {
  it('discovers the mint function the contract actually accepts', async () => {
    const url = await mockChain({
      accepts: 'publicMint(uint256)',
      totalSupply: 100n, maxSupply: 1000n, priceWei: 0n, saleOpen: true,
    });
    const p = await plan(url);

    expect(p.ready).toBe(true);
    expect(p.chosen?.signature).toBe('publicMint(uint256)');
    expect(p.chosen?.calldata.slice(0, 10)).toBe(selectorOf('publicMint(uint256)'));
    expect(p.blockers).toHaveLength(0);
    expect(p.advice).toMatch(/Ready to mint/);
  });

  it('handles a mint that takes the recipient address', async () => {
    const url = await mockChain({ accepts: 'mint(address,uint256)', saleOpen: true, priceWei: 0n });
    const p = await plan(url);

    expect(p.chosen?.signature).toBe('mint(address,uint256)');
    // The recipient must be our wallet, not a placeholder.
    expect(p.chosen?.args[0]).toBe(WALLET);
    expect(p.chosen?.calldata.toLowerCase()).toContain(WALLET.slice(2).toLowerCase());
  });

  it('reads supply and reports what is left', async () => {
    const url = await mockChain({
      accepts: 'mint(uint256)', totalSupply: 800n, maxSupply: 1000n, saleOpen: true, priceWei: 0n,
    });
    const p = await plan(url);

    expect(p.info.remaining).toBe('200');
    expect(p.info.progressPct).toBeCloseTo(80, 1);
    expect(p.info.soldOut).toBe(false);
  });

  it('multiplies the price by the quantity', async () => {
    const url = await mockChain({
      accepts: 'mint(uint256)', priceWei: 10n ** 16n, saleOpen: true,
    });
    const p = await plan(url, 3);
    expect(p.chosen?.valueWei).toBe((10n ** 16n * 3n).toString());
  });

  it('estimates gas so the mint path never has to', async () => {
    const url = await mockChain({ accepts: 'mint(uint256)', saleOpen: true, priceWei: 0n });
    const p = await plan(url);
    // 0x30d40 = 200000, x1.3 = 260000
    expect(p.chosen?.gasLimit).toBe('260000');
  });

  it('blocks a sold-out collection', async () => {
    const url = await mockChain({
      accepts: 'mint(uint256)', totalSupply: 1000n, maxSupply: 1000n, saleOpen: true,
    });
    const p = await plan(url);

    expect(p.ready).toBe(false);
    expect(p.info.soldOut).toBe(true);
    expect(p.blockers.join(' ')).toMatch(/sold out/i);
    expect(p.advice).toMatch(/Nothing left/i);
  });

  it('blocks when the contract says its sale is closed', async () => {
    const url = await mockChain({ accepts: 'mint(uint256)', saleOpen: false, priceWei: 0n });
    const p = await plan(url);

    expect(p.ready).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/closed/i);
    expect(p.advice).toMatch(/not open yet/i);
  });

  it('surfaces the contract\'s own revert reason when nothing works', async () => {
    const url = await mockChain({ revertWith: 'Sale not started' });
    const p = await plan(url);

    expect(p.ready).toBe(false);
    expect(p.chosen).toBeUndefined();
    expect(p.blockers.join(' ')).toMatch(/Sale not started/);
  });

  it('reports a missing contract clearly', async () => {
    const url = await mockChain({ hasCode: false });
    const p = await plan(url);

    expect(p.ready).toBe(false);
    expect(p.blockers.join(' ')).toMatch(/no contract at this address/i);
    expect(p.tried).toHaveLength(0);
  });

  it('records every signature it tried, for diagnosis', async () => {
    const url = await mockChain({ accepts: 'claim(uint256)', saleOpen: true, priceWei: 0n });
    const p = await plan(url);

    expect(p.tried.length).toBeGreaterThan(1);
    expect(p.tried.filter((t) => t.outcome === 'ok')).toHaveLength(1);
    expect(p.tried.at(-1)?.signature).toBe('claim(uint256)');
  });

  it('advises the manual escape hatch when the ABI is unrecognisable', async () => {
    const url = await mockChain({ saleOpen: true, priceWei: 0n });
    const p = await plan(url);

    expect(p.ready).toBe(false);
    expect(p.advice).toMatch(/raw input data/i);
  });

  it('still works when supply and price are unreadable', async () => {
    const url = await mockChain({ accepts: 'mint(uint256)' });
    const p = await plan(url);

    expect(p.ready).toBe(true);
    expect(p.info.totalSupply).toBeUndefined();
    expect(p.chosen?.valueWei).toBe('0');
  });

  it('rejects an invalid address as a client fault', async () => {
    const url = await mockChain();
    const client = new RpcClient(url);
    try {
      await expect(
        buildMintPlan(client, 'not-an-address' as Address, WALLET),
      ).rejects.toMatchObject({ name: 'ConfigError' });
    } finally {
      client.destroy();
    }
  });
});
