# Deploying KUMKUM

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

## Part 1 — The server

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

- **No authentication.** Anyone with a room link joins. No password, no waiting
  room, no host controls, no kick. Fine for practice; do not put a client
  meeting on it.
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
