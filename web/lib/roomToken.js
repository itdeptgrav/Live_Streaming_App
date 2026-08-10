// Reads the claims out of a room token without verifying them.
//
// This is safe and intentional: the signature is verified by the server on
// join, and nothing here grants access. It exists so the embed can render the
// right interface on the FIRST paint — a viewer must never be shown a
// "share your screen" button, and must never be asked for camera permission.
// The server echoes the authoritative values back in `meet-joined`.
export function readRoomTokenClaims(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return {
      identity: claims.sub || null,
      name: claims.name || null,
      roomId: claims.room || null,
      role: claims.role || (claims.canPublish === false ? "viewer" : "publisher"),
      canPublish: claims.canPublish !== false,
      canSubscribe: claims.canSubscribe !== false,
      mode: claims.mode || "meeting",
      requireEntireScreen: Boolean(claims.requireEntireScreen),
      expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : null,
    };
  } catch {
    return null;
  }
}

/** Human label for a getDisplayMedia surface type. */
export function surfaceLabel(displaySurface) {
  switch (displaySurface) {
    case "monitor":
      return "Entire screen";
    case "window":
      return "Application window";
    case "browser":
      return "Browser tab";
    default:
      return "Unknown surface";
  }
}
