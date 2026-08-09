// One env var, two protocols. Set NEXT_PUBLIC_SIGNALING_URL to either form —
// e.g. "wss://sfu.example.com" or "https://sfu.example.com" — and both the
// WebSocket URL and the REST base URL are derived from it.
//
// A page served over HTTPS (Vercel) MUST end up on wss://. Plain ws:// from an
// https:// page is blocked by the browser as mixed content and the call will
// never connect.
const RAW = (process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:4000").replace(/\/+$/, "");

// http -> ws, https -> wss, ws/wss left alone.
export const SIGNALING_URL = RAW.replace(/^http/, "ws");

// ws -> http, wss -> https, http/https left alone.
export function realtimeHttpBaseUrl() {
  return RAW.replace(/^ws/, "http");
}

export async function createMeetRoom() {
  const res = await fetch(`${realtimeHttpBaseUrl()}/api/meet-rooms`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to create room");
  return res.json(); // { roomId }
}

export async function getMeetRoomInfo(roomId) {
  const res = await fetch(`${realtimeHttpBaseUrl()}/api/meet-rooms/${roomId}`);
  if (!res.ok) return null;
  return res.json(); // { id, participantCount }
}
