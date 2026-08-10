# Deploying Grav Stream

> **Updating an existing droplet.** To ship new server code:
>
> ```bash
> bash /opt/live-streaming-app/signaling-server/deploy/update.sh
> ```
>
> It installs dependencies, backfills any missing `.env` values, and restarts
> pm2. **Database migrations run automatically at boot** and are additive only,
> so accounts, API keys, and usage history survive an update. The database
> lives in `DATA_DIR` (`/var/lib/grav-stream`), outside the deploy directory,
> so re-uploading code cannot reach it. Take a snapshot first once you have
> real users:
>
> ```bash
> sqlite3 /var/lib/grav-stream/platform.db ".backup '/root/platform-$(date +%F).db'"
> ```
>
> Restarting drops anyone connected at that moment; room ids stay valid.

> **Current production deployment (Aug 2026).** The live system runs on a
> **DigitalOcean droplet with Nginx + pm2**, not the Oracle/Caddy/systemd path
> described below:
>
> | Component | Host | Domain |
> |---|---|---|
> | `signaling-server/` | DigitalOcean droplet `157.245.101.63` | `stream.grav.in` |
> | `web/` | Vercel | `live.grav.in` |
>
> Use **[Part 0 — the live setup](#part-0--the-live-setup-digitalocean--nginx--pm2)**
> below for day-to-day deploys. Parts 1–3 remain a valid alternative if you ever
> move to Oracle/Hetzner with Caddy, and the architecture, firewall, and
> troubleshooting sections apply to both.
>
> Note the RTC port range is **40000–49999** (see `mediasoupConfig.js`), not the
> 40000–40100 quoted in the older sections.

Two pieces, two different kinds of host. This is not a preference — it's forced
by how WebRTC works.

| Piece | What it is | Where it goes | Why |
|---|---|---|---|
| `web/` | Next.js frontend | **Vercel** (free) | Static-ish app, no special networking |
| `signaling-server/` | WebSocket signalling + mediasoup SFU | **A VPS with a public IP** | Needs inbound **UDP**, which no PaaS gives you |

**Render, Railway, Vercel and Cloudflare cannot host the signalling server.**
They do not route inbound UDP. mediasoup would start fine, log nothing unusual,
and every call would fail with ICE stuck at `new`. Do not try.

---

## Architecture — what talks to what

```
Browser ──HTTPS──────────────▶ Vercel            (serves the page only)
Browser ──WSS  :443─────────▶ your VPS (Caddy → :4000)   signalling JSON
Browser ──DTLS/SRTP UDP :40000-40100 ─▶ your VPS         the actual audio/video
```

Media never touches Vercel and never goes through Caddy. It's raw UDP straight
to the mediasoup worker, which decrypts each stream, forwards a copy to every
other participant, and re-encrypts. That's why the UDP port range must be open
and why the announced address must be routable.

---

## Part 0 — The live setup (DigitalOcean + Nginx + pm2)

This is what is actually running. It also hosts the **platform layer** —
accounts, API keys, usage metering, and the `/api/v1` REST API documented in
[INTEGRATION.md](INTEGRATION.md).

### 0.1 First-time provision

```bash
scp -r signaling-server root@<ip>:/opt/live-streaming-app/
ssh root@<ip> "cd /opt/live-streaming-app/signaling-server && bash deploy/setup-local-upload.sh stream.grav.in"
```

`deploy/setup-local-upload.sh` installs Node 20, Nginx, certbot, and pm2; issues
the TLS certificate; opens the firewall (SSH, HTTP/HTTPS, UDP+TCP 40000–49999);
generates a `TOKEN_SECRET`; detects the public IP for `MEDIASOUP_ANNOUNCED_IP`;
and starts the service under pm2 with reboot persistence.

### 0.2 Updating an existing droplet

From the project root (PowerShell). **Never copy `node_modules`** — it holds
Windows-built binaries that cannot run on Linux and turns seconds into minutes:

```powershell
scp -r signaling-server/*.js signaling-server/package.json signaling-server/package-lock.json signaling-server/.env.example signaling-server/deploy root@157.245.101.63:/opt/live-streaming-app/signaling-server/
```

Then on the droplet:

```bash
bash /opt/live-streaming-app/signaling-server/deploy/update.sh
```

`update.sh` installs new dependencies, backfills any missing `TOKEN_SECRET` /
`DATA_DIR` in `.env`, restarts pm2, and tails the log.

### 0.3 Environment variables added by the platform layer

On top of `PORT`, `ALLOWED_ORIGINS`, and `MEDIASOUP_ANNOUNCED_IP`:

| Key | Purpose |
|---|---|
| `PUBLIC_URL` | `wss://stream.grav.in` — returned to API clients as `url` |
| `TOKEN_SECRET` | HS256 key signing room tokens. **Rotating it invalidates every outstanding token.** If unset, an ephemeral one is generated per boot and tokens die on restart. |
| `DATA_DIR` | `/var/lib/grav-stream` — SQLite location |

`ALLOWED_ORIGINS` must now be `https://live.grav.in` exactly — no trailing
slash, or the dashboard's API calls fail CORS.

### 0.4 Data

Accounts, API keys, rooms, and usage history live in
`/var/lib/grav-stream/platform.db`. That path is deliberately **outside**
`/opt/live-streaming-app` so re-uploading the app cannot destroy it. Back it up:

```bash
sqlite3 /var/lib/grav-stream/platform.db ".backup '/root/platform-backup.db'"
```

### 0.5 Frontend at `live.grav.in`

Vercel → import repo → **Root Directory `web`** → env vars
(`NEXT_PUBLIC_SIGNALING_URL=wss://stream.grav.in`, plus the metered.ca pair) →
Domains → add `live.grav.in` → add the CNAME Vercel shows to GoDaddy DNS for
`grav.in`.

### 0.6 Verify

```bash
curl https://stream.grav.in/healthz     # → {"ok":true}
```

Then sign up in the dashboard, create an API key, and run the two calls in
INTEGRATION.md. A `roomId` plus a minted token proves the database, signing key,
and API auth are all wired. Opening the embed URL from two networks proves
`MEDIASOUP_ANNOUNCED_IP` and the UDP rules are right.

---

## Part 1 — The server

> Alternative path (Oracle/Hetzner + Caddy + systemd). Not what is running today.

### 1.1 Get a box

**Oracle Cloud Always Free** is the only genuinely free option with real UDP.
Create an **Ampere A1 (ARM)** instance, **2 OCPU / 12 GB**, Ubuntu 24.04.

> Oracle halved the Always Free ARM allowance to 2 OCPU / 12 GB in mid-2026 and
> instances above the limit are being terminated. Provision at 2/12 from the
> start. Capacity in Indian regions is often exhausted — if provisioning fails,
> retry over a few hours or pick a different home region.

If Oracle's capacity lottery wastes your time, a **Hetzner CX22 (~€4/month)** is
the pragmatic alternative and noticeably less painful.

Note the instance's **public IPv4**.

### 1.2 Open the firewall — BOTH of them

This is the step people get wrong, and the failure looks identical to a code
bug. Oracle has two independent firewalls; opening one does nothing.

**(a) Cloud firewall.** OCI console → Networking → VCN → Security List →
*Add Ingress Rules*, source `0.0.0.0/0`:

| Protocol | Port range |
|---|---|
| TCP | 80 |
| TCP | 443 |
| UDP | 40000–40100 |
| TCP | 40000–40100 |

**(b) Host firewall.** Handled by `deploy/setup-server.sh` below. Oracle's Ubuntu
images ship restrictive `iptables` rules that silently drop packets the console
says are allowed.

### 1.3 Point DNS at it

Add an **A record** for a subdomain, e.g. `sfu.yourdomain.com` → the public IP.
Wait for it to resolve (`ping sfu.yourdomain.com`) before continuing, or Caddy's
certificate request will fail.

### 1.4 Provision

SSH in, then:

```bash
git clone <your-repo> ~/kumkum       # or scp the folder up
cd ~/kumkum
bash deploy/setup-server.sh
```

This installs Node 22, build tools, meson/ninja, Caddy, and opens the host
firewall.

### 1.5 Configure and build

```bash
cd ~/kumkum/signaling-server
cp .env.example .env
nano .env
```

Set at minimum:

```ini
PORT=4000
MEDIASOUP_ANNOUNCED_IP=sfu.yourdomain.com
ALLOWED_ORIGINS=*
```

Leave `ALLOWED_ORIGINS=*` for now; tighten it to your Vercel URL once you have it.

```bash
npm install    # compiles the mediasoup worker — 3-5 min on ARM, be patient
```

> The repo contains `prebuilt/mediasoup-worker`, a **Linux x86-64** binary. On
> ARM it is skipped automatically and the locally compiled worker is used. You
> will see a `prebuilt worker unusable on linux/arm64` warning — that is correct
> behaviour, not an error.

### 1.6 Run it under systemd

```bash
sudo cp ~/kumkum/deploy/kumkum-signaling.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kumkum-signaling
sudo journalctl -u kumkum-signaling -f
```

You should see:

```
mediasoup announced address : sfu.yourdomain.com
mediasoup RTC port range    : 40000-40100 (UDP + TCP)
Realtime server listening on 0.0.0.0:4000
```

> The unit assumes user `ubuntu` and path `/home/ubuntu/kumkum`. Edit
> `User=` and `WorkingDirectory=` if yours differ.

### 1.7 HTTPS

```bash
sudo nano /etc/caddy/Caddyfile
```
```
sfu.yourdomain.com {
	reverse_proxy localhost:4000
}
```
```bash
sudo systemctl reload caddy
```

Verify from your laptop:

```bash
curl https://sfu.yourdomain.com/healthz
# {"ok":true,"announcedAddress":"sfu.yourdomain.com","rtcPorts":"40000-40100",...}
```

If `announcedAddress` shows `127.0.0.1` or an internal IP, fix `.env` and
restart — nothing downstream will work until this is right.

---

## Part 2 — The frontend

1. Push the repo to GitHub.
2. Vercel → **New Project** → import it.
3. **Root Directory: `web`** ← easy to miss, and the build fails without it.
4. Environment Variables:

| Key | Value |
|---|---|
| `NEXT_PUBLIC_SIGNALING_URL` | `https://sfu.yourdomain.com` |
| `METERED_APP_NAME` | your metered.ca subdomain *(optional)* |
| `METERED_API_KEY` | your metered.ca key *(optional)* |

5. Deploy.

`NEXT_PUBLIC_SIGNALING_URL` is baked in at build time — changing it later
requires a **redeploy**, not just a restart.

The app accepts `https://` or `wss://` and normalizes internally. It must not be
plain `http://`: an HTTPS page cannot open a `ws://` socket, and the browser
blocks it as mixed content with a console error most people miss.

---

## Part 3 — Lock the origin down

Back on the server, now that you know your Vercel URL:

```bash
nano ~/kumkum/signaling-server/.env
# ALLOWED_ORIGINS=https://your-app.vercel.app
sudo systemctl restart kumkum-signaling
```

---

## Using it

1. Open `https://your-app.vercel.app`
2. **Create a meeting** → you land in `/meet/<roomId>`
3. **Copy link** → send it to anyone
4. They open it, type a name, **Join now**, allow camera/mic
5. **Share screen** works for everyone independently — camera and screen are
   separate streams, so you can share while staying on camera

Rooms survive 30 minutes empty (`EMPTY_ROOM_TTL_MS`), and any valid link
recreates its room on join, so a server restart won't kill links you've already
sent.

---

## Verifying, in order

Check these in sequence. Each depends on the previous one.

| # | Check | Failure means |
|---|---|---|
| 1 | `curl https://sfu.yourdomain.com/healthz` returns JSON | Caddy/DNS/service down |
| 2 | `announcedAddress` is your domain, not `127.0.0.1` | `.env` wrong |
| 3 | Log shows `udp://sfu.yourdomain.com:400xx` on join | announced address wrong |
| 4 | Log shows `ICE -> connected` | **firewall** — you missed one of the two |
| 5 | Log shows `DTLS -> connected` | rare; check TURN config |
| 6 | Remote tiles show `1280x720` not `no frame yet` | codec/keyframe — check browser console |

For anything past step 3, `chrome://webrtc-internals` on the *receiving* tab is
the tool. If **ICE connection state** never leaves `new`, it is always a
firewall or announced-address problem, never application code.

---

## What this is not

- **Authentication depends on how the room was made.** Rooms created through
  `/api/v1/rooms` require a signed room token to join, carry identity from that
  token, and honour `canPublish`. Legacy rooms created via `POST /api/meet-rooms`
  (the `/meet` pages) are still open to anyone with the link. There is still no
  waiting room, host controls, or kick in either mode.
- **Not scaled.** One mediasoup worker, one box. Two ARM cores start dropping
  frames somewhere past 10–15 simultaneous cameras. Screen-share-only calls go
  further.
- **Rooms are in-memory.** They survive restarts only because links recreate
  them; nothing else persists.
- **TURN matters.** Without `METERED_*` set, anyone on a network that blocks UDP
  simply cannot connect. `enableTcp` gives ICE-TCP as a first fallback, TURN
  catches the rest. Get free credentials at metered.ca — a few minutes' work
  that prevents a whole category of "it doesn't work for my colleague".

---

## Troubleshooting

**"Could not reach the realtime server"** — `NEXT_PUBLIC_SIGNALING_URL` wrong,
or you set it after deploying and didn't redeploy. Open DevTools → Network → WS.

**Tiles stuck on `no frame yet`, log shows ICE `new`** — firewall. Confirm both
layers, and confirm the port range in `.env` matches the range you opened.

**`spawn .../prebuilt/mediasoup-worker ENOENT`** — you're on Windows or ARM with
`MEDIASOUP_WORKER_BIN` forced. Unset it and let `npm install` compile the worker.

**Camera permission denied** — the app now joins audio-only rather than failing
outright. Two tabs on one machine can contend for the webcam; that's expected.

**Works on your LAN, fails for a remote user** — almost always TURN. Set the
metered.ca variables and redeploy the frontend.
