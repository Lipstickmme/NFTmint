# Deployment — Vercel dashboard + persistent bot

## Why this is split across two hosts

You asked to keep secrets in Vercel environment variables instead of `.env`.
That works, and the settings are below — but it matters *which* process runs
where, for two reasons that are not stylistic:

1. **Vercel serverless functions cannot hold a WebSocket open.** They run per
   request and are then frozen or destroyed. The sequencer feed — the whole
   basis of the tracker and the earliest mint trigger — is a persistent
   WebSocket. There is nowhere in a serverless function for that connection to
   live between requests.

2. **Cold starts cost 100ms–1s.** On a chain that orders first-come-first-served,
   that is not a tuning detail, it is the entire race. A cold-started function
   loses to a warm process every single time.

So the split is:

| Component | Runs on | Holds private keys? |
| --- | --- | --- |
| **Dashboard + API** (`api/`, `public/`) | **Vercel** | **No** |
| **Tracker** (`nftmint serve`) | Persistent host | No |
| **Mint bot / autopilot** (`run`, `auto`) | Persistent host | **Yes** |

This is also the safer arrangement, and worth stating plainly: **your private
keys never go to Vercel.** The internet-facing surface is read-only and cannot
spend. If you put `PRIVATE_KEYS` in Vercel env vars, every function that
deploys can sign transactions — and a mistake there is unrecoverable.

```
   Vercel (public)              Your host (private)
   ┌────────────────┐           ┌──────────────────────┐
   │ public/index   │  HTTPS    │ nftmint serve        │◀── wss:// sequencer feed
   │ api/collections│──────────▶│  tracker + status API│
   │ api/health     │  bearer   ├──────────────────────┤
   └────────────────┘           │ nftmint auto  🔑     │──▶ RPC (mint)
     no keys                    │ nftmint run   🔑     │
                                └──────────────────────┘
```

---

## Part 1 — Vercel (dashboard)

### Project settings

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Build Command | *(leave default — `vercel.json` sets it)* |
| Output Directory | `public` |
| Install Command | `npm install --omit=dev` |
| Node.js Version | **20.x** or later |
| Root Directory | `./` |

`vercel.json` already pins these, so in most cases you can accept the defaults
and only set environment variables.

### Environment variables (Settings → Environment Variables)

| Name | Example | Required | Notes |
| --- | --- | --- | --- |
| `TRACKER_UPSTREAM_URL` | `https://tracker.yourdomain.com` | **Yes** | Where `nftmint serve` is reachable |
| `TRACKER_UPSTREAM_TOKEN` | `long-random-string` | Recommended | Must equal `TRACKER_AUTH_TOKEN` on the host |
| `DASHBOARD_TOKEN` | `another-random-string` | Optional | Token visitors need: `/?token=...` |
| `PROXY_TIMEOUT_MS` | `8000` | Optional | Upstream timeout |

Mark `TRACKER_UPSTREAM_TOKEN` and `DASHBOARD_TOKEN` as **Sensitive** so they
are write-only in the dashboard. Apply to Production, Preview, and Development.

**Do not set on Vercel:** `PRIVATE_KEYS`, `MINT_*`, `AUTO_*`. They are unused
there, and setting them only widens what a compromise would expose.

### Deploy

```bash
npm i -g vercel
vercel link
vercel --prod
```

Then open `https://your-app.vercel.app` (add `?token=...` if you set
`DASHBOARD_TOKEN`).

Generate tokens with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Part 2 — The persistent host

Anywhere that runs a long-lived Node process: a VPS, Railway, Fly.io, Render,
a Docker host, or your own machine. **Pick a region close to the sequencer** —
on FCFS this is the highest-leverage decision you can make. Measure it:

```bash
npm run latency
```

### Setup

```bash
git clone https://github.com/Lipstickmme/NFTmint.git
cd NFTmint
npm install
cp .env.example .env    # fill in — this file is gitignored
```

### Run the tracker (no keys needed)

```bash
PORT=8080 TRACKER_AUTH_TOKEN=<same-as-vercel> npm run serve
```

Serves `/api/collections`, `/api/health`, and a local dashboard at `/`.
Put it behind TLS (Caddy, nginx, or Cloudflare Tunnel) before exposing it —
`TRACKER_UPSTREAM_URL` should be `https://`.

### Run the bot (keys needed, keep private)

```bash
npm run track        # watch velocity, send nothing
npm run auto         # autopilot: mass-mint hot free mints
npm run run:bot      # targeted mint of one known contract
```

Keep it alive with systemd, pm2, or a Docker restart policy.

### Environment variables for this host

Everything in `.env.example`. The ones that matter most:

```bash
NETWORK=mainnet
RPC_URLS=https://your-dedicated-endpoint     # NOT the public RPC
PRIVATE_KEYS=0xkey1,0xkey2,...,0xkey10       # burners only
TRACKER_AUTH_TOKEN=<same value as TRACKER_UPSTREAM_TOKEN on Vercel>

AUTO_FREE_ONLY=true
AUTO_TOTAL_BUDGET_ETH=0.05
AUTO_TX_PER_WALLET=1
MIN_MINTS_IN_WINDOW=25
MIN_UNIQUE_MINTERS=10
```

---

## If you really want everything on Vercel

It is possible for the *targeted* mint only (`run` with `TRIGGER_MODE=now`),
via a Vercel Cron hitting a function that mints once. You would set
`PRIVATE_KEYS` on Vercel and accept the risks above.

It will not work for `track`, `serve`, or `auto` — all three need a persistent
feed connection — and cold starts make it uncompetitive against anyone running
a warm process. I would not do it, but the constraint is documented so the
choice is yours rather than a surprise.

---

## Verifying a deployment

```bash
# Host is up and tracking
curl -H "Authorization: Bearer $TRACKER_AUTH_TOKEN" \
     https://tracker.yourdomain.com/api/health

# Vercel can reach the host
curl https://your-app.vercel.app/api/health
```

A healthy response looks like:

```json
{ "ok": true, "uptimeSec": 412, "contractsTracked": 37,
  "feedTxSeen": 20551, "mintsSeen": 1832 }
```

If `/api/health` on Vercel returns `502 upstream unreachable`, the host is not
reachable from the internet — check TLS, firewall, and that
`TRACKER_UPSTREAM_URL` has no typo. `401` means the two tokens disagree.
`{"error": "TRACKER_UPSTREAM_URL is not set..."}` means the env var did not
apply to that environment; redeploy after adding it.
