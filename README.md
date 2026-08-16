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
npm run track        # rank live collections by mint velocity — sends nothing
npm run serve        # tracker + HTTP dashboard/API (holds no keys)
npm run auto         # autopilot: mass-mint hot free mints across all wallets
npm run run:bot      # full run: preflight → pre-sign → wait for trigger → broadcast
npm run dev          # web UI + API locally (same handlers Vercel deploys)
npm run selector -- "setSaleActive(bool)"   # compute a 4-byte selector
npm test             # 168 tests
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

---

## Mint tracker — finding what's sought after

`npm run track` watches the sequencer feed, groups mint attempts by contract,
and ranks collections by how hard they're being minted **right now**:

```
contract                                    in-win  total  unique  free  age(s)
0x9a3f...c21b                                  184    412      147   yes    22.4
0x41de...8f02                                   97    103       61   yes     9.1
0x0b77...4ae9                                   31    588       12    no   611.0
```

Two numbers, meaning different things:

- **in-win** — attempts inside the velocity window (default 15s). Raw demand.
- **unique** — *distinct minting addresses*. This is the honest signal. 200
  attempts from 3 addresses is one bot spamming; 200 from 150 addresses is a
  real drop. The tracker requires both thresholds before calling something hot.

```bash
VELOCITY_WINDOW_SEC=15      # "mints in the first N seconds"
MIN_MINTS_IN_WINDOW=25      # attempts needed inside that window
MIN_UNIQUE_MINTERS=10       # distinct minters needed — the anti-bot check
MAX_CONTRACT_AGE_SEC=900    # only fresh drops
```

Because the feed carries transactions rather than receipts, this measures
*attempted* mints — which is both earlier than receipts and the better demand
signal: people racing for a mint tells you it's wanted whether or not they win.

---

## Autopilot — mass-minting free mints

`npm run auto` runs the tracker, and when a collection crosses the velocity
thresholds, mints it across **every wallet at once**.

It learns the mint call from the feed: it takes calldata that a real minter
demonstrably used, so there's no guessing at ABIs or quantities.

> **One correctness detail worth knowing about.** If the mint function takes a
> recipient (`mint(address,uint256)`), replaying observed calldata verbatim
> would mint the NFT **to the wallet it was copied from** — while still costing
> you full gas and returning a successful receipt. The bot decodes the observed
> arguments and rewrites any address to the sending wallet. If it can't decode
> a selector, it refuses rather than guessing.

### Safety rails

This mode sends transactions to contracts nobody has vetted, with no human in
the loop. Be clear-eyed: **a "free" mint still costs gas, and a hostile
contract can burn the full gas limit on every wallet you own.** Burner wallets
only.

```bash
AUTO_FREE_ONLY=true                 # only mint when observed mints attach no ETH
AUTO_TOTAL_BUDGET_ETH=0.05          # REQUIRED — hard lifetime spend ceiling
AUTO_PER_COLLECTION_BUDGET_ETH=0.01 # worst-case cap per collection
AUTO_MAX_GAS_LIMIT=400000           # refuse collections that want more
AUTO_MAX_COLLECTIONS_PER_HOUR=20
AUTO_DENYLIST=0x...                 # never touch
AUTO_ALLOWLIST=0x...                # if set, the only ones allowed
AUTO_DRY_RUN=true                   # decide everything, broadcast nothing
```

`AUTO_TOTAL_BUDGET_ETH` has no default on purpose — an unchosen spending limit
isn't a limit. Every collection is also simulated before broadcast, so the bot
won't spend gas reverting across ten wallets at once.

---

## Multiple wallets — beating per-wallet mint limits

This is the point of multi-wallet support, and it already works the way you'd
want: **when a collection allows one mint per wallet, 10 wallets get you 10.**

```bash
PRIVATE_KEYS=0xk1,0xk2,0xk3,0xk4,0xk5,0xk6,0xk7,0xk8,0xk9,0xk10
TX_PER_WALLET=1        # or AUTO_TX_PER_WALLET=1 for autopilot
```

Each wallet has an **independent nonce sequence**, so all ten transactions fly
concurrently rather than queueing behind each other. Each also mints to its own
address — `$SENDER` expands per wallet, and autopilot rewrites the recipient
per wallet — so a per-address cap sees ten distinct minters.

The distinction that matters:

| Setting | Effect |
| --- | --- |
| 10 wallets × `TX_PER_WALLET=1` | **10 mints, fully parallel** — beats a 1-per-wallet limit |
| 1 wallet × `TX_PER_WALLET=10` | 10 mints on consecutive nonces, executed **in order** — stacks mints on a collection with no per-wallet cap |

Fund every wallet before running: preflight aborts if any wallet can't cover
value plus worst-case gas, rather than discovering it mid-race.

---

## Web UI on Vercel

The bot runs on Vercel with a browser UI — mint, preflight, scan the feed, and
check wallet balances, no terminal needed.

Full setup with exact settings: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

```bash
npm run dev      # same handlers Vercel deploys, at http://127.0.0.1:3000
vercel --prod    # deploy
```

Four required environment variables:

```bash
API_TOKEN=<64-char random>    # Sensitive — the mint API refuses to run without it
PRIVATE_KEYS=0xk1,0xk2,...    # Sensitive — burner wallets only
NETWORK=testnet
RPC_URLS=https://your-dedicated-endpoint
```

| Route | Does |
| --- | --- |
| `GET /api/health` | Public. What's configured, without leaking values |
| `GET /api/status` | Chain reachability, endpoint latency, wallet balances |
| `GET /api/inspect` | Read a collection: supply left, price, sale open, already owned |
| `POST /api/preflight` | Simulate + gas estimate. Sends nothing |
| `POST /api/mint` | Pre-sign and broadcast now |
| `GET /api/scan` | Sample the feed, rank by mint velocity |
| `GET /api/hunt` | One full cycle: watch → judge → mint what qualifies |

### Auto-hunt: what counts as a good mint

`/api/hunt` watches the chain, then applies six checks. A collection must pass
**all** of them, and the UI shows each one's pass/fail with the numbers — so it
is never a black box.

| Check | Rules out |
| --- | --- |
| **Mint rate** ≥ 30/min | Something barely moving |
| **Unique minters** ≥ 8 | One bot in a loop. 300 mints from 4 wallets is not demand |
| **Burst size** ≥ 15 in window | A trickle rather than a rush |
| **Freshness** ≤ 5 min old | Joining the tail after the good supply is gone |
| **Still minting** (live) | A drop that already finished — the counts are history |
| **Sellout runway** ≤ 15 min | **The real test.** Remaining supply ÷ current rate. Fast minting against unlimited supply is not scarcity |
| **Supply left** ≤ 90% gone | Paying gas to lose a race that's already over |

Plus: free-only by default, sale-open honoured when the contract exposes it,
and **skip if already owned** — checked on chain, which is what makes a
repeating hunt safe to loop without a database.

Tune every threshold via `HUNT_*` environment variables. `HUNT_MIN_UNIQUE_MINTERS`
is the highest-value dial for filtering out junk.

**Start in practice mode** (`HUNT_DRY_RUN=true`, the default). It watches,
judges, and signs, but never broadcasts — so you can see what it *would* have
bought before it spends anything.

### What serverless can and can't do here

Being straight about the limits, since they're structural:

- **Works well** — targeted mints, scheduled mints via Vercel Cron, preflight,
  balances, on-demand velocity scans.
- **Sampled, not continuous** — `/api/scan` samples a window per request. A
  function can't hold the sequencer-feed WebSocket open between requests.
- **Not available** — the always-on tracker and autopilot need that persistent
  feed. Run `npm run serve` / `npm run auto` on any persistent host and set
  `TRACKER_UPSTREAM_URL`; the UI picks it up.
- **Degraded for contested drops** — cold starts cost 100ms–1s, and on FCFS
  ordering that decides races. A warm process near the sequencer wins those.

### Security

`PRIVATE_KEYS` on Vercel means every deployment can sign with your wallets.
Mitigations built in, and worth understanding:

- `API_TOKEN` is **required** — endpoints return 503 rather than defaulting to
  open, and the token is compared in constant time.
- `MAX_MINT_VALUE_ETH` caps what any single run can commit (default 0.05).
- Request bodies may only override an **allowlisted** set of mint fields. They
  cannot touch `PRIVATE_KEYS`, `RPC_URLS`, or the spend ceiling — there's a
  test asserting that.
- Preview deployments inherit env vars; restrict to Production if that matters.

Use burner wallets.

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
  mintdetect.ts  Mint-selector registry and free/paid classification
  tracker.ts     Per-contract velocity, unique minters, hot detection
  autopilot.ts   Mass-mint orchestration with budget and safety rails
  server.ts      Tracker HTTP API + self-contained dashboard
  service.ts     Service layer behind the web API (status/preflight/mint/scan)
  http.ts        Auth, JSON safety, and the shared route wrapper
  proxy.ts       Upstream proxy for an optional persistent tracker
  devserver.ts   Local host for the Vercel handlers
  bot.ts         Orchestration
  cli.ts         Command-line entry point
api/             Vercel serverless routes
public/index.html  The web UI
test/            168 tests, incl. end-to-end runs against a mock node
docs/RESEARCH.md   Research findings, design rationale, and sources
docs/DEPLOYMENT.md Vercel + persistent host setup
```

---

## Status and limits

Verified offline: 168 tests pass and typecheck is clean, covering signature
recovery, transaction field encoding, nonce allocation across wallets, Nitro
feed decoding against synthetic frames (including malformed and adversarial
input), tracker velocity and anti-bot thresholds, autopilot recipient
rewriting, API authentication (including fail-closed behaviour and override
injection attempts), the dashboard API over real HTTP, the full submit path
against a real local HTTP server, and end-to-end runs of both the bot and the
Vercel route handlers against a mock node.

**Not verified against the live chain.** The build environment's network policy
blocks `*.chain.robinhood.com`, so no code path here has touched Robinhood
Chain. Network parameters come from corroborating third-party sources rather
than the primary docs, which were unreachable. Confirm them and run on testnet
before risking mainnet funds — see [docs/RESEARCH.md §8](docs/RESEARCH.md) for
the full list of unverified assumptions.

## License

MIT
