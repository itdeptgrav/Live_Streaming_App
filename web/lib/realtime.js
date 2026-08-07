export const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL;

export function realtimeHttpBaseUrl() {
  return SIGNALING_URL.replace(/^ws/, "http");
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
