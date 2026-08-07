// Static roster of monitored devices/employees. One room per device.
// Add/remove entries here as devices are provisioned — no dynamic room creation for MVP.
export const ROOMS = [
  { id: "device-01", label: "Reception Desk" },
  { id: "device-02", label: "Accounts - Desk 1" },
  { id: "device-03", label: "Accounts - Desk 2" },
  // ...add the rest of the ~20 devices here
];

export const MAX_VIEWERS_PER_ROOM = 3;

export function isKnownRoom(roomId) {
  return ROOMS.some((r) => r.id === roomId);
}
