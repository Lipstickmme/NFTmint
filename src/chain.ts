import { defineChain } from 'viem';

/**
 * Robinhood Chain network definitions.
 *
 * Robinhood Chain is an Ethereum L2 built on the Arbitrum Orbit (Nitro) stack.
 * It is fully EVM-equivalent and speaks standard Ethereum JSON-RPC, so ordinary
 * Ethereum tooling works unchanged. Gas is paid in ETH.
 *
 * The properties that matter for a mint bot:
 *   - ~100ms block times with sub-second soft confirmations.
 *   - A single sequencer with a PRIVATE mempool. Pending transactions are not
 *     observable by third parties.
 *   - First-come-first-served (FCFS) ordering. Timeboost / the "express lane"
 *     is NOT enabled on Robinhood Chain, so there is no way to bid for priority.
 *     Arrival time at the sequencer is the only thing that determines order.
 *
 * See docs/RESEARCH.md for the sourcing behind each of these claims.
 */

const NATIVE_CURRENCY = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const;

export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: NATIVE_CURRENCY,
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
    },
  },
});

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: NATIVE_CURRENCY,
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://testnet.robinhoodchain.blockscout.com',
    },
  },
  testnet: true,
});

/**
 * Sequencer feed endpoints. The feed is the Nitro relay broadcast: the
 * sequencer orders a transaction, then announces that decision here BEFORE
 * downstream RPC nodes have re-executed the block and can serve a receipt.
 * Reading it is the lowest-latency way to observe chain activity.
 *
 * Feed messages are soft confirmations, not settled state.
 */
export const SEQUENCER_FEEDS = {
  mainnet: 'wss://feed.mainnet.chain.robinhood.com',
  testnet: 'wss://feed.testnet.chain.robinhood.com',
} as const;

export type NetworkName = 'mainnet' | 'testnet';

export function chainFor(network: NetworkName) {
  return network === 'mainnet' ? robinhoodMainnet : robinhoodTestnet;
}

export function feedFor(network: NetworkName): string {
  return SEQUENCER_FEEDS[network];
}

export function defaultRpcFor(network: NetworkName): string {
  return chainFor(network).rpcUrls.default.http[0];
}

export function explorerTxUrl(network: NetworkName, hash: string): string {
  const base = chainFor(network).blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : hash;
}

/**
 * Arbitrum Nitro NodeInterface. This is a virtual precompile: it does not
 * exist on chain, but the node intercepts calls to this address and answers
 * them. `gasEstimateComponents` splits a gas estimate into the L2 execution
 * portion and the portion attributable to posting calldata to the parent
 * chain, which plain `eth_estimateGas` folds together opaquely.
 */
export const NODE_INTERFACE_ADDRESS =
  '0x00000000000000000000000000000000000000C8' as const;

export const NODE_INTERFACE_ABI = [
  {
    name: 'gasEstimateComponents',
    stateMutability: 'nonpayable',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'contractCreation', type: 'bool' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [
      { name: 'gasEstimate', type: 'uint64' },
      { name: 'gasEstimateForL1', type: 'uint64' },
      { name: 'baseFee', type: 'uint256' },
      { name: 'l1BaseFeeEstimate', type: 'uint256' },
    ],
  },
] as const;
