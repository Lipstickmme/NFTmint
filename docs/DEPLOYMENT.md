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

### 4. Deploy

```bash
npm i -g vercel
vercel link
vercel --prod
```

Open the URL, go to **Setup**, paste your `API_TOKEN`. It's stored in your
browser only and sent as a bearer token.

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

---

## Continuous hunting

`vercel.json` registers a cron that calls `/api/hunt` every minute. Each call is
one complete cycle — watch, judge, mint — so running it on a loop gives
continuous coverage without any process staying alive.

> **Vercel plan limits matter here.** Cron on the **Hobby** plan runs **once per
> day**, which is useless for catching mints. Per-minute schedules need
> **Pro**. If you are on Hobby, use the UI instead: the **Start hunting** button
> runs cycles back to back from your browser for as long as the tab is open,
> which needs no cron at all.

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
