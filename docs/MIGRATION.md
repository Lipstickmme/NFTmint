# Migration — new GitHub, new Vercel, and a host that stays on

Three moves that are usually described as one:

1. The **code** goes to a different GitHub account.
2. The **site** goes to a different Vercel account.
3. The **feed** goes to a machine that never sleeps — which is the part that
   actually fixes the bill.

Do them in that order. Parts 1 and 2 are mechanical. Part 3 is the one worth
reading carefully, because moving to a new Vercel account without it just moves
the problem to a new account.

---

## First: what actually paused the account

Vercel bills Fluid **Active CPU** — a function that is *awaiting* something is
billed for every second it waits, not just for the milliseconds it spends
computing. Three request paths in this app opened a WebSocket to the sequencer
feed and held it:

| Path | Window held open | Poll interval | Duty cycle |
| --- | --- | --- | --- |
| Live board | `windowSec` = 6s | 45s | ~13% |
| Hunt cycle | `HUNT_WINDOW_SEC` = 15s | 45s | ~33% |
| `/api/scan` | 3–55s, per request | on demand | spiky |

Roughly **46% of wall-clock time billed as active CPU, per open tab**. One
browser left open overnight is about 4.5 hours of billed CPU. That is where 10
hours in a day came from, and no amount of code tuning fixes it — the cost is
the waiting, and the waiting is the product.

A machine that stays on holds that same feed for free, because the connection
is open anyway. So the fix is not "use less CPU on Vercel", it is **"do the
listening somewhere else and let Vercel read the answer"**.

That is what `TRACKER_UPSTREAM_URL` now does. Set it, and all three — the hunt
cycle, the live board and `/api/scan` — fetch a ranked snapshot over HTTP
instead of opening a feed (`src/snapshot.ts`). Duty cycle drops from ~46% to
the milliseconds of one request.

Nothing else in a Vercel function opens a feed. The bot's `feed` trigger cannot
be reached from the API — `buildEnv` forces `TRIGGER_MODE=now`, because a
function cannot outlive its request anyway — and the autopilot is CLI-only. A
test in `test/snapshot.test.ts` asserts none of the three request paths ever
constructs a `FeedConsumer` again, because re-adding one would work perfectly
and quietly bring the bill back.

**If you skip Part 3, expect the new Vercel account to be paused too.**

---

## Which free VPS

### The short answer

**Oracle Cloud Always Free**, an Ampere A1 instance (ARM). It is the only free
tier on this list that gives a real always-on VM, permanently, with enough
network allowance to matter.

### The comparison

| Provider | What's free | Verdict for this job |
| --- | --- | --- |
| **Oracle Cloud Always Free** | Up to 4 Ampere A1 ARM cores + 24 GB RAM across up to 4 VMs, 200 GB block storage, ~10 TB/month egress | **Use this.** Permanent, real VM, no sleep, egress that a polling API will never touch |
| **Google Cloud always-free** | 1× e2-micro (1 GB RAM) in `us-west1`/`us-central1`/`us-east1`, 30 GB disk, **1 GB/month egress from North America** | Works, but see the egress maths below — the free tier's cap is the problem, not the VM |
| **Render free tier** | Web services only, sleeps after ~15 min idle | **Fatal.** A sleeping process drops the WebSocket. That is the one thing this host exists to hold |
| **Railway / Heroku** | Trial credit, then paid | Not a free tier any more |
| **AWS EC2** | 12 months of `t3.micro`, or credits on newer accounts | Works well, and best if you are already on AWS — but it does eventually bill. See below |
| **Cloudflare Workers** | Generous, but no long-lived outbound WebSocket on the standard runtime | Would need a Durable Objects rewrite. Not worth it |

Free tiers change constantly — check the current limits before you commit;
these are what they were when this was written.

### The egress maths, because it decides Oracle vs GCP

The Vercel side polls the tracker every 45 seconds — about **1,920 requests a
day**. A `/api/collections?limit=40` response is roughly 20–60 KB of JSON. So:

```
1,920 × 40 KB ≈ 77 MB/day ≈ 2.3 GB/month
```

- Google Cloud always-free: **1 GB/month** free egress from North America. You
  are over the cap in under two weeks, every month.
- Oracle Always Free: **10 TB/month**. Not a consideration.

You can cut the polling interval to stay inside GCP's cap, but you would be
tuning the product around a free tier instead of picking a better free tier.

### The Oracle caveats, so they don't surprise you

- **"Out of host capacity."** A1 instances are frequently unavailable in busy
  regions. Try a different availability domain or region, or retry later.
  Upgrading to Pay-As-You-Go (which keeps Always Free resources free) gets you
  ahead of the queue.
- **Idle reclamation.** Oracle may reclaim Always Free compute that looks idle
  on free-only accounts. A tracker holding a feed is low CPU but steady network,
  which helps, though it is not a guarantee. Upgrading to Pay-As-You-Go stops
  reclamation entirely and still costs nothing within the Always Free limits.
- **Two firewalls.** Oracle's Ubuntu images ship with local iptables rules *and*
  a VCN security list. Opening a port means doing both. The Cloudflare Tunnel
  option below avoids both.

### On AWS specifically

If you are already on AWS, use AWS — one provider to reason about beats saving
nothing on a second one. Two things to know before you start.

**The free tier is not permanent.** The classic 12-month `t2.micro`/`t3.micro`
allowance expires, and newer accounts get a credit-based free tier instead of a
perpetual one. Either way this box eventually bills. It is small — a
`t4g.small` on a 1-year Savings Plan is a few dollars a month — but budget for
it rather than being surprised. Set a Billing alarm on day one.

**Pick Graviton.** `t4g.small` (2 vCPU, 2 GB, ARM) is the sweet spot: cheaper
than the x86 equivalent and more than this needs. `t4g.micro` (1 GB) also works.
The Docker image builds for arm64, so nothing changes.

Launch it:

| Setting | Value |
| --- | --- |
| AMI | Ubuntu Server 24.04 LTS (**arm64**, to match `t4g`) |
| Instance type | `t4g.small` |
| Storage | 20 GB gp3 |
| Key pair | one you keep — there is no password login |
| Security group | see below |

**Security group: SSH only.** Inbound `22/tcp` from *your* IP, nothing else.
Not `0.0.0.0/0`, and not port 8080 — the tracker is reached over a tunnel or
behind TLS, neither of which needs an open port for the app itself. Outbound:
leave the default allow-all; the sequencer feed is an outbound WebSocket.

Then either paste this as **User data** at launch, or run it after SSHing in:

```bash
#!/bin/bash
set -eux
apt-get update && apt-get install -y git
cd /opt
git clone https://github.com/<new-account>/NFTmint.git nftmint-src
cd nftmint-src
./deploy/setup-vps.sh
```

Give it a few minutes, then SSH in and check:

```bash
ssh -i your-key.pem ubuntu@<public-ip>
sudo journalctl -u nftmint-tracker -f
sudo grep TRACKER_AUTH_TOKEN /opt/nftmint/.env
curl -H "Authorization: Bearer <that token>" http://127.0.0.1:8080/api/health
```

**Give it an Elastic IP** if you are going the TLS-and-domain route: a stopped
and restarted instance gets a new public IP otherwise, and your DNS record goes
stale at the worst time. An Elastic IP attached to a running instance is free.
With a Cloudflare Tunnel you do not need one at all.

**Egress**, since that decided Oracle vs GCP above: AWS gives 100 GB/month free
across the account and charges about $0.09/GB after. The ~2.3 GB/month this
polling costs is inside the free allowance and would be about 20¢ if it were
not.

If you would rather not manage a VM at all, **App Runner** or a **Fargate**
task runs the same image with no host to patch — but neither has a free tier,
so it is a convenience purchase, not a saving.

### The caveat that would change this answer

On a first-come-first-served chain there is no gas auction — latency is the
only lever. But note *what* is being hosted:

- **The tracker only listens.** It never sends a transaction. Its distance from
  the sequencer affects how quickly it *notices* a drop, by tens of
  milliseconds. Pick a region near the sequencer if you can; do not pay for one.
- **The mint is sent from wherever the mint runs** — today, the Vercel function.
  That path is the race, and it is unchanged by this move.

If you later move minting itself onto this box, region choice stops being a
nicety. Measure before assuming: `npm run latency` from the VPS, and
`/api/origin` reports where a mint currently enters the chain.

---

## Part 1 — the repository

You said you would fork it, which is the fast path:

```bash
# On the new account: fork on github.com, then re-point your clone
git remote set-url origin https://github.com/<new-account>/NFTmint.git
git push -u origin main
```

A fork keeps a visible link to the original and cannot be made private. For a
clean, private, independent copy instead, create an empty repo on the new
account and mirror into it:

```bash
git clone --bare https://github.com/Lipstickmme/NFTmint.git
cd NFTmint.git
git push --mirror https://github.com/<new-account>/<new-name>.git
```

Either way, rewrite the four hardcoded URLs — nothing else in the tree names an
account:

```bash
git grep -l 'Lipstickmme/NFTmint' | xargs sed -i 's|Lipstickmme/NFTmint|<new-account>/NFTmint|g'
```

That covers `package.json` (`repository`, `bugs`, `homepage`) and the
`git clone` line in `README.md`. Nothing else is account-specific: every Vercel
reference in the docs is a `your-app.vercel.app` placeholder.

**Nothing secret is in the repository.** `.env` is ignored, `data/` is ignored,
and backups are ignored. Every secret lives in the Vercel dashboard or on the
VPS, so a fork carries no credentials — which also means the new deployment
starts with none. Part 4 is where you put them back.

---

## Part 2 — the VPS

Pick either. Docker is easier to move again later; the native path has one less
moving part.

### Docker

```bash
git clone https://github.com/<new-account>/NFTmint.git
cd NFTmint
cp .env.example .env

# The two secrets that matter
echo "TRACKER_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
echo "ACCOUNT_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env   # see the warning below

docker compose up -d --build
docker compose logs -f tracker
```

The container binds `0.0.0.0` — it has to, or nothing outside it could connect
— so the entrypoint **refuses to start without `TRACKER_AUTH_TOKEN`**. The
published port is `127.0.0.1:8080` only; exposing it is a separate, deliberate
step (Part 3).

### Native, as a systemd service

```bash
git clone https://github.com/<new-account>/NFTmint.git
cd NFTmint
sudo ./deploy/setup-vps.sh
```

Installs Node 22, builds, creates a `nftmint` system user, writes a first
`.env` with both secrets generated, installs
`deploy/nftmint-tracker.service`, starts it, and waits for `/api/health` to
answer. Re-run it after a `git pull` to deploy new code — it will not overwrite
an existing `.env`.

```bash
journalctl -u nftmint-tracker -f     # logs
systemctl restart nftmint-tracker    # restart
```

### Check it

```bash
curl -H "Authorization: Bearer $TRACKER_AUTH_TOKEN" http://127.0.0.1:8080/api/health
# {"ok":true,"uptimeSec":42,"contractsTracked":18,"feedTxSeen":91043,...}
```

`feedTxSeen` climbing is the signal that the feed is actually connected. If it
stays at 0, the tracker is up but the sequencer feed is not reachable — check
`NETWORK` and outbound connectivity before going further.

---

## Part 3 — letting Vercel reach it

The Vercel side sends `TRACKER_UPSTREAM_TOKEN` on every request. Over plain
HTTP that token is readable in transit, so do not simply open port 8080.

### Option A — Cloudflare Tunnel (no domain, no open ports)

Best fit for Oracle, because it sidesteps both of their firewalls.

```bash
# on the VPS
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
cloudflared tunnel login
cloudflared tunnel create nftmint
cloudflared tunnel route dns nftmint tracker.<your-domain>
cloudflared tunnel run --url http://127.0.0.1:8080 nftmint
```

Then install it as a service (`cloudflared service install`) so it survives a
reboot. No inbound port is ever opened.

### Option B — Caddy with your own domain

Point an A record at the VPS, open 80 and 443, then:

```bash
echo "TRACKER_DOMAIN=tracker.example.com" >> .env
echo "ACME_EMAIL=you@example.com" >> .env
docker compose --profile tls up -d
```

`deploy/Caddyfile` publishes `/api/*` only and gets its certificate
automatically. The dashboard at `/` stays unpublished — the UI is on Vercel and
a second copy is a second thing to secure.

On Oracle, remember both firewalls: the VCN security list **and** the instance's
own iptables rules.

### Then, on Vercel

```
TRACKER_UPSTREAM_URL=https://tracker.example.com
TRACKER_UPSTREAM_TOKEN=<the VPS's TRACKER_AUTH_TOKEN, exactly>
```

Redeploy. The live board's response now reports `"source": "upstream"` and
`"sampledSeconds": 0` — that is your confirmation the feed is no longer being
opened inside the function.

**No CSP change is needed.** The browser never talks to the VPS; the Vercel
function does, server-side. `connect-src 'self'` stays as it is.

If the tracker goes down, requests fail with a message naming it, rather than
silently falling back to in-function sampling and restoring the bill. If you
would rather have a slow board than no board, set
`TRACKER_UPSTREAM_FALLBACK=true`.

---

## Part 4 — the new Vercel account

### Import

New account → **Add New → Project** → import from the new GitHub → deploy. The
repo already carries `vercel.json`, so framework settings need no attention.

Point the old project's custom domain (if any) at the new one only after the new
deployment answers — a domain can only be attached to one project at a time.

### Environment variables

Get them out of the old account first, while you still have access:

```bash
# with the OLD account selected
npx vercel env pull .env.old --environment=production
```

Or copy them from the dashboard. Then set them on the new project, for
Production, Preview, and Development.

| Variable | Carry across? | Notes |
| --- | --- | --- |
| `ACCOUNT_ENCRYPTION_KEY` | **Identical, or wallets are lost** | See the warning below |
| `API_TOKEN` | Generate a new one | Mark Sensitive |
| `RPC_URLS` | New key | The old Alchemy key was exposed in a browser error — rotate it |
| `NETWORK` | Same | `mainnet` or `testnet` |
| `PRIVATE_KEYS` | Same, if you use operator wallets | Mark Sensitive |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | See storage below | |
| `TRACKER_UPSTREAM_URL` / `TRACKER_UPSTREAM_TOKEN` | New | From Part 3 |
| `MAX_MINT_VALUE_ETH`, `MAX_FEE_GWEI`, `HUNT_*` | Same | Plain settings, no secrets |

### Storage

Two options, and the first is much simpler:

**Re-point the same database.** If storage was Upstash (Vercel KV), the data
never has to move — attach the *same* database to the new project, or just copy
`KV_REST_API_URL` and `KV_REST_API_TOKEN` across. Nothing to export, nothing to
verify. Do this unless the database itself is tied to the old account's billing.

**Move the data.** If you need a new database, or you want the accounts on the
VPS instead, use Part 5.

---

## Part 5 — moving the data

Two namespaces matter: `accounts` (generated wallets, sealed) and `findings`
(what the hunter found, per account). The live-board cache is not carried — it
rebuilds itself within a minute.

Describe each end in its own env file. `--env` reads that file **and nothing
else**, so a stale variable in your shell cannot silently redirect either side:

```bash
# old.env — the deployment being left
KV_REST_API_URL=https://old-database.upstash.io
KV_REST_API_TOKEN=...
ACCOUNT_ENCRYPTION_KEY=<the old key>

# new.env — where it is going (Upstash, or a VPS directory)
KV_REST_API_URL=https://new-database.upstash.io
KV_REST_API_TOKEN=...
ACCOUNT_ENCRYPTION_KEY=<the same key>
# ...or, on the VPS: DATA_DIR=/var/lib/nftmint
```

Then:

```bash
npm run cli -- export --env old.env --out backup.json
npm run cli -- import --env new.env --in backup.json --dry-run   # look first
npm run cli -- import --env new.env --in backup.json
```

The backup is written `0600` and holds **sealed** wallet keys — ciphertext, not
private keys. It is still the closest thing to a wallet file this app produces:
keep it out of git (already ignored), move the encryption key by a different
route, and delete the backup when the move is done.

`import` refuses to write if the destination's `ACCOUNT_ENCRYPTION_KEY` cannot
open the wallets in the backup. That check is the point of the command. Existing
rows are skipped rather than overwritten, so a re-run is safe; `--overwrite`
forces a redo.

### ⚠ `ACCOUNT_ENCRYPTION_KEY` is the one thing you cannot regenerate

Every generated wallet's private key is sealed under it. Change it and the
wallets still list, still show their addresses, and can never sign again —
anything funded in them is stranded. There is no recovery.

Copy it exactly. If `import` says the key does not open the wallets, **stop** and
find the old key rather than forcing past it.

---

## Rotate these; never rotate that one

Rotate on the move:

- `API_TOKEN` — new random value, and paste it into the UI's Setup screen again
- `RPC_URLS` — a fresh Alchemy key. The old one was rendered into a
  browser-visible error before that was fixed
- `TRACKER_AUTH_TOKEN` — generated fresh by the VPS setup

Never rotate:

- `ACCOUNT_ENCRYPTION_KEY`

---

## Checklist

**Repository**
- [ ] Forked or mirrored to the new account
- [ ] Four `Lipstickmme/NFTmint` URLs rewritten
- [ ] `git remote set-url origin` on your working copy

**VPS**
- [ ] Instance up (Oracle Ampere A1 or equivalent)
- [ ] `docker compose up -d --build` **or** `sudo ./deploy/setup-vps.sh`
- [ ] `/api/health` answers on `127.0.0.1`, and `feedTxSeen` is climbing
- [ ] Reachable over HTTPS via tunnel or Caddy — never bare HTTP
- [ ] Survives a reboot (`sudo reboot`, then check again)

**Vercel**
- [ ] New project imported from the new GitHub account
- [ ] Env vars set, with `ACCOUNT_ENCRYPTION_KEY` **identical** to the old one
- [ ] `TRACKER_UPSTREAM_URL` and `TRACKER_UPSTREAM_TOKEN` set
- [ ] `API_TOKEN` and the RPC key rotated
- [ ] Live board reports `"source": "upstream"` and `"sampledSeconds": 0`
- [ ] `/api/scan` reports the same

**Data**
- [ ] Same Upstash database re-pointed, **or** exported and imported
- [ ] `import` confirmed the encryption key opens the wallets
- [ ] Backup file deleted

**Old account**
- [ ] New deployment verified working before anything is deleted
- [ ] Custom domain moved
- [ ] Old project deleted, so it cannot resume billing

---

## If something goes wrong

**"The tracker at … is not answering."** The Vercel side cannot reach the VPS.
Check the tunnel or Caddy is running, that `TRACKER_UPSTREAM_TOKEN` matches the
VPS's `TRACKER_AUTH_TOKEN` exactly, and that the URL has no trailing path. Test
from your laptop:
`curl -H "Authorization: Bearer <token>" https://tracker.example.com/api/collections?limit=1`

**Health is `ok` but `feedTxSeen` stays 0.** The tracker is up; the sequencer
feed is not reachable from that host. Check `NETWORK` and outbound WebSocket
connectivity.

**Accounts list but cannot sign.** `ACCOUNT_ENCRYPTION_KEY` does not match the
one they were sealed under. Nothing is corrupt — find the old key.

**CPU is still climbing on the new Vercel account.** Check the board's response:
if `"source"` is `"feed"`, the upstream is not being used. Either
`TRACKER_UPSTREAM_URL` is unset, or `TRACKER_UPSTREAM_FALLBACK=true` is masking
an unreachable tracker.

**Oracle says "out of host capacity."** Not your fault and not fixable from your
side. Try another availability domain or region, or upgrade to Pay-As-You-Go —
Always Free resources stay free.
