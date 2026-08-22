# Deployment — hosting the bot with a UI on Vercel

The whole thing runs on Vercel: a browser UI plus serverless API routes that
preflight, mint, and scan the feed. This is the setup guide.

## What works on Vercel, and what doesn't

Worth knowing before you rely on it, because the limits are structural rather
than fixable:

| Feature | On Vercel | Why |
| --- | --- | --- |
| Web UI | ✅ Full | Static page |
| `/api/status` — chain + balances | ✅ Full | Ordinary request |
| `/api/preflight` — simulate + gas | ✅ Full | Ordinary request |
| `/api/mint` — mint now | ✅ Works | Completes inside one invocation |
| Scheduled mint | ✅ Via Vercel Cron | Cron calls `/api/mint` |
| `/api/scan` — velocity snapshot | ⚠️ Sampled | Samples a window per request; can't watch continuously |
| Continuous tracker | ❌ | Needs a WebSocket held open between requests |
| Autopilot | ❌ | Same — needs a persistent feed |
| Winning a contested race | ⚠️ Degraded | Cold starts cost 100ms–1s; FCFS ordering makes that decisive |

**The honest summary:** Vercel is fine for targeted and scheduled mints, and
for checking what's hot on demand. For a contested drop where hundreds of bots
race the same block, a warm process near the sequencer beats a cold-started
function every time — that's not a code problem, it's what serverless is.

If you later want the continuous tracker or autopilot, run `npm run serve` on
any persistent host and set `TRACKER_UPSTREAM_URL`; the UI picks it up
automatically. Both can coexist.

---

## Setup

### 1. Project settings

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Output Directory | `public` |
| Install Command | *(default — leave blank)* |
| Node.js Version | **20.x** or later |
| Root Directory | `./` |

`vercel.json` already pins these, so you can usually accept the defaults.

> **TypeScript must stay on 5.x.** Vercel's `@vercel/node` builder compiles
> `api/*.ts` using the TypeScript it finds in your `devDependencies`.
> TypeScript 7 is the new Go-based compiler with a reduced Node API, and the
> builder crashes on it with
> `Cannot read properties of undefined (reading 'readFile')`.
> `typescript` is pinned to `^5.9.3` for this reason — do not bump it to 7
> until Vercel supports it.
>
> Do not set an install command of `npm install --omit=dev` either: the builder
> needs `typescript` and `@types/*` to compile the routes, so omitting dev
> dependencies just makes it run a second install to put them back.

### 2. Generate an API token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

This is what stops anyone who finds your URL from spending your funds. The
mint endpoints **refuse to run without it** — they return 503 rather than
defaulting to open.

### 3. Environment variables

Settings → Environment Variables. Apply to Production, Preview, and
Development.

**Required:**

| Name | Example | Notes |
| --- | --- | --- |
| `API_TOKEN` | *(64-char hex)* | Mark **Sensitive**. Min 16 chars |
| `PRIVATE_KEYS` | `0xkey1,0xkey2,…` | Mark **Sensitive**. Burner wallets only |
| `NETWORK` | `testnet` | Switch to `mainnet` when ready |
| `RPC_URLS` | `https://your-endpoint` | The public RPC is rate limited — get a dedicated one |

**Strongly recommended:**

| Name | Example | Notes |
| --- | --- | --- |
| `MAX_MINT_VALUE_ETH` | `0.05` | Hard ceiling per run. Defaults to 0.05 |
| `MAX_FEE_GWEI` | `0.5` | Fee ceiling |
| `PRIORITY_FEE_GWEI` | `0` | A tip buys nothing on FCFS |

**Optional defaults for the UI form:**
`CONTRACT_ADDRESS`, `MINT_FUNCTION`, `MINT_ARGS`, `MINT_PRICE_ETH`,
`MINT_QUANTITY`, `GAS_LIMIT`, `TX_PER_WALLET`.

Anything set here is a default; the UI overrides it per request, so you don't
redeploy to mint a different contract.

**Optional, for a persistent tracker:** `TRACKER_UPSTREAM_URL`,
`TRACKER_UPSTREAM_TOKEN`.

**Required to let people sign up:** `ACCOUNT_ENCRYPTION_KEY` — see
[Accounts](#accounts-generated-wallets) below.

**Storage:** `KV_REST_API_URL`, `KV_REST_API_TOKEN` — see
[Storage](#storage) below. Without them accounts and the history work, but only
in memory, which loses generated wallets on restart.

### 4. Deploy

```bash
npm i -g vercel
vercel link
vercel --prod
```

Open the URL, go to **Setup**, paste your `API_TOKEN`. It's stored in your
browser only and sent as a bearer token.

---

## What this costs to run, and how to make it cost nothing

Read this before leaving the app open.

Both loops work by holding the sequencer feed open **inside** a serverless
function. On usage-based compute a function waiting on a WebSocket is billed as
*active* CPU for every second it waits — sleeping costs the same as working. The
first version sampled for 35 seconds and re-fired immediately, which is a ~97%
duty cycle for as long as a browser tab stayed open. **One tab left open
overnight cost eight hours of CPU and paused the account it was billed to.**

Four things now bound it:

| | Before | Now |
| --- | --- | --- |
| Hunt window | 35s, re-fired after 1.2s | 15s, then a 45s gap |
| Board window | 20s, refreshed every 24s | 6s, refreshed every 45s |
| Backgrounded tab | kept running | **both loops idle** |
| Forgotten tab | ran forever | hunt stops after ~40 quiet rounds, board after 20 refreshes |

That is roughly **4x less** while you are actively using it, and near zero when
you are not. `HUNT_WINDOW_SEC` and `HUNT_COOLDOWN_SEC` tune the first two.

**None of that makes it cheap** — a visible hunting tab is still around 18
minutes of CPU per hour, because the sampling still happens inside the request.
Watch your usage page for the first day.

### Making it cost nothing: run the tracker somewhere persistent

The real fix is not to sample the feed from a serverless function at all. A
process that stays alive opens the sequencer feed **once** and keeps it open, so
there is no per-second billing and no twenty-second blind spots between samples.
This repo already has it:

```bash
# on any always-on host — a small VPS, Fly.io, a Raspberry Pi
git clone <your repo> && cd nftmint && npm install
cp .env.example .env          # set NETWORK, RPC_URLS, TRACKER_AUTH_TOKEN
npm run serve                 # holds the feed open, serves /api/collections
```

Then point the Vercel deployment at it:

```
TRACKER_UPSTREAM_URL=https://your-host
TRACKER_UPSTREAM_TOKEN=<the same TRACKER_AUTH_TOKEN>
```

With that set, both loops stop opening a feed of their own: `runHuntCycle` and
`runLiveBoard` fetch a ranked snapshot over HTTP instead (`src/snapshot.ts`).
The duty cycle goes from ~46% to the milliseconds of one request, and the board
reports `"source": "upstream"` with `"sampledSeconds": 0` so you can confirm it
rather than assume it.

The bot also gets *better*: continuous coverage instead of samples, and no cold
start on the mint path — which matters on a chain that orders
first-come-first-served, where the delay before your bytes leave is the whole
race.

If that tracker goes down, requests fail with a message naming it rather than
quietly reverting to in-function sampling — the fallback would restore exactly
the bill this setup removes, silently, at the worst moment.
`TRACKER_UPSTREAM_FALLBACK=true` chooses the other trade.

**Setting one up, on a free VPS, with the data moved across:**
[MIGRATION.md](MIGRATION.md). It also covers moving the repo and the Vercel
project to different accounts.

---

## Why there is one function, not fourteen

Every `/api/*` request goes through a single serverless function,
`api/[...path].ts`, which dispatches to a handler in `src/routes/`. Two reasons,
both learned the hard way:

**The build used to crash with `Error: Debug Failure.`** — no file, no line, no
stack. Vercel scans every file in `api/` with ts-morph to look for an exported
`config`, and ts-morph bundles **TypeScript 4.4.4**. Walking an entrypoint's
types eventually reaches `abitype`'s declarations (a viem dependency), which use
syntax 4.4 cannot parse. It then tries to report `Type alias name cannot be
'{0}'`, omits the argument, and its own message formatter asserts. The crash is
in a transitive dependency's type definitions, surfaced with none of that
context. Keeping the entrypoint free of static `src/` imports avoids it
entirely — there is nothing for that parser to walk.

**Hobby deployments cap serverless functions at twelve.** One dispatcher is one
function however many routes exist.

Two rules keep it working, and `test/dispatch.test.ts` enforces both:

- **No static imports from `src/` in `api/[...path].ts`.** One is enough to drag
  the whole type graph back into the 4.4.4 parser.
- **Route modules are reached through *literal* `import()` specifiers.** Vercel's
  tracer follows literals and not variables — routing through a string variable
  produced a function that built green, deployed, and then failed every request
  on a missing module.

The dev server mounts the same handlers from the same table, so a route that
works locally works deployed; a test asserts the two tables agree.

---

## Billing: what the app charges the people using it

Off by one variable (`BILLING_ENABLED=false`) if you are running this for
yourself. On a hosted deployment there are two charges, both paid on-chain to
`FEE_RECIPIENT`:

| | What | Default |
| --- | --- | --- |
| Subscription | Unlocks auto-mint for 30 days | `SUBSCRIPTION_PRICE_ETH=0.0015` |
| Service fee | Percentage of each landed mint's own gas | `MINT_FEE_PCT=10`, capped by `MINT_FEE_MAX_ETH=0.0002` |

Free either way: scanning, the live board, the findings history, and the whole
UI. Only the bot minting on someone's behalf is gated.

**How a subscription is bought.** The UI shows the address and the amount. The
user sends a plain ETH transfer from one of their own generated wallets, then
posts the transaction hash to `POST /api/subscribe`. The server reads that
transaction off the chain and checks it: included in a block, succeeded, sent
to `FEE_RECIPIENT`, at least the asking price, and **from a wallet this account
holds**. That last check is not optional — payments are public, so without it
one person's transaction hash would unlock auto-mint for anyone who could read
a block explorer. Paying early extends the period rather than replacing it.

There is no card processor and nothing custodial: the money moves directly
between the user's wallet and yours, on the chain the bot already uses.

**How the service fee is taken.** After a mint confirms, one extra transfer goes
from the minting wallet to `FEE_RECIPIENT`. Separate rather than folded into the
mint, for two reasons: the mint's `value` belongs to the NFT contract, so there
is nowhere to put a fee inside it; and a separate transaction is a separate line
on the explorer under your address, which is what lets the person paying it
check the charge.

It is described to them as a service fee — its own name, the amount, the
percentage, the address, and the sentence *"this is a charge by this app, not a
network cost"*. That wording is asserted by tests. These are wallets the app
generated and whose keys it holds; the only way the person paying knows about
the fee is because the code tells them, so presenting it as part of gas would
be misrepresenting who is charging them. If you want a fee that reads as
smaller, lower `MINT_FEE_PCT` — do not relabel it.

A fee that cannot be collected never fails the mint. If the wallet is too
empty to cover it, the result says so and the user keeps their NFT.

**Pricing note.** Nothing here reads a price feed, so the subscription is
denominated in ETH and the dollar figure moves. `SUBSCRIPTION_PRICE_NOTE` is
shown to users verbatim — keep it honest about that.

---

## Security — read this part

Putting `PRIVATE_KEYS` on Vercel means **every deployment of this project can
sign transactions with your wallets.** That is a real exposure, and worth being
deliberate about:

- **Burner wallets only.** Fund them with what a mint needs, nothing more.
- **`API_TOKEN` is the only barrier.** Long and random. Rotate it if it leaks.
- **`MAX_MINT_VALUE_ETH` bounds the damage** if the token does leak. Keep it at
  the smallest number that lets your mints through.
- **Preview deployments inherit env vars.** Anyone who can open a preview URL
  can reach the API. Restrict env vars to Production if that matters to you.
- **Never commit `.env`.** It's gitignored; keep it that way.

The request body can only override an allowlisted set of mint fields
(contract, function, args, price, quantity, gas, dry-run). It cannot change
`PRIVATE_KEYS`, `RPC_URLS`, or `MAX_MINT_VALUE_ETH` — those come from the
environment only, and there's a test asserting exactly that.

### What holds, and what does not

The checklist below is the current state, including the parts that are only
partly closed. Each line has tests behind it.

**Endpoints**

- An RPC URL carries the API key in its path. Nothing prints one: errors, logs
  and the status response all go through a redaction that keeps only the host.
  This was a live leak — an operator's Alchemy key was rendered into a "not
  minted" line in the browser — and there is a test that drives a JSON-RPC error
  through a keyed endpoint and asserts the key does not survive.

**Keys**

- Generated private keys are sealed with AES-256-GCM under `ACCOUNT_ENCRYPTION_KEY`
  and never written in the clear. A test reads the file back and asserts nothing
  key-shaped appears in it.
- Nothing passes a key to a logger, and no response carries one except
  `?reveal=1`, which is a separate request that the page never makes on load.
- The API view of an account cannot carry a sealed blob or the token hash —
  asserted directly.
- Every revealed key derives the address it was stored under, so a wallet can
  never be shown that nobody can spend from.

**Credentials**

- The account key is stored as a SHA-256 hash, compared in constant time. A
  database dump cannot be replayed against the API.
- A missing account and a wrong key return the identical message, so account ids
  cannot be enumerated.
- Credentials travel in headers, never the query string, so they stay out of
  access logs.
- There is no reset path. Losing the key loses the account — by design, because
  a recovery channel is a second way in.

**Money**

- `MAX_MINT_VALUE_ETH` is enforced server-side and no request can widen it.
- The value attached to a mint is clamped to the price ceiling *independently*
  of the criteria check that already rejects an over-priced collection.
  `observedValueWei` is an average of numbers an attacker can inflate by
  spamming a contract, so it gets two independent bounds rather than one.
- Auto-mint sends zero value by default (`HUNT_FREE_ONLY=true`).

**The endpoint an account supplies**

- Rejected if it is not http(s), if the host is loopback/private/link-local, or
  if it resolves to any of those. `169.254.169.254` — the cloud metadata
  service — and IPv4-mapped IPv6 forms of it are both covered.
- **Residual risk, stated plainly:** the check happens when the URL is saved.
  DNS can change afterwards, so a host that is *actively* rebinding can still
  get through. Closing that fully needs an IP check at socket-connect time on
  every call. What the current check buys is that pointing a domain at something
  private is not enough on its own.

**The browser**

- Every value from the chain or the API is escaped before it reaches the DOM,
  and a test drives a hostile `javascript:` URL through the artwork field to
  prove it.
- URLs are scheme-checked as well as escaped, because escaping alone does not
  stop `javascript:` in an `href`.
- A CSP is set: `default-src 'none'`, no external scripts, `connect-src 'self'`.
  **`script-src` still allows `'unsafe-inline'`**, because the app is a single
  inline script and static headers cannot carry a per-request nonce. Escaping is
  the actual defence there; the CSP narrows everything else around it.

**Rate limits**

- Sign-up is 3/hour per caller; minting and hunting have their own buckets.
- **These depend on a trusted proxy.** The caller's IP comes from
  `x-real-ip` / `x-vercel-forwarded-for` first (Vercel sets these and a client
  cannot forge them) and `x-forwarded-for` last. Behind no proxy at all — a bare
  `npm run serve` — all of those are client-supplied and the limit becomes a
  courtesy. The hard bound stays `MAX_MINT_VALUE_ETH`.
- Buckets are per-process, so on serverless each instance keeps its own. A speed
  bump, not a distributed guarantee.

**Not addressed**

- Anyone who can create accounts can create many. Each is a couple of KB, so
  this is a storage-growth nuisance rather than a compromise, but there is no
  global cap.
- The deployment is custodial. No amount of the above changes that.

---

## Continuous hunting

**Out of the box, hunting runs from the browser.** Press **Start hunting** and
the page runs cycles back to back for as long as the tab is open. This works on
every Vercel plan and needs no cron.

`vercel.json` deliberately ships **no cron**. Vercel validates cron schedules
against your plan *at deploy time*, and the **Hobby plan allows only one run per
day** — so a per-minute schedule does not merely get throttled, it **fails the
whole deployment**. Shipping one by default would silently break deploys for
every Hobby user.

On **Pro**, where per-minute schedules are allowed, add it back:

```json
"crons": [{ "path": "/api/hunt", "schedule": "* * * * *" }]
```

and set `CRON_SECRET` (see below) — without it the endpoint refuses scheduled
requests.

Re-buying is prevented on chain rather than in a database: before minting, the
wallet's `balanceOf` for that contract is checked, and a non-zero balance means
an earlier cycle already bought it. That makes the loop idempotent with no
storage to provision or keep in sync.

**`CRON_SECRET` is required for cron-triggered hunting.** Vercel marks its own
requests with an `x-vercel-cron` header, but any client can set that header, so
it is not proof of anything. The endpoint therefore only honours it when paired
with a matching `CRON_SECRET`; without one, a cron-shaped request is treated
like any other and must present `API_TOKEN`. Set `CRON_SECRET` in your
environment and Vercel passes it automatically.

## Accounts: generated wallets

Sign-up generates ten wallets per account and mints from all of them, which is
how a one-per-wallet drop yields ten.

Set one variable to enable it:

```bash
openssl rand -hex 32   # → ACCOUNT_ENCRYPTION_KEY
```

Every generated private key is sealed with AES-256-GCM under that value, so a
dump of the database alone cannot spend them.

**Never rotate it.** Changing it makes every existing wallet unopenable and
strands whatever they hold. There is no recovery path, by design — a fallback
would be a second way in.

**This deployment is custodial.** To mint while someone is away, the server must
hold keys that can spend. Whoever controls the host and this key can move
anything those wallets hold. Say so to anyone you hand the URL to, and keep the
wallets to gas money.

Sign-up needs no credential — it is the front door of the app — so it is rate
limited to three per hour per caller, since each call generates ten keypairs and
writes a row.

An account's access key is shown once and stored only as a hash. It cannot be
reset, and losing it loses the account.

Accounts can set their own RPC endpoint. That URL is checked against loopback
and private ranges before the server will call it, because otherwise it would be
a way to aim the server at a cloud metadata service and read the reply back
through an error message.

---

## Storage

Accounts and the history of found mints share one store, chosen from the
environment. **With nothing configured it works, but in memory only** — every
serverless instance keeps its own copy and loses it on recycle. That is merely
untidy for the history and actively dangerous for accounts, so `/api/health`
reports it as a problem and the sign-up screen says so before anyone funds
anything.

To make it durable:

1. Vercel dashboard → **Storage** → create a **KV / Upstash Redis** database.
2. Connect it to this project.

Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` on the next deploy and
the app picks them up automatically — no code change, no migration.
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` work identically.

Running on a persistent host instead? Set `DATA_DIR` to a directory and it
writes a JSON file per namespace.

| Variable | Effect |
| --- | --- |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis over REST. Survives restarts and is shared across instances |
| `DATA_DIR` | A directory of JSON files, for a persistent host |
| neither | Process memory. Survives nothing |
| `KV_KEY_PREFIX` | Only if several deployments share one database |

Accounts never expire. The findings history keeps the 200 most recent and ages
out after 30 days.

---

## Floor prices for missed mints

Optional, and off unless configured. Point `MARKET_API_URL` at a marketplace
endpoint and past free mints carry their floor plus what ten wallets would have
held:

```bash
MARKET_API_URL=https://api.example.com/v1/collections/{contract}
MARKET_API_TOKEN=…        # optional
MARKET_CURRENCY=ETH       # label only
```

The `{contract}` placeholder is filled with the address; without it the address
is appended. The response shapes the common marketplaces use are all understood
(`floorPrice`, `floor_price`, `stats.floor_price`, `floorAsk.price.amount.native`).

No marketplace is baked in on purpose. Shipping a URL that has not been verified
against this chain would produce prices that get acted on — every floor reads as
unknown until you configure a source you trust.

---

## The live board

`/api/live` samples the sequencer feed and reports everything minting, with
supply, price, round, and the numbers behind each. It reads only — no wallet is
touched and nothing is signed — so it works before anyone has funded anything.

It is the heaviest route in the deployment: it holds the feed open for its
sampling window and then inspects a dozen contracts. Budgeted at 60s and 1GB in
`vercel.json`, and charged against the `hunt` rate-limit bucket rather than
`read`.

Two knobs, both on the query string:

```bash
curl -H "x-account-id: $ID" -H "x-account-token: $KEY" \
  "https://your-app.vercel.app/api/live?seconds=20&minMints=12"
```

`minMints` is the floor that decides what counts as a drop. Below it a contract
is one person testing their own deployment.

Pressing **Mint** on a row calls `POST /api/mintnow`, which replays the working
transaction the board already captured, through the same path the hunter uses.
That route applies the NFT gate, the sold-out check and the price ceiling, but
not the hunt criteria — someone pressing a button on a named row has already
decided what to mint.

---

## Two lists: passed, and close

The app keeps two lists, and the second one is the useful half.

**Passed** — cleared every rule, with what became of the mint: confirmed
transactions, or the exact reason nothing was sent.

**Close** — scored 70 or better and still did not qualify, weakest rule named
first. This is the tuning surface: "loosen *this* number and it would have
minted" beats guessing at thresholds.

The cut is a score, not a count of failures, because a count cannot tell 29
mints a minute from 2 when the threshold is 30 — both "failed one rule". See
[Match score](../README.md#match-score-how-close-is-close) for how the number is
built.

Records are keyed by contract, so a collection seen across twenty rounds stays
one row with a `seen in N rounds` count. Each account's history is its own; what
the chain was doing is shared, but which wallets tried and which transactions
landed is not.

The endpoint behind the lists:

```bash
# signed in as an account
curl -H "x-account-id: $ID" -H "x-account-token: $KEY" \
  https://your-app.vercel.app/api/findings

# just the close ones, with the rules each fell short on
curl -H "x-account-id: $ID" -H "x-account-token: $KEY" \
  "https://your-app.vercel.app/api/findings?filter=close"

# a looser cut
curl -H "x-account-id: $ID" -H "x-account-token: $KEY" \
  "https://your-app.vercel.app/api/findings?filter=close&minScore=50"

# as the operator, over your own PRIVATE_KEYS instead
curl -H "Authorization: Bearer $API_TOKEN" https://your-app.vercel.app/api/findings

# start over
curl -X DELETE -H "x-account-id: $ID" -H "x-account-token: $KEY" \
  https://your-app.vercel.app/api/findings
```

---

## Scheduled mints with Vercel Cron

Cron can't send a bearer token, so gate it with Vercel's own `CRON_SECRET`, or
keep a dedicated endpoint. Add to `vercel.json`:

```json
"crons": [{ "path": "/api/mint", "schedule": "0 15 * * *" }]
```

Cron granularity is one minute, and a cold start adds a few hundred
milliseconds — fine for an uncontested drop, not for a race.

---

## Running locally

The same handlers Vercel deploys, over a local server:

```bash
cp .env.example .env      # fill in
npm run dev               # http://127.0.0.1:3000
```

Use this to test before deploying — a broken route fails here rather than in
production.

---

## Optional: add the continuous tracker

To get the always-on tracker and autopilot, run this on any persistent host
(VPS, Railway, Fly.io, your own machine — ideally near the sequencer):

```bash
PORT=8080 TRACKER_AUTH_TOKEN=<random> npm run serve
```

Put it behind TLS, then on Vercel set:

```bash
TRACKER_UPSTREAM_URL=https://tracker.yourdomain.com
TRACKER_UPSTREAM_TOKEN=<same value as TRACKER_AUTH_TOKEN>
```

`/api/collections` then serves a continuous leaderboard instead of a sampled
one. `npm run auto` (autopilot) runs on that host too.

---

## Rate limits and overlapping cycles

The spending endpoints are rate limited per process, and `/api/hunt` runs one
cycle at a time:

| Endpoint | Burst | Sustained |
| --- | --- | --- |
| `/api/hunt` | 6 | 6/min |
| `/api/mint` | 10 | 10/min |
| reads (`status`, `plan`, `inspect`, `preflight`, `scan`) | 60 | 60/min |

A hunt cycle takes ~35s, so continuous hunting sits near 2/min — the limit is
there to bound a leaked token, not to get in your way. Exceeding one returns
`429` with a `Retry-After` header. Limits are charged only after authentication,
so a flood of bad-token requests cannot lock you out of your own bot.

`/api/hunt` also refuses to start a second cycle while one is running. That is
about correctness rather than abuse: two concurrent cycles would prime nonces
from the same wallets and then broadcast conflicting transactions, so the second
batch would be rejected as "nonce too low". A cron firing while the browser is
already hunting hits exactly that, and now returns a skipped result instead.

These counters live in the process, so on serverless each instance keeps its
own. That makes them a real speed bump rather than a distributed guarantee —
the hard bound on losses stays `MAX_MINT_VALUE_ETH`, which is enforced per run
and cannot be widened by any request.

## Verifying a deployment

```bash
# Public — reports what is configured, without leaking values
curl https://your-app.vercel.app/api/health

# Authenticated
curl -H "Authorization: Bearer $API_TOKEN" https://your-app.vercel.app/api/status
```

Healthy looks like:

```json
{ "ok": true,
  "configured": { "apiToken": true, "privateKeys": true, "rpcUrls": true,
                  "network": "testnet", "spendCeilingEth": "0.05" },
  "problems": [] }
```

| Symptom | Cause |
| --- | --- |
| `503 API_TOKEN is not set` | Env var missing, or not applied to that environment — redeploy after adding |
| `401 invalid token` | Token in the UI doesn't match `API_TOKEN` |
| `400 Missing required environment variable …` | That field isn't set in env or the form |
| `/api/scan` returns `connected: false` | Vercel can't reach the sequencer feed, or nothing is minting |
| Mint times out | Raise `maxDuration`, or reduce wallets per run |
| Build fails: `Cannot read properties of undefined (reading 'readFile')` | TypeScript 7 in `devDependencies`. Pin to `^5.9.3` — see the note above |
| Build warns about `"engines"` auto-upgrading | Harmless. `>=20` is accurate; pin the version in Vercel project settings if you want it fixed |

---

## First run

1. **Setup** tab → paste `API_TOKEN`.
2. **Status** tab → confirm the chain is reachable and wallets are funded.
3. **Mint** tab → fill in the contract, keep **Dry run** checked, hit
   **Preflight**, then **Mint**. Nothing is broadcast.
4. Uncheck **Dry run** and mint for real — on `testnet` first.
5. Switch `NETWORK` to `mainnet` only after a full testnet run succeeds.
