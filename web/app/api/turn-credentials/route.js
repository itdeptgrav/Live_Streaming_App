// Server-side only: keeps the metered.ca API key off the client.
// Env vars (set in Vercel project settings, no NEXT_PUBLIC prefix):
//   METERED_APP_NAME  — the subdomain from your metered.ca dashboard, e.g. "myapp" for myapp.metered.live
//   METERED_API_KEY   — your metered.ca API key
const FALLBACK_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export async function GET() {
  const appName = process.env.METERED_APP_NAME;
  const apiKey = process.env.METERED_API_KEY;

  if (!appName || !apiKey) {
    return Response.json(FALLBACK_ICE_SERVERS);
  }

  try {
    const res = await fetch(
      `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`
    );
    if (!res.ok) throw new Error("metered.ca request failed");
    const iceServers = await res.json();
    return Response.json(iceServers);
  } catch {
    return Response.json(FALLBACK_ICE_SERVERS);
  }
}
