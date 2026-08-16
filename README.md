# NFTmint — an NFT mint bot for Robinhood Chain

A mint bot for **Robinhood Chain** (Arbitrum Orbit L2 · chain ID **4663**
mainnet / **46630** testnet), built around the one property that decides mints
on this chain: **ordering is first-come-first-served, so latency wins — not gas.**

Full research and sourcing: **[docs/RESEARCH.md](docs/RESEARCH.md)**.

---

## Why this bot is shaped the way it is

Robinhood Chain runs an Arbitrum Nitro sequencer with a **private mempool**,
**first-come-first-served ordering**, and **no Timeboost express lane**. That
invalidates most of the standard Ethereum mint-bot playbook:

| L1 tactic | Here |
| --- | --- |
| Outbid rivals on priority fee | **Useless** — no priority auction exists |
| Snipe the mempool | **Impossible** — mempool is private |
| Flashbots bundles | **Not applicable** — no competing builders |
| **Get bytes to the sequencer first** | **The entire game** |

So the bot spends a long, unhurried preparation phase doing everything in
advance, and keeps the critical section down to a socket write:

- **Pre-signed transactions** — ABI encoding, nonce assignment, gas limits, and
  ECDSA signing all happen before the trigger.
- **Pre-serialized RPC bodies** — no JSON encoding mid-race.
- **Warm keep-alive sockets, Nagle disabled** — no TLS handshake at fire time.
- **Zero RPC round trips in the critical path** — no live gas estimation, no
  nonce lookup.
- **Multi-endpoint racing** — the same signed transaction goes to every RPC at
  once; the fixed nonce makes duplicates harmless.
- **Priority fee defaults to 0** — a tip buys no position here.

Measured in the integration test, trigger → first socket write is **~0.02ms**.

---

## Install

```bash
git clone https://github.com/Lipstickmme/NFTmint.git
cd NFTmint
npm install
cp .env.example .env      # then edit .env
```

Requires Node.js 20+.

## Commands

```bash
npm run networks     # show built-in network parameters
npm run latency      # measure RTT to each RPC endpoint  ← run this first
npm run preflight    # validate config, simulate the mint, report gas — sends nothing
npm run feed         # stream the sequencer feed
npm run selector -- "setSaleActive(bool)"   # compute a 4-byte selector
npm run run:bot      # full run: preflight → pre-sign → wait for trigger → broadcast
npm test             # 90 tests
```

---

## Configuration

Everything lives in `.env` (gitignored). See `.env.example` for all options.
The essentials:

```bash
NETWORK=testnet
RPC_URLS=https://your-dedicated-endpoint     # NOT the public RPC — see below
PRIVATE_KEYS=0xkey1,0xkey2                   # burner wallets only
CONTRACT_ADDRESS=0x...

MINT_FUNCTION=mint(uint256)
MINT_ARGS=1
MINT_PRICE_ETH=0.01
MINT_QUANTITY=1

MAX_FEE_GWEI=0.5
PRIORITY_FEE_GWEI=0        # leave at 0 — a tip buys nothing on FCFS
TRIGGER_MODE=now
```

### Specifying the mint call

**Option A — raw calldata (most reliable).** Copy the input data from a
successful mint transaction on the explorer:

```bash
MINT_CALLDATA=0xa0712d68...
```

This sidesteps every ambiguity about overloads, argument order, and
non-standard ABIs. It's what experienced minters use.

**Option B — function signature.** Use `$SENDER` where the minting wallet's own
address belongs:

```bash
MINT_FUNCTION=mint(address,uint256)
MINT_ARGS=$SENDER,1
```

Array arguments (merkle proofs) use JSON:

```bash
MINT_FUNCTION=whitelistMint(uint256,bytes32[])
MINT_ARGS=["1","[\"0xproof1...\",\"0xproof2...\"]"]
```

### Choosing a trigger

| Mode | Fires when | Use it when |
| --- | --- | --- |
| `now` | Immediately | Sale is already open |
| `time` | At `FIRE_AT` | Team announced a timestamp |
| `poll` | `READY_FUNCTION` returns true | Contract exposes a sale-state view |
| `feed` | Sequencer feed shows `FEED_SELECTOR` sent to the contract | **Earliest possible signal** |

`feed` is the strongest option: the sequencer broadcasts its ordering decision
before any RPC node can serve you the resulting state, so you see the team's
"open the sale" transaction before a poller would.

```bash
TRIGGER_MODE=feed
FEED_SELECTOR=0x841718a6      # npm run selector -- "setSaleActive(bool)"
```

For `time` mode, set `LEAD_MS` to roughly your measured RTT so the transaction
*arrives* on time rather than *departing* on time.

---

## Recommended first run

```bash
# 1. Confirm the network parameters the bot will use
npm run networks

# 2. Measure your endpoints. On a FCFS chain this number is your competitiveness.
npm run latency

# 3. Confirm the feed decodes against live traffic
npm run feed

# 4. Validate config and simulate — sends nothing, spends nothing
npm run preflight

# 5. Pre-sign everything but stop before broadcast
DRY_RUN=true npm run run:bot

# 6. Real run, on testnet
npm run run:bot
```

Only move to `NETWORK=mainnet` after a full testnet run has succeeded.

---

## The error you are most likely to hit

```
Cannot determine a gas limit because the mint call reverts right now
(Sale not active).
```

This is **expected** when the sale hasn't opened — a reverting call can't be
gas-estimated. The bot refuses to guess, because a wrong guess means every
transaction runs out of gas at the worst possible moment. Fix:

```bash
GAS_LIMIT=250000            # copy gas used from a comparable mint on the explorer
REQUIRE_SIMULATION=false    # only while deliberately waiting for a closed sale
```

If the sale *is* open and you still see this, the call itself is
misconfigured — check `MINT_FUNCTION` / `MINT_ARGS` / `MINT_PRICE_ETH` against
the contract.

---

## Safety

- `.env`, `*.key`, `wallets.json` are gitignored. Private keys are never logged,
  even partially.
- **Use burner wallets** funded with only what the mint needs.
- Preflight hard-fails on a chain-ID mismatch, a missing contract, or an
  underfunded wallet — before anything is broadcast.
- `DRY_RUN=true` exercises the entire pipeline including signing, then stops.
- `TX_PER_WALLET` transactions occupy consecutive nonces on one wallet, so they
  execute *in order* — that stacks mints, it does not parallelize them. Real
  parallelism comes from **more wallets**, each with an independent nonce.

---

## Project layout

```
src/
  chain.ts       Network definitions, feed URLs, NodeInterface precompile
  config.ts      Env parsing and validation (frozen before the hot path)
  rpc.ts         Latency-tuned JSON-RPC: keep-alive, no-delay, endpoint racing
  calldata.ts    Raw calldata / signature encoding, $SENDER expansion
  wallet.ts      Key loading, local nonce allocation, balance checks
  preflight.ts   Chain checks, simulation, NodeInterface gas estimation
  presign.ts     Builds + signs + pre-serializes the transaction set
  submit.ts      Broadcast, error classification, receipt polling
  feed.ts        Sequencer feed consumer and Nitro message decoder
  triggers.ts    now / time / poll / feed, with sub-ms scheduled firing
  bot.ts         Orchestration
  cli.ts         Command-line entry point
test/            90 tests, incl. an end-to-end run against a mock node
docs/RESEARCH.md Research findings, design rationale, and sources
```

---

## Status and limits

Verified offline: 90 tests pass and typecheck is clean, covering signature
recovery, transaction field encoding, nonce allocation across wallets, Nitro
feed decoding against synthetic frames (including malformed and adversarial
input), the full submit path against a real local HTTP server, and an
end-to-end bot run against a mock node.

**Not verified against the live chain.** The build environment's network policy
blocks `*.chain.robinhood.com`, so no code path here has touched Robinhood
Chain. Network parameters come from corroborating third-party sources rather
than the primary docs, which were unreachable. Confirm them and run on testnet
before risking mainnet funds — see [docs/RESEARCH.md §8](docs/RESEARCH.md) for
the full list of unverified assumptions.

## License

MIT
