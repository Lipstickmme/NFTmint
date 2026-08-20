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
| `GET /api/plan` | **Paste anything → how to mint it.** Resolves the address, reads the contract, finds the working mint function |
| `GET /api/inspect` | Read a collection: supply left, price, sale open, already owned |
| `POST /api/preflight` | Simulate + gas estimate. Sends nothing |
| `POST /api/mint` | Pre-sign and broadcast now |
| `GET /api/scan` | Sample the feed, rank by mint velocity |
| `GET /api/hunt` | One full cycle: watch → judge → mint what qualifies |
| `GET /api/findings` | Everything the hunter kept — passers and the ones that came close. `DELETE` clears it |
| `POST /api/account` | Sign up: ten generated wallets and an access key |
| `GET /api/account` | Your addresses and balances. `?reveal=1` returns the private keys |
| `PATCH /api/account` | Set your own RPC, or pause auto-mint |
| `GET /api/live` | Everything minting right now, with supply, price and round |
| `POST /api/mintnow` | Mint one collection from the board, in one press |
| `GET /api/origin` | Which endpoint your mints leave through, and how far away it is |

### You don't need to know the ABI

Paste a contract address — or any link containing one — and `/api/plan` works
the rest out by asking the chain:

- **Price, supply left, sale state** from the contract's own getters, probed
  across the names NFT contracts actually use.
- **Which mint function works**, by simulating each common entrypoint and
  keeping whichever the contract accepts. A successful simulation is real
  evidence: that call would execute, at that price, from your wallet, now.
- **Gas**, estimated up front so the mint path never has to.

If a contract is too unusual to detect, the UI opens an advanced panel where
you can paste raw calldata from a successful mint on the explorer.

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

### Defaults, and changing them

The defaults are chosen to catch fast-selling free mints, and **work without
configuring anything** — press Start hunting and it runs. The UI's
**Adjust the rules** panel edits every threshold live, explains what each one
rules out, and shows which you have changed away from the default.

One deliberate split: the browser can change **what the bot looks for**, never
**how much it can lose**. `MAX_MINT_VALUE_ETH`, `HUNT_MAX_PRICE_ETH`, and
`HUNT_MAX_MINTS_PER_CYCLE` are server-side only and ignore anything the page
sends. Turning off free-only in the UI does not grant a budget — paid mints
still need a price ceiling set in the environment.

**Auto-hunt buys for real by default.** The UI has a practice/live switch
(practice signs everything but never broadcasts). To force practice mode
server-side so the browser cannot turn it live — useful when handing someone a
deployment — set `HUNT_DRY_RUN=true`.

### How auto-mint decides what to send

Two things used to make this fail, and both are gone.

**It only looked for two dozen hardcoded function names.** A collection whose
entrypoint was `mintTo(address,uint256)` — or any of the hundreds of shapes in
the wild — was never tracked at all, so it could not be scored, let alone
bought. Detection is now structural: any contract call is watched, obvious
non-mints (transfers, approvals, swaps) are dropped outright, and an
unrecognised entrypoint has to be called repeatedly before it costs anything.
Recognised selectors still take the fast path.

**It refused anything it could not decode.** Now it copies. Somebody just minted
this collection successfully, seconds ago, on this chain — their transaction is
the specification. Three candidates are produced from it:

1. **address swap** — find the minter's own address inside their calldata and
   put yours in its place. No ABI, no signature, no decode; it works on
   entrypoints nobody has ever seen.
2. **ABI re-encode** — for selectors we recognise, decode properly and
   substitute the address arguments.
3. **verbatim** — replay byte for byte, which is correct whenever there is no
   recipient encoded at all.

Then the chain decides. Each candidate is simulated with `eth_call` from your
own wallet and the first that succeeds is the one broadcast. Nothing is sent on
a guess, and a wrong guess costs a round trip rather than a transaction.

The trap this is all built around: replaying an observed `mint(address,uint256)`
verbatim mints the NFT **to the wallet you copied from** — a silent, total
failure that still costs full gas and returns a successful receipt.

One consequence of widening detection needed closing, and the first version
did not close it far enough — a live **Swap Router** reached "1 passed" and was
sent a mint. Two holes: a failed contract read left `info` undefined, which
skipped every contract check including the NFT one; and the fallback test
(a name plus a supply) describes every ERC-20 as well as every collection.

Now: on the feed, a busy router with three hundred
distinct callers looks exactly like a hot drop — same shape, same velocity,
same crowd — so the contract has to answer for itself before anything is sent.

| The contract says | Verdict |
| --- | --- |
| ERC-165: yes, ERC-721 or ERC-1155 | pass |
| ERC-165: neither | **blocked** |
| has `decimals()` | **blocked** — fungible token, not a collection |
| no ERC-165, but has `tokenURI`/`uri` | pass |
| no ERC-165, but has a name and a supply | pass |
| nothing readable at all | **blocked** |

Blocked is blocking: score zero, no partial credit, never in the "close" list.
Nothing you loosen makes a swap router mintable. And a contract that cannot be
read is blocked rather than waved through, because everything left is
feed-derived and the feed cannot tell a collection from any other busy address.

### Accounts: ten wallets, generated for you

Sign up and the server generates ten wallets, seals their keys, and mints from
all of them at once. Per-wallet mint limits are the norm, so ten funded wallets
is ten tokens where one wallet gets one.

**Understand the trade before turning this on.** To mint while you are away, the
server must hold keys that can spend. That makes the deployment *custodial*:
whoever controls the host and `ACCOUNT_ENCRYPTION_KEY` can move anything those
wallets hold. The design keeps the blast radius small rather than pretending it
is zero —

- keys are sealed with AES-256-GCM under a value that lives only in the
  environment, so a database dump alone opens nothing;
- the account's access key is stored as a hash, so the same dump cannot be
  replayed against the API;
- keys are never in the response the page fetches on load — revealing them is a
  separate, explicit request;
- an account's own RPC is checked against private and loopback ranges before the
  server will call it.

**Fund them with gas money and nothing else.** They are burners.

The access key is shown once at sign-up and cannot be recovered or reset —
losing it loses the account.

### Match score: how close is close?

Every collection gets a score out of 100 rather than a pass/fail, because
counting failed rules throws away the thing that matters. "Needed 30 mints a
minute and saw 29" and "saw 2" both fail one rule; only one of them means your
threshold is a shade too tight.

Each rule gets partial credit for how near the actual value came, weighted by
how much it tells you — unique minters and sellout runway carry the most. A
collection that clears everything is 100 by construction, and the second list
shows everything at **70 or better that still did not qualify**, weakest rule
named first so the dial to loosen leads.

Rules with no threshold behind them — sold out, sale closed, already held —
score **zero** instead of partial credit. No adjustment makes an owned
collection buyable, so it is not "close" to anything and never clutters the
list.

### One RPC, or your own

There is a deployment-wide endpoint from `RPC_URLS`, and that is what everyone
uses by default. An account can set its own, which is then **tried first** with
the shared one kept as a fallback — it layers, it does not replace.

Worth doing, because ordering here is first-come-first-served: the endpoint you
submit through is the whole race, and an endpoint everyone shares is an endpoint
nobody wins from. The Route screen measures both so the difference is a number
rather than a hunch.

Operators running on `PRIVATE_KEYS` change endpoints by redeploying; the
per-account override is for signed-up users.

### The live board: what is minting right now

A different question from the hunter's, and it needed its own screen. The hunter
asks "should I buy this", applies seven rules, and mostly answers **no** — right
for spending money unattended, useless as a view of the chain.

The board asks only "is this a real drop, and is it happening", then shows
everything known about it:

- **supply as a bar**, not two numbers to subtract in your head
- **price**, from the contract rather than an average of what the feed saw
- **which round is running** — a public round and an allowlist round are the
  difference between minting and burning gas on a certain revert
- **max per wallet**, speed, distinct wallets, and how long until it is gone
- **what is happening, in words**: `Minting out — about 34s left`,
  `60 wallets in 2m`, `Gone in 90s`

Only the urgent line animates and only a bar that is still filling sweeps —
if everything moved, nothing would read as urgent. All of it respects
`prefers-reduced-motion`.

One filter, and it is the only one that matters here: **mints since the drop
started**. Below that threshold a contract is not a drop, it is somebody testing
their own deployment. Sold-out collections stay on the board, because "it went
in ninety seconds" is information after the fact.

**Mint any row in one press.** The board already found, for every collection it
shows, a transaction that mints it successfully — pressing Mint replays it
through exactly the same path the automatic hunter uses. No second
implementation, so no second place for the recipient-rewriting bug to come back.
The hunt criteria are deliberately *not* applied: a person pressing a button on
a specific row has already made that decision. The spending ceiling still is,
because that is not a preference.

### Free mints take the whole allowance

A copied transaction asks for whatever quantity that particular person wanted,
usually one. The contract's `maxPerWallet` is read, and where a quantity can be
located in the calldata it is raised to the cap — five tokens for one gas fee
instead of one. The original quantity is still tried afterwards, because a
contract can cap per transaction more tightly than per wallet.

**Free mints only**, deliberately. On a paid drop this would multiply the ETH
sent, and the price ceiling that was checked against a single mint would no
longer describe what is being spent. Raising a quantity there is a spending
decision, not an optimisation.

Finding the quantity without an ABI is deliberately strict: every word after the
selector must be a small integer and exactly one may be non-trivial. A payload
carrying an address, a token id, or a merkle proof fails that test and is left
alone — a wrong guess would corrupt the call.

### Where your mints leave from

Ordering on this chain is first-come-first-served with no priority auction, so
the only lever is how long your bytes take to reach the sequencer. The Route
screen names the provider and region behind every endpoint in play, measures
each one, and says which your mints will actually leave through.

Being exact about the limit: **it cannot show where other minters are.** A
transaction on the feed carries a signature and calldata and nothing about the
machine that produced it, so a map of rival minters would be invented. What is
measurable is your own route, and on FCFS ordering that is the half that decides
races anyway.

### What the ones that got away were worth

A skip is a decision, and without a price attached there is no way to tell a
good one from a costly one. Set `MARKET_API_URL` to a marketplace endpoint and
past free mints carry their floor, plus what ten wallets would have held.

With no source configured every floor reads as unknown. That is deliberate: a
hardcoded marketplace URL that has not been verified against this chain would
produce numbers that get acted on.

### The history: what it found, and what it nearly bought

A hunt report only describes the round that produced it. Rounds land roughly
every 40 seconds, so without somewhere to put them, a collection found ten
minutes ago is gone — and a page reload lost even the current one.

`/api/findings` keeps two things:

- **Passers** — everything that cleared all seven checks, with what became of
  the buy: confirmed mints and their transaction links, or the exact reason
  nothing was sent (per-wallet limit hit, sale closed between scan and attempt,
  no wallet holds gas).
- **Near misses** — anything that failed only one or two checks, with those
  checks named. This is the tuning signal: "loosen *this* number and it would
  have bought" beats guessing at thresholds.

Records are keyed by contract, so a collection seen across twenty rounds is one
row with a round count, not twenty duplicates — and it never loses the fact
that it once passed or was once bought.

Storage is picked from the environment, with no code change between them:

| When | Where | Survives |
| --- | --- | --- |
| Vercel KV / Upstash attached | Redis over REST | restarts, redeploys, every instance |
| `DATA_DIR` set | a directory of JSON files | restarts on that host |
| neither | process memory | nothing — and the panel says so |

On Vercel the memory fallback means the list appears to reset at random, since
instances are recycled and each has its own copy. Attaching a KV database from
the Storage tab injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`, and the bot
switches over on the next deploy. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#storage).

Every write is fail-soft: a round that cannot reach the store logs a warning
and carries on minting. Losing a log line is cheaper than losing the mint.

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
  hunt.ts        One cycle: watch the feed, judge, buy what qualifies
  criteria.ts    The rules, and the 0-100 score for how close a collection came
  findings.ts    The record of a found collection, and how repeats fold together
  kv.ts          One namespaced store: Vercel KV, a directory of files, or memory
  store.ts       The findings history on top of it
  accounts.ts    Wallet generation, sealing, and the RPC allowlist
  accountstore.ts Where accounts live, and how they authenticate
  live.ts        The live board: what is minting, and what to say about it
  liveCache.ts   The working calldata behind each row, so Mint needs no re-scan
  origin.ts      Provider, region and latency for every endpoint in play
  market.ts      Floor prices for the free mints that got away
  server.ts      Tracker HTTP API + self-contained dashboard
  service.ts     Service layer behind the web API (status/preflight/mint/scan)
  http.ts        Auth, JSON safety, and the shared route wrapper
  proxy.ts       Upstream proxy for an optional persistent tracker
  devserver.ts   Local host for the Vercel handlers
  bot.ts         Orchestration
  cli.ts         Command-line entry point
api/[...path].ts One serverless function; dispatches to src/routes/
src/routes/      The route handlers themselves
public/index.html  The web UI
test/            538 tests, incl. end-to-end runs against a mock node
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
