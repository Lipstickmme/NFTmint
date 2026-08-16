# Building an NFT mint bot on Robinhood Chain — research findings

Research date: **August 2026**. Everything below drove a concrete design
decision in this repository; the last section lists what I could not verify.

---

## 1. What Robinhood Chain actually is

Robinhood Chain is an **Ethereum Layer 2 built on the Arbitrum Orbit / Nitro
stack**, created by Robinhood for tokenized real-world assets (equities,
stablecoins) and 24/7 financial services.

| Property | Mainnet | Testnet |
| --- | --- | --- |
| Chain ID | **4663** | **46630** |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Sequencer feed | `wss://feed.mainnet.chain.robinhood.com` | `wss://feed.testnet.chain.robinhood.com` |
| Explorer | `robinhoodchain.blockscout.com` | `testnet.robinhoodchain.blockscout.com` |
| Gas token | ETH | ETH |

Timeline: public testnet **10 Feb 2026**, public mainnet **1 July 2026**.
Block time is **~100ms** with sub-second soft confirmations.

Because it is Nitro-based, it is **EVM-equivalent** and speaks standard
Ethereum JSON-RPC. Ordinary Ethereum tooling — viem, ethers, Foundry, Hardhat —
works with no protocol-level changes. There is no bespoke SDK to learn.

**Design consequence:** the bot is a normal EVM bot. All the Robinhood-specific
work is in *how* it submits, not *what* it submits.

---

## 2. The finding that determines the entire architecture

> **Ordering is first-come-first-served, the mempool is private, and Timeboost
> is not enabled.**

Three separate facts, each with a hard consequence:

**a) FCFS ordering.** Arbitrum Nitro sequencers order transactions strictly by
arrival time at the sequencer. Robinhood Chain runs this pure FCFS model.

**b) No Timeboost.** Arbitrum's Timeboost adds a sealed-bid auction for an
"express lane" (~200ms head start) on chains that enable it. Robinhood Chain
**does not have Timeboost enabled** — there is no express lane and no bidding
to get ahead in the queue.

**c) Private mempool.** Pending transactions are not visible to third parties
before sequencing.

### What this means, concretely

This inverts the standard Ethereum L1 mint-bot playbook:

| Ethereum L1 tactic | Status on Robinhood Chain |
| --- | --- |
| Bid high priority fee to win the block | **Useless.** No priority auction exists. A tip buys nothing. |
| Watch the mempool, snipe/front-run | **Impossible.** Mempool is private. |
| Flashbots / private bundles | **Not applicable.** No competing block builders. |
| Gas-war escalation | **Pure waste.** Costs money, buys zero position. |
| **Minimize latency to the sequencer** | **This is the entire game.** |

A mint on this chain is won by whoever's bytes physically arrive first. So the
optimization target is not "how much am I willing to pay" but "how few
microseconds pass between the start signal and the socket write".

**Design consequences, all implemented:**

- `PRIORITY_FEE_GWEI` defaults to **0** (`src/config.ts`). A tip is money burned.
- `MAX_FEE_GWEI` is framed as a *solvency* bound against base-fee movement,
  not a race lever.
- Everything possible is hoisted out of the critical section (§3).
- No mempool-watching feature exists, because it cannot exist here.

---

## 3. Pre-signing: removing work from the critical path

Given that latency decides mints, every operation between "go" and "bytes on
the wire" is lost ground. Measured costs of things a naive bot does at fire time:

| Operation | Rough cost | Handled by |
| --- | --- | --- |
| `eth_estimateGas` round trip | 1 full RTT (10–100ms+) | Pre-computed in preflight |
| `eth_getTransactionCount` for nonce | 1 full RTT | Primed once, allocated locally |
| ECDSA signing | ~1ms of curve math | Done in advance |
| ABI encoding | sub-ms but nonzero | Done in advance |
| JSON serialization | sub-ms but nonzero | Body pre-serialized to a string |
| **TCP + TLS handshake** | **1–3 RTTs** | Sockets warmed and held open |

`src/presign.ts` reduces the critical section to writing an
already-built string to an already-open socket. The integration test's hot-path
trace shows trigger → first socket write in **~0.02ms**.

Additional transport-level choices in `src/rpc.ts`:

- **Keep-alive agent.** A cold TLS handshake at fire time can cost more than
  the whole mint window.
- **`setNoDelay(true)`.** Nagle's algorithm buffers small payloads waiting to
  coalesce. A lone transaction is exactly the pathological case.
- **Multi-endpoint racing.** The same signed transaction goes to every
  configured RPC simultaneously. Safe because the nonce is fixed: duplicates are
  rejected as "already known", never executed twice. It hedges against one
  provider being slow or rate limited.

---

## 4. The sequencer feed — the earliest possible trigger

Nitro sequencers broadcast their ordering decisions on a WebSocket relay
**before downstream RPC nodes have re-executed the block**. Anything serving
you a receipt must do that re-execution first, so reading the feed is
structurally ahead of polling.

This makes the feed the best available *trigger*: when a team flips their sale
live, their `setSaleActive` transaction appears on the feed before `eth_call`
against a normal node would report the new state.

**Wire format** (implemented and unit-tested in `src/feed.ts`):

```
JSON frame  { version, messages: [ { sequenceNumber, message.message.l2Msg } ] }
l2Msg       base64
  └─ byte 0 = L2 message kind
       3 = Batch    → 8-byte big-endian length-prefixed submessages (nests)
       4 = SignedTx → remainder is an RLP-encoded signed Ethereum transaction
```

`test/feed.test.ts` builds these frames byte for byte and asserts the decoder
recovers the original transactions, including nested batches, truncated length
prefixes, and lying length fields.

**Caveat:** feed messages are **soft confirmations**. The sequencer has
committed to an order, but nothing has settled on Ethereum and a reorg is still
possible. Sound basis for "start the race"; not for "funds are final".

---

## 5. Gas on Arbitrum Nitro

An Arbitrum transaction's gas has two components: L2 execution, and the cost of
posting calldata to Ethereum. Plain `eth_estimateGas` folds them into one
opaque number.

The **NodeInterface precompile** at `0x00000000000000000000000000000000000000C8`
splits them via `gasEstimateComponents(to, contractCreation, data)`, returning
`(gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate)`. This is a virtual
precompile — no code exists at that address; the node intercepts the call.

This matters because the L1 component moves with Ethereum's base fee and is the
part most likely to shift between preflight and the actual mint. Implemented in
`src/preflight.ts`, with `eth_estimateGas` as a fallback for nodes that do not
expose NodeInterface.

**The pre-launch gas problem.** A mint call simulated *before* the sale opens
reverts — which is the normal state for a bot waiting on a drop. A reverting
call cannot be estimated. Rather than silently guessing a limit (risking
out-of-gas on every transaction at the worst moment), the bot refuses to
proceed and tells the operator to set `GAS_LIMIT` explicitly. This is the
single most likely thing to trip up a first run, so the error message spells
out both the benign and the broken interpretation.

---

## 6. Deployment and compliance posture

- **Contract deployment is permissionless.** No allowlist, partnership, or
  Robinhood account is needed to deploy or interact. An NFT mint bot is a
  legitimate use of the chain.
- **No developer KYC** for deploying contracts.
- **The sequencer screens sanctioned addresses**, and compliance rules are
  applied at the network level for regulated assets. For *stock tokens*
  specifically, transfers are permissionless for addresses not blocked in a
  shared `AccessControlsRegistry` — there is no general on-chain KYC allowlist.

**Consequence:** nothing blocks an ordinary ERC-721 mint. But this is a chain
built by a regulated broker around regulated assets, so read a project's terms
before pointing automation at it.

---

## 7. RPC providers — the thing most likely to cost you a mint

> The public endpoint is rate limited (reported as low as **2 requests/second
> per IP**) and is explicitly **not intended for latency-sensitive or
> production use**.

For a competitive mint the public RPC is disqualifying. **Alchemy is
Robinhood's recommended provider**; QuickNode, dRPC, Chainstack, Blockdaemon,
GetBlock, and Dwellir also support the chain.

Since latency is the only lever, provider choice and geographic placement are
the highest-leverage decisions available — worth more than any code change.
Hence `npm run latency`, which measures and ranks endpoints, and the bot's
automatic sorting so the fastest endpoint is written to first.

---

## 8. What I could not verify

Stated plainly, because acting on unverified assumptions is how bots lose money:

1. **No live-chain testing.** This build environment's network policy blocks
   `*.chain.robinhood.com` (403 at the egress proxy), so no code path here has
   touched the real chain. All logic is verified against unit tests, synthetic
   Nitro frames, and a mock node — real behaviour is unconfirmed. **Run on
   testnet first.**
2. **`docs.robinhood.com` was unreachable** from this environment. Chain IDs,
   RPC URLs, and feed URLs come from multiple corroborating third-party
   sources (Arbitrum forum/blog, L2BEAT, QuickNode, Chainstack, NodeFlare,
   Dwellir), not the primary docs. **Verify them against the official docs
   before mainnet use** — `npm run cli networks` prints what the bot will use,
   and preflight hard-fails on a chain-ID mismatch.
3. **Exact feed frame schema.** The decoder follows the documented Nitro relay
   format and is tested against synthetic frames, but not against live traffic.
   `npm run feed` is the first thing to run to confirm it.
4. **Whether the feed requires auth or a local relay.** Chainstack's reference
   implementation fans out through a local relay on `ws://127.0.0.1:9642`.
   Direct connection may work or may need the relay; `FEED_URL` is
   configurable for exactly this reason.
5. **Current base fee and realistic gas costs** — unmeasurable without chain
   access.

---

## Sources

- [Robinhood Chain mainnet is live, built with the Arbitrum Platform](https://blog.arbitrum.io/robinhood-chain-mainnet/)
- [ArbitrumDAO Factsheet: Robinhood Chain Mainnet Launch](https://forum.arbitrum.foundation/t/arbitrumdao-factsheet-robinhood-chain-mainnet-launch/31041)
- [Robinhood Chain public testnet launch](https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet)
- [Connecting to Robinhood Chain — official docs](https://docs.robinhood.com/chain/connecting)
- [Gas & Fees — official docs](https://docs.robinhood.com/chain/gas-and-fees/)
- [Robinhood Chain — L2BEAT](https://l2beat.com/scaling/projects/robinhood)
- [What is Robinhood Chain? A full builder's guide (2026) — Chainstack](https://chainstack.com/what-is-robinhood-chain/)
- [What is Robinhood Chain? A Developer's Guide — QuickNode](https://www.quicknode.com/guides/robinhood/what-is-robinhood-chain)
- [Robinhood Chain RPC & Chain ID 4663 — NodeFlare](https://nodeflare.app/chains/robinhood)
- [eth_chainId | Robinhood Chain RPC Docs — Dwellir](https://www.dwellir.com/docs/robinhood/eth_chainId)
- [Robinhood Chain: Protocol-Level Compliance — Blockdaemon](https://www.blockdaemon.com/blog/robinhood-chain-protocol-level-compliance-for-financial-institutions)
- [Robinhood Chain L2 for stock tokens — thirdweb](https://blog.thirdweb.com/robinhood-chain-inside-the-ethereum-l2-bringing-tokenized-stocks-to-120-countries/)
- [chainstacklabs/robinhood-chain-sequencer-feed](https://github.com/chainstacklabs/robinhood-chain-sequencer-feed)
- [How Timeboost works — Arbitrum Docs](https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction)
- [Timeboost for Arbitrum chains — Arbitrum Docs](https://docs.arbitrum.io/launch-arbitrum-chain/configure-your-chain/common/mev/timeboost-for-arbitrum-chains)
- [Debunking Common Misconceptions About Timeboost — Ed Felten](https://medium.com/offchainlabs/debunking-common-misconceptions-about-timeboost-92d937568494)
- [How to estimate gas in Arbitrum — Arbitrum Docs](https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas)
- [Gas and fees deep dive — Arbitrum Docs](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees)
- [L1 gas pricing — Arbitrum Docs](https://docs.arbitrum.io/how-arbitrum-works/l1-gas-pricing)
