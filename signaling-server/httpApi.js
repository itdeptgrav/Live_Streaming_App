// HTTP surface of the platform: dashboard endpoints (session-authenticated)
// and the public v1 API (API-key authenticated) that customer backends call.
//
// Deliberately hand-rolled rather than Express — the route table is small and
// the server otherwise has no framework dependency.
import {
  createSession,
  destroySession,
  userForSessionToken,
  userForApiKey,
  createRoomToken,
} from "./auth.js";
import {
  createUser,
  authenticateUser,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  recordRoom,
  getRoomOwner,
  markRoomEnded,
  listRoomsForUser,
  usageSummary,
  usageDaily,
  analyticsSummary,
  latestSamplesForRoom,
  peerBreakdown,
  analyticsTimeline,
  bandwidthDaily,
} from "./platformStore.js";
import {
  generateRoomId,
  createMeetRoomRecord,
  getMeetRoom,
  meetRoomInfo,
  closeMeetRoom,
} from "./meetRooms.js";
import { MAX_MEET_PARTICIPANTS } from "./mediasoupConfig.js";

const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function requireUser(req, res) {
  const user = userForSessionToken(bearer(req));
  if (!user) {
    json(res, 401, { error: "Not authenticated" });
    return null;
  }
  return user;
}

function requireApiKey(req, res) {
  const user = userForApiKey(bearer(req));
  if (!user) {
    json(res, 401, { error: "Invalid or revoked API key" });
    return null;
  }
  return user;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Flattens a live peer into the shape the API exposes. `sharing` is the part
 * a monitoring dashboard actually cares about: whether a screen is live right
 * now and, for screen tracks, which surface the user picked.
 */
function describePeer([peerId, peer]) {
  const producers = [...peer.producers.values()];
  const screen = producers.find((p) => p.appData?.source === "screen");
  return {
    peerId,
    identity: peer.identity,
    name: peer.displayName,
    role: peer.canPublish === false ? "viewer" : "publisher",
    joinedAt: peer.joinedAt,
    sharing: {
      screen: screen
        ? {
            displaySurface: screen.appData.displaySurface || null,
            width: screen.appData.width || null,
            height: screen.appData.height || null,
            startedAt: screen.appData.startedAt || null,
          }
        : null,
      camera: producers.some((p) => p.appData?.source === "camera"),
      mic: producers.some((p) => p.appData?.source === "mic"),
    },
    // Live on/off state, which is separate from whether a track exists: a
    // muted mic still has a producer.
    media: peer.mediaState || { mic: false, camera: false, screen: Boolean(screen) },
  };
}

/**
 * Handles a request if it matches a known route.
 * Returns true when handled, false to let the caller 404.
 */
export async function handleApiRequest(req, res, { publicUrl }) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const method = req.method;

  // ---------------- auth ----------------

  if (method === "POST" && p === "/api/auth/signup") {
    const body = await readJsonBody(req);
    const { email, password, name } = body;
    if (!EMAIL_RE.test(String(email || ""))) return json(res, 400, { error: "A valid email is required" }), true;
    if (String(password || "").length < 8)
      return json(res, 400, { error: "Password must be at least 8 characters" }), true;
    if (!String(name || "").trim()) return json(res, 400, { error: "Name is required" }), true;

    const result = createUser({ email, password, name });
    if (result.error) return json(res, 409, { error: result.error }), true;
    const token = createSession(result.user.id);
    return json(res, 201, { token, user: result.user }), true;
  }

  if (method === "POST" && p === "/api/auth/login") {
    const { email, password } = await readJsonBody(req);
    const user = authenticateUser({ email: email || "", password: password || "" });
    if (!user) return json(res, 401, { error: "Incorrect email or password" }), true;
    return json(res, 200, { token: createSession(user.id), user }), true;
  }

  if (method === "POST" && p === "/api/auth/logout") {
    destroySession(bearer(req));
    return json(res, 200, { ok: true }), true;
  }

  if (method === "GET" && p === "/api/auth/me") {
    const user = requireUser(req, res);
    if (!user) return true;
    return json(res, 200, { user }), true;
  }

  // ---------------- dashboard: api keys ----------------

  if (p === "/api/keys" && (method === "GET" || method === "POST")) {
    const user = requireUser(req, res);
    if (!user) return true;
    if (method === "GET") return json(res, 200, { keys: listApiKeys(user.id) }), true;
    const { name } = await readJsonBody(req);
    return json(res, 201, createApiKey(user.id, name)), true;
  }

  const keyMatch = p.match(/^\/api\/keys\/([\w-]+)$/);
  if (keyMatch && method === "DELETE") {
    const user = requireUser(req, res);
    if (!user) return true;
    const ok = revokeApiKey(user.id, keyMatch[1]);
    return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Key not found" }), true;
  }

  // ---------------- dashboard: usage & rooms ----------------

  if (method === "GET" && p === "/api/dashboard/usage") {
    const user = requireUser(req, res);
    if (!user) return true;
    return json(res, 200, { summary: usageSummary(user.id), daily: usageDaily(user.id) }), true;
  }

  if (method === "GET" && p === "/api/dashboard/rooms") {
    const user = requireUser(req, res);
    if (!user) return true;
    const rooms = listRoomsForUser(user.id).map((r) => {
      const liveRoom = getMeetRoom(r.roomId);
      const count = liveRoom ? liveRoom.peers.size : 0;
      return { ...r, live: count > 0, participantCount: count };
    });
    return json(res, 200, { rooms }), true;
  }

  // ---------------- public API v1 (API key) ----------------

  if (p === "/api/v1/rooms" && (method === "POST" || method === "GET")) {
    const user = requireApiKey(req, res);
    if (!user) return true;

    if (method === "GET") {
      const rooms = listRoomsForUser(user.id).map((r) => {
        const liveRoom = getMeetRoom(r.roomId);
        const count = liveRoom ? liveRoom.peers.size : 0;
        return { ...r, live: count > 0, participantCount: count };
      });
      return json(res, 200, { rooms }), true;
    }

    const body = await readJsonBody(req);
    const { name, maxParticipants } = body;

    const mode = body.mode || "meeting";
    if (!["meeting", "screen"].includes(mode))
      return json(res, 400, { error: 'mode must be "meeting" or "screen"' }), true;

    // Off unless asked for. The platform's job is to report which surface was
    // picked; deciding whether that is acceptable belongs to the product built
    // on top, which knows its own policy. Opt in with requireEntireScreen: true
    // to have the SFU refuse anything that is not a whole display.
    const requireEntireScreen = Boolean(body.requireEntireScreen);

    const cap = Math.min(Number(maxParticipants) || MAX_MEET_PARTICIPANTS, MAX_MEET_PARTICIPANTS);
    const roomId = generateRoomId();
    createMeetRoomRecord(roomId, {
      maxParticipants: cap,
      ownerUserId: user.id,
      mode,
      requireEntireScreen,
    });
    recordRoom({ roomId, userId: user.id, name, maxParticipants: cap, mode, requireEntireScreen });
    return (
      json(res, 201, {
        roomId,
        name: name || null,
        mode,
        requireEntireScreen,
        maxParticipants: cap,
        url: publicUrl,
      }),
      true
    );
  }

  const roomMatch = p.match(/^\/api\/v1\/rooms\/([\w-]+)$/);
  if (roomMatch) {
    const user = requireApiKey(req, res);
    if (!user) return true;
    const roomId = roomMatch[1];
    const owner = getRoomOwner(roomId);
    if (!owner || owner.user_id !== user.id) return json(res, 404, { error: "Room not found" }), true;

    if (method === "GET") {
      const live = getMeetRoom(roomId);
      return (
        json(res, 200, {
          roomId,
          name: owner.name,
          mode: owner.mode || "meeting",
          requireEntireScreen: Boolean(owner.require_entire_screen),
          live: Boolean(live && live.peers.size > 0),
          participantCount: live ? live.peers.size : 0,
          participants: live ? [...live.peers.entries()].map(describePeer) : [],
          // What each machine last reported about its own encoder. Answers
          // "why is this one slow" without asking anybody to read numbers back.
          media: latestSamplesForRoom(roomId),
          endedAt: owner.ended_at,
        }),
        true
      );
    }

    if (method === "DELETE") {
      closeMeetRoom(roomId);
      markRoomEnded(roomId);
      return json(res, 200, { ok: true }), true;
    }
  }

  const tokenMatch = p.match(/^\/api\/v1\/rooms\/([\w-]+)\/tokens$/);
  if (tokenMatch && method === "POST") {
    const user = requireApiKey(req, res);
    if (!user) return true;
    const roomId = tokenMatch[1];
    const owner = getRoomOwner(roomId);
    if (!owner || owner.user_id !== user.id) return json(res, 404, { error: "Room not found" }), true;

    const body = await readJsonBody(req);
    if (!String(body.identity || "").trim())
      return json(res, 400, { error: "identity is required" }), true;

    const role = body.role || (body.canPublish === false ? "viewer" : "publisher");
    if (!["publisher", "viewer"].includes(role))
      return json(res, 400, { error: 'role must be "publisher" or "viewer"' }), true;

    // `role` is the ergonomic knob; canPublish stays the wire-level truth the
    // SFU enforces. An explicit canPublish still wins so older callers work.
    const canPublish = body.canPublish !== undefined ? body.canPublish !== false : role === "publisher";

    const token = createRoomToken({
      roomId,
      identity: String(body.identity).trim(),
      name: String(body.name || body.identity).trim(),
      canPublish,
      canSubscribe: body.canSubscribe !== false,
      ttlSeconds: Math.min(Number(body.ttlSeconds) || 6 * 60 * 60, 24 * 60 * 60),
      userId: user.id,
      role,
      mode: owner.mode || "meeting",
      requireEntireScreen: Boolean(owner.require_entire_screen),
    });
    return (
      json(res, 200, {
        token,
        url: publicUrl,
        roomId,
        role,
        mode: owner.mode || "meeting",
      }),
      true
    );
  }

  if (method === "GET" && p === "/api/v1/analytics") {
    const user = requireApiKey(req, res);
    if (!user) return true;
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
    const sinceMs = Date.now() - days * 86400000;
    return (
      json(res, 200, {
        days,
        ...analyticsSummary(user.id, { sinceMs }),
        peers: peerBreakdown(user.id, { sinceMs }),
      }),
      true
    );
  }

  if (method === "GET" && p === "/api/dashboard/analytics") {
    const user = requireUser(req, res);
    if (!user) return true;
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 90);
    const sinceMs = Date.now() - days * 86400000;
    return (
      json(res, 200, {
        days,
        ...analyticsSummary(user.id, { sinceMs }),
        peers: peerBreakdown(user.id, { sinceMs }),
        timeline: analyticsTimeline(user.id, { sinceMs }),
        bandwidthDaily: bandwidthDaily(user.id, days),
      }),
      true
    );
  }

  if (method === "GET" && p === "/api/v1/usage") {
    const user = requireApiKey(req, res);
    if (!user) return true;
    return json(res, 200, { summary: usageSummary(user.id), daily: usageDaily(user.id) }), true;
  }

  // ---------------- legacy: unauthenticated demo rooms ----------------
  // Kept so the original /meet pages keep working. These rooms have no owner
  // and therefore accrue no usage and accept tokenless joins.

  if (method === "POST" && p === "/api/meet-rooms") {
    const roomId = generateRoomId();
    createMeetRoomRecord(roomId);
    return json(res, 201, { roomId }), true;
  }

  const legacyInfo = p.match(/^\/api\/meet-rooms\/([\w-]+)$/);
  if (legacyInfo && method === "GET") {
    const info = meetRoomInfo(legacyInfo[1]);
    return json(res, info ? 200 : 404, info || { error: "not found" }), true;
  }

  if (method === "GET" && p === "/healthz") {
    return json(res, 200, { ok: true }), true;
  }

  return false;
}
