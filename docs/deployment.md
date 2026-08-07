# Deployment: Vercel (frontend) + your own server (realtime backend)

## Why the split is required, not optional

Vercel runs Next.js as short-lived serverless/edge functions — they don't hold
a persistent process or in-memory state between requests. The realtime server
(`signaling-server/`) needs the opposite: one long-running Node process that
keeps a mediasoup worker, routers, and open WebRTC/WebSocket connections alive
for as long as calls are happening. That process cannot run on Vercel, on any
serverless platform, or as a Vercel Edge Function — this is a hard constraint
of the serverless model, not a configuration issue.

So: `web/` deploys to Vercel. `signaling-server/` deploys to a real,
always-on server you control.

## Where to run the realtime server

It needs three things most free PaaS tiers (Render, Railway, Vercel itself)
don't give you: a public IP, a public **UDP** port range (mediasoup sends RTP
media over UDP directly — it's not just HTTP/WebSocket traffic), and a
process that stays running. TURN itself is handled by metered.ca now (see
`docs/turn-metered.md`), so you no longer need to self-host coturn — but the
mediasoup/signaling process itself still needs one of:

- **Oracle Cloud Free Tier** — genuinely free forever, full VPS with a public
  IP and firewall control. Ideal when available, but Ampere (the capable free
  shape) is often out of capacity in a given region — worth retrying
  periodically or trying other regions.
- **Self-host on a machine you already control** (a spare office PC, or the
  server the office-monitor devices already sit near) — genuinely free, no
  cloud account or card at all. Requires router admin access to port-forward
  the mediasoup UDP range to that machine, plus a free dynamic DNS host
  (DuckDNS/No-IP) since you likely don't have a static public IP. This is a
  good fit here anyway since office-monitor viewers are mostly on the same
  network already.
- **A paid VPS** (DigitalOcean droplet, etc.) — a few dollars/month, if
  neither of the above works out.

## Critical: you need HTTPS/WSS, not HTTP/WS

Once `web/` is on Vercel, it's served over HTTPS. Browsers block a secure
page from opening a plain `ws://` connection (mixed content) — it must be
`wss://`. That means the realtime server needs a TLS certificate.

Simplest path: put [Caddy](https://caddyserver.com/) in front of it — it
gets a free Let's Encrypt certificate automatically for a domain pointed at
your server's IP:

```
# /etc/caddy/Caddyfile
realtime.yourdomain.com {
  reverse_proxy localhost:4000
}
```

`server.js`'s HTTP server (used for both the REST endpoints and the
WebSocket upgrade) sits behind that on port 4000; Caddy handles TLS.

## Running the realtime server as a persistent service

```bash
# on the server, inside signaling-server/
npm install --omit=dev
npm install -g pm2
pm2 start server.js --name realtime
pm2 save
pm2 startup   # follow the printed instructions so it survives reboots
```

## Firewall ports to open

| Port(s)         | Protocol | Purpose                                  |
|------------------|----------|-------------------------------------------|
| 443              | TCP      | Caddy (HTTPS/WSS to the outside world)   |
| 40000–49999      | UDP+TCP  | mediasoup RTP (set via `rtcMinPort`/`rtcMaxPort` in `mediasoupConfig.js`) |

(coturn's ports aren't needed — TURN is metered.ca, hosted for you.)

## Environment variables

**On the realtime server** (`signaling-server/`, e.g. via a `.env` loaded by
pm2 or systemd):

```
MEDIASOUP_ANNOUNCED_IP=<server's public IP>
ALLOWED_ORIGINS=https://your-app.vercel.app
```

**On Vercel** (project settings → Environment Variables):

```
NEXT_PUBLIC_SIGNALING_URL=wss://realtime.yourdomain.com
METERED_APP_NAME=<appname>
METERED_API_KEY=<your-api-key>
```

## After deploying

Test from a device on a different network than the realtime server (e.g.
your phone on mobile data) — that's what actually exercises public
reachability and TURN, unlike testing two tabs on the same laptop.
