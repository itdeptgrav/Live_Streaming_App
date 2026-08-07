// TURN credentials come from metered.ca (free tier, see docs/turn-metered.md) via our
// own /api/turn-credentials route, which keeps the metered.ca API key server-side.
const FALLBACK_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

let cached = null;

export async function getIceServers() {
  if (cached) return cached;
  try {
    const res = await fetch("/api/turn-credentials");
    cached = await res.json();
  } catch {
    cached = FALLBACK_ICE_SERVERS;
  }
  return cached;
}
