# TURN via metered.ca (replaces self-hosted coturn)

We use [metered.ca's Open Relay Project](https://www.metered.ca/tools/openrelay/)
for TURN/STUN instead of self-hosting coturn. Free tier: 20GB/month, no
credit card. This removes an entire piece of infrastructure you'd otherwise
have to run and firewall yourself (see `docs/coturn-setup.md`, kept only as a
fallback if you ever outgrow the free 20GB and want to self-host instead).

## Setup

1. Sign up free at [metered.ca](https://www.metered.ca/).
2. In the dashboard, find your app subdomain (`<appname>.metered.live`) and
   API key.
3. Set both as **server-side only** env vars — no `NEXT_PUBLIC_` prefix, so
   the key never reaches the browser:
   ```
   METERED_APP_NAME=<appname>
   METERED_API_KEY=<your-api-key>
   ```
   Locally: `web/.env.local`. On Vercel: project settings → Environment
   Variables.

## How it's wired in

- `web/app/api/turn-credentials/route.js` — a small serverless API route
  that calls metered.ca's REST API server-side and returns the resulting
  `iceServers` array. This is a stateless request/response call, so it's
  perfectly fine on Vercel (unlike the mediasoup/signaling process, which
  isn't).
- `web/lib/webrtcConfig.js` — `getIceServers()` fetches from that route
  (cached after first call) and falls back to public STUN only if metered.ca
  is unreachable or the env vars aren't set.
- Used by: the office-monitor mesh pages (`broadcast`/`watch`) for their
  direct `RTCPeerConnection`s, and the Meet pages for both mediasoup-client
  transports (send + recv).

## What this does and doesn't solve

TURN relays a *client's* traffic when it can't reach a server directly (e.g.
behind a restrictive corporate firewall). It does not host your application
code. The `signaling-server/` process (WebSocket signaling + mediasoup SFU)
still needs its own always-on host with a public IP — see
`docs/deployment.md`. metered.ca only replaces the coturn piece of that
picture.

## If you exceed the free 20GB/month

Either upgrade on metered.ca, or fall back to self-hosted coturn per
`docs/coturn-setup.md` — swap the fetch in `getIceServers()` for your own
TURN credentials at that point.
