import { privateKeyToAccount } from 'viem/accounts';
import { formatEther, type Address, type Hex } from 'viem';
import type { RpcClient } from './rpc.js';

/**
 * Wallet loading and nonce accounting.
 *
 * Nonces are resolved ONCE during preparation and then allocated locally.
 * Asking the node for a nonce at fire time would add a round trip to the
 * critical path, and worse, concurrent sends would race to read the same value
 * and collide. Local allocation makes the assignment deterministic.
 */

export interface Wallet {
  index: number;
  address: Address;
  privateKey: Hex;
  account: ReturnType<typeof privateKeyToAccount>;
}

export function loadWallets(privateKeys: Hex[]): Wallet[] {
  return privateKeys.map((privateKey, index) => {
    const account = privateKeyToAccount(privateKey);
    return { index, address: account.address, privateKey, account };
  });
}

/**
 * Tracks the next unused nonce per wallet.
 *
 * Seeded from the node's `pending` count, which includes transactions the
 * sequencer has accepted but not yet mined — the correct baseline when a
 * wallet may already have work in flight.
 */
export class NonceManager {
  private readonly next = new Map<Address, number>();

  /** Fetch the current pending nonce for each wallet, in parallel. */
  async prime(client: RpcClient, wallets: Wallet[]): Promise<void> {
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        const hex = await client.call<Hex>('eth_getTransactionCount', [
          wallet.address,
          'pending',
        ]);
        return [wallet.address, Number(BigInt(hex))] as const;
      }),
    );
    for (const [address, nonce] of results) {
      this.next.set(address, nonce);
    }
  }

  /** Seed a nonce directly, bypassing the network. Used in tests. */
  seed(address: Address, nonce: number): void {
    this.next.set(address, nonce);
  }

  peek(address: Address): number {
    const value = this.next.get(address);
    if (value === undefined) {
      throw new Error(`Nonce for ${address} was never primed`);
    }
    return value;
  }

  /** Reserve the next nonce for this wallet and advance the counter. */
  allocate(address: Address): number {
    const value = this.peek(address);
    this.next.set(address, value + 1);
    return value;
  }

  /** Reserve `count` consecutive nonces. */
  allocateRange(address: Address, count: number): number[] {
    return Array.from({ length: count }, () => this.allocate(address));
  }

  /**
   * Roll the counter back after a transaction is abandoned before broadcast.
   * Only sound for the most recently allocated nonce; a gap in the middle of
   * an in-flight batch cannot be reclaimed this way, because every later
   * transaction is already signed against its own fixed nonce.
   */
  release(address: Address): void {
    const value = this.peek(address);
    if (value > 0) this.next.set(address, value - 1);
  }
}

export interface WalletBalance {
  wallet: Wallet;
  balanceWei: bigint;
  /** Worst-case spend for this wallet's share of the run. */
  requiredWei: bigint;
  sufficient: boolean;
}

/**
 * Check that each wallet can cover value plus worst-case gas for every
 * transaction it is assigned. Underfunded wallets fail at broadcast, which on
 * a FCFS chain means losing the race outright — better to catch it here.
 */
export async function checkBalances(
  client: RpcClient,
  wallets: Wallet[],
  perTxValueWei: bigint,
  gasLimit: bigint,
  maxFeePerGas: bigint,
  txPerWallet: number,
): Promise<WalletBalance[]> {
  const perTxCost = perTxValueWei + gasLimit * maxFeePerGas;
  const requiredWei = perTxCost * BigInt(txPerWallet);

  return Promise.all(
    wallets.map(async (wallet) => {
      const hex = await client.call<Hex>('eth_getBalance', [wallet.address, 'latest']);
      const balanceWei = BigInt(hex);
      return {
        wallet,
        balanceWei,
        requiredWei,
        sufficient: balanceWei >= requiredWei,
      };
    }),
  );
}

export function formatBalanceReport(balances: WalletBalance[]): string {
  return balances
    .map((b) => {
      const mark = b.sufficient ? 'ok  ' : 'LOW ';
      return `  ${mark} ${b.wallet.address}  balance=${formatEther(b.balanceWei)} ETH  needs=${formatEther(b.requiredWei)} ETH`;
    })
    .join('\n');
}
