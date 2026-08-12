// Query layer over the platform tables. Keeps SQL out of the HTTP handlers.
import { db } from "./db.js";
import { newId, hashPassword, verifyPassword, generateApiKey } from "./auth.js";

// ---------------- users ----------------

export function createUser({ email, password, name }) {
  const normalized = String(email).trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
  if (existing) return { error: "An account with that email already exists" };

  const id = newId("usr");
  db.prepare(
    "INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, normalized, hashPassword(password), String(name).trim(), Date.now());
  return { user: { id, email: normalized, name: String(name).trim() } };
}

export function authenticateUser({ email, password }) {
  const row = db
    .prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?")
    .get(String(email).trim().toLowerCase());
  // Always run a hash comparison so a missing account and a wrong password take
  // comparable time and cannot be distinguished by timing.
  const stored = row?.password_hash || "scrypt$00$00";
  const ok = verifyPassword(password, stored);
  if (!row || !ok) return null;
  return { id: row.id, email: row.email, name: row.name };
}

// ---------------- api keys ----------------

export function listApiKeys(userId) {
  return db
    .prepare(
      `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
         FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId)
    .map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key_prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revoked: Boolean(k.revoked_at),
    }));
}

export function createApiKey(userId, name) {
  const { key, prefix, hash } = generateApiKey();
  const id = newId("key");
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, userId, String(name || "Default").trim(), prefix, hash, Date.now());
  // `key` is returned exactly once — it is not recoverable after this response.
  return { id, name, key, keyPrefix: prefix };
}

export function revokeApiKey(userId, keyId) {
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .run(Date.now(), keyId, userId);
  return result.changes > 0;
}

// ---------------- rooms ----------------

export function recordRoom({ roomId, userId, name, maxParticipants, mode, requireEntireScreen }) {
  db.prepare(
    `INSERT INTO rooms (room_id, user_id, name, max_participants, created_at, mode, require_entire_screen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    roomId,
    userId,
    name || null,
    maxParticipants,
    Date.now(),
    mode || "meeting",
    requireEntireScreen ? 1 : 0
  );
}

export function getRoomOwner(roomId) {
  return db
    .prepare(
      `SELECT user_id, name, ended_at, mode, require_entire_screen, max_participants
         FROM rooms WHERE room_id = ?`
    )
    .get(roomId);
}

export function markRoomEnded(roomId) {
  db.prepare("UPDATE rooms SET ended_at = ? WHERE room_id = ? AND ended_at IS NULL").run(
    Date.now(),
    roomId
  );
}

export function listRoomsForUser(userId, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT r.room_id, r.name, r.created_at, r.ended_at, r.max_participants,
              r.mode, r.require_entire_screen,
              (SELECT COUNT(*) FROM usage_sessions u WHERE u.room_id = r.room_id) AS total_participants
         FROM rooms r WHERE r.user_id = ?
        ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((r) => ({
      roomId: r.room_id,
      name: r.name,
      mode: r.mode || "meeting",
      requireEntireScreen: Boolean(r.require_entire_screen),
      createdAt: r.created_at,
      endedAt: r.ended_at,
      maxParticipants: r.max_participants,
      totalParticipants: r.total_participants,
    }));
}

// ---------------- usage ----------------

export function openUsageSession({
  userId, roomId, peerId, identity, displayName, client, clientVersion, userAgent,
}) {
  const id = newId("use");
  db.prepare(
    `INSERT INTO usage_sessions
       (id, user_id, room_id, peer_id, identity, display_name, joined_at,
        client, client_version, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, userId, roomId, peerId, identity || null, displayName || null, Date.now(),
    client || null, clientVersion || null, (userAgent || "").slice(0, 300) || null
  );
  return id;
}

/** Counts an API call. Aggregated, so the table stays one row per endpoint. */
export function recordApiCall(userId, method, path) {
  db.prepare(
    `INSERT INTO api_calls (user_id, method, path, calls, last_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(user_id, method, path)
     DO UPDATE SET calls = calls + 1, last_at = excluded.last_at`
  ).run(userId, method, path, Date.now());
}

export function closeUsageSession(usageId, { bytesSent = null, bytesReceived = null } = {}) {
  if (!usageId) return;
  db.prepare(
    `UPDATE usage_sessions
        SET left_at = ?, bytes_sent = ?, bytes_received = ?
      WHERE id = ? AND left_at IS NULL`
  ).run(Date.now(), bytesSent, bytesReceived, usageId);
}

// ---------------- media telemetry ----------------

export function recordMediaSample(sample) {
  db.prepare(
    `INSERT INTO media_samples
       (id, user_id, room_id, peer_id, identity, at, role, source, codec, encoder,
        hardware, width, height, fps, kbps, limited_by, frames_sent, frames_dropped,
        packets_lost, rtt_ms, paused, watchers)
     VALUES (@id, @userId, @roomId, @peerId, @identity, @at, @role, @source, @codec,
             @encoder, @hardware, @width, @height, @fps, @kbps, @limitedBy,
             @framesSent, @framesDropped, @packetsLost, @rttMs, @paused, @watchers)`
  ).run({
    id: newId("smp"),
    at: Date.now(),
    userId: sample.userId,
    roomId: sample.roomId,
    peerId: sample.peerId,
    identity: sample.identity ?? null,
    role: sample.role ?? null,
    source: sample.source ?? null,
    codec: sample.codec ?? null,
    encoder: sample.encoder ?? null,
    hardware: sample.hardware == null ? null : sample.hardware ? 1 : 0,
    width: sample.width ?? null,
    height: sample.height ?? null,
    fps: sample.fps ?? null,
    kbps: sample.kbps ?? null,
    limitedBy: sample.limitedBy ?? null,
    framesSent: sample.framesSent ?? null,
    framesDropped: sample.framesDropped ?? null,
    packetsLost: sample.packetsLost ?? null,
    rttMs: sample.rttMs ?? null,
    paused: sample.paused ? 1 : 0,
    watchers: sample.watchers ?? null,
  });
}

/**
 * The picture that answers "why is it slow": which codecs are in play, how
 * often machines rather than networks are the constraint, and how much data
 * actually moved.
 */
export function analyticsSummary(userId, { sinceMs } = {}) {
  const since = sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;

  const codecs = db
    .prepare(
      `SELECT COALESCE(codec, 'unknown') AS codec,
              COALESCE(encoder, 'unknown') AS encoder,
              SUM(CASE WHEN hardware = 1 THEN 1 ELSE 0 END) AS hardware_samples,
              COUNT(*) AS samples,
              COUNT(DISTINCT peer_id) AS peers
         FROM media_samples
        WHERE user_id = ? AND at >= ?
        GROUP BY codec, encoder
        ORDER BY samples DESC`
    )
    .all(userId, since);

  const limits = db
    .prepare(
      `SELECT COALESCE(limited_by, 'unknown') AS reason, COUNT(*) AS samples
         FROM media_samples
        WHERE user_id = ? AND at >= ?
        GROUP BY reason ORDER BY samples DESC`
    )
    .all(userId, since);

  const quality = db
    .prepare(
      `SELECT ROUND(AVG(fps), 1) AS avg_fps,
              ROUND(AVG(kbps)) AS avg_kbps,
              MAX(width || 'x' || height) AS max_resolution,
              SUM(frames_dropped) AS frames_dropped,
              SUM(packets_lost) AS packets_lost,
              ROUND(AVG(rtt_ms)) AS avg_rtt_ms,
              SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END) AS idle_samples,
              COUNT(*) AS samples
         FROM media_samples
        WHERE user_id = ? AND at >= ?`
    )
    .get(userId, since);

  const bandwidth = db
    .prepare(
      `SELECT COALESCE(SUM(bytes_sent), 0) AS bytes_sent,
              COALESCE(SUM(bytes_received), 0) AS bytes_received
         FROM usage_sessions
        WHERE user_id = ? AND joined_at >= ?`
    )
    .get(userId, since);

  return {
    since,
    codecs: codecs.map((c) => ({
      codec: c.codec,
      encoder: c.encoder,
      // Software encoding is the usual explanation for a pinned CPU, so it is
      // called out rather than left to be inferred from the encoder name.
      hardware: c.hardware_samples > 0,
      samples: c.samples,
      peers: c.peers,
    })),
    limitedBy: Object.fromEntries(limits.map((l) => [l.reason, l.samples])),
    quality: {
      avgFps: quality.avg_fps,
      avgKbps: quality.avg_kbps,
      maxResolution: quality.max_resolution,
      framesDropped: quality.frames_dropped,
      packetsLost: quality.packets_lost,
      avgRttMs: quality.avg_rtt_ms,
      // How much of the time publishers were idle because nobody was watching.
      idleShare: quality.samples ? Math.round((quality.idle_samples / quality.samples) * 100) : 0,
      samples: quality.samples,
    },
    bandwidth: {
      bytesSent: bandwidth.bytes_sent,
      bytesReceived: bandwidth.bytes_received,
      gbSent: +(bandwidth.bytes_sent / 1e9).toFixed(2),
      gbReceived: +(bandwidth.bytes_received / 1e9).toFixed(2),
    },
  };
}

/** Most recent sample per peer — what each machine is doing right now. */
export function latestSamplesForRoom(roomId, limit = 50) {
  return db
    .prepare(
      `SELECT peer_id, identity, at, source, codec, encoder, hardware, width, height,
              fps, kbps, limited_by, frames_dropped, packets_lost, rtt_ms, paused, watchers
         FROM media_samples m
        WHERE room_id = ?
          AND at = (SELECT MAX(at) FROM media_samples WHERE peer_id = m.peer_id)
        ORDER BY at DESC LIMIT ?`
    )
    .all(roomId, limit)
    .map((r) => ({
      peerId: r.peer_id,
      identity: r.identity,
      at: r.at,
      source: r.source,
      codec: r.codec,
      encoder: r.encoder,
      hardware: r.hardware === null ? null : Boolean(r.hardware),
      resolution: r.width && r.height ? `${r.width}x${r.height}` : null,
      fps: r.fps,
      kbps: r.kbps,
      limitedBy: r.limited_by,
      framesDropped: r.frames_dropped,
      packetsLost: r.packets_lost,
      rttMs: r.rtt_ms,
      paused: Boolean(r.paused),
      watchers: r.watchers,
    }));
}

/**
 * Usage rollup for the dashboard. Participant-minutes is the billable unit:
 * one person connected for one minute. Still-connected peers are measured up
 * to now so the number moves live rather than only on disconnect.
 */
export function usageSummary(userId, { sinceMs } = {}) {
  const since = sinceMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                          AS sessions,
         COUNT(DISTINCT room_id)           AS rooms,
         COALESCE(SUM(COALESCE(left_at, ?) - joined_at), 0) AS total_ms
       FROM usage_sessions
       WHERE user_id = ? AND joined_at >= ?`
    )
    .get(Date.now(), userId, since);

  const live = db
    .prepare(
      "SELECT COUNT(*) AS n FROM usage_sessions WHERE user_id = ? AND left_at IS NULL"
    )
    .get(userId);

  return {
    sessions: row.sessions,
    rooms: row.rooms,
    participantMinutes: Math.round(row.total_ms / 60000),
    liveParticipants: live.n,
    since,
  };
}

/** Per-day participant-minutes, oldest first — drives the dashboard chart. */
export function usageDaily(userId, days = 14) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT date(joined_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS sessions,
              COALESCE(SUM(COALESCE(left_at, ?) - joined_at), 0) AS total_ms
         FROM usage_sessions
        WHERE user_id = ? AND joined_at >= ?
        GROUP BY day ORDER BY day ASC`
    )
    .all(Date.now(), userId, since);

  return rows.map((r) => ({
    day: r.day,
    sessions: r.sessions,
    participantMinutes: Math.round(r.total_ms / 60000),
  }));
}

/**
 * Per-machine rollup, worst first.
 *
 * The actionable view: a fleet-wide average hides the three laptops encoding
 * in software while everything else is fine, and those three are the whole
 * problem.
 */
export function peerBreakdown(userId, { sinceMs, limit = 100 } = {}) {
  const since = sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  return db
    .prepare(
      `SELECT identity,
              COUNT(*)                                        AS samples,
              MAX(at)                                         AS last_seen,
              MAX(room_id)                                    AS room_id,
              ROUND(AVG(fps), 1)                              AS avg_fps,
              ROUND(AVG(kbps))                                AS avg_kbps,
              MAX(width || 'x' || height)                     AS resolution,
              SUM(frames_dropped)                             AS frames_dropped,
              SUM(packets_lost)                               AS packets_lost,
              ROUND(AVG(rtt_ms))                              AS avg_rtt_ms,
              SUM(CASE WHEN hardware = 0 THEN 1 ELSE 0 END)   AS software_samples,
              SUM(CASE WHEN limited_by = 'cpu' THEN 1 ELSE 0 END) AS cpu_limited,
              SUM(CASE WHEN limited_by = 'bandwidth' THEN 1 ELSE 0 END) AS bw_limited,
              SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END)     AS idle_samples,
              MAX(codec)                                      AS codec,
              MAX(encoder)                                    AS encoder
         FROM media_samples
        WHERE user_id = ? AND at >= ? AND identity IS NOT NULL
        GROUP BY identity
        ORDER BY cpu_limited DESC, software_samples DESC, frames_dropped DESC
        LIMIT ?`
    )
    .all(userId, since, limit)
    .map((r) => ({
      identity: r.identity,
      roomId: r.room_id,
      samples: r.samples,
      lastSeen: r.last_seen,
      codec: r.codec,
      encoder: r.encoder,
      resolution: r.resolution,
      avgFps: r.avg_fps,
      avgKbps: r.avg_kbps,
      framesDropped: r.frames_dropped,
      packetsLost: r.packets_lost,
      avgRttMs: r.avg_rtt_ms,
      // Percentages rather than raw counts, so machines seen for different
      // lengths of time can be compared directly.
      softwarePct: pct(r.software_samples, r.samples),
      cpuLimitedPct: pct(r.cpu_limited, r.samples),
      bandwidthLimitedPct: pct(r.bw_limited, r.samples),
      idlePct: pct(r.idle_samples, r.samples),
    }));
}

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

/** Hourly series for charting. Gaps are real: nobody was sharing. */
export function analyticsTimeline(userId, { sinceMs, hours = 24 } = {}) {
  const since = sinceMs ?? Date.now() - hours * 3600_000;
  return db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:00', at / 1000, 'unixepoch') AS hour,
              COUNT(*)                    AS samples,
              COUNT(DISTINCT peer_id)     AS peers,
              ROUND(AVG(fps), 1)          AS avg_fps,
              ROUND(AVG(kbps))            AS avg_kbps,
              SUM(frames_dropped)         AS frames_dropped,
              SUM(CASE WHEN limited_by = 'cpu' THEN 1 ELSE 0 END) AS cpu_limited,
              SUM(CASE WHEN paused = 1 THEN 1 ELSE 0 END)         AS idle
         FROM media_samples
        WHERE user_id = ? AND at >= ?
        GROUP BY hour ORDER BY hour ASC`
    )
    .all(userId, since)
    .map((r) => ({
      hour: r.hour,
      samples: r.samples,
      peers: r.peers,
      avgFps: r.avg_fps,
      avgKbps: r.avg_kbps,
      framesDropped: r.frames_dropped,
      cpuLimited: r.cpu_limited,
      idle: r.idle,
    }));
}

/** Bandwidth per day, for billing sanity. */
export function bandwidthDaily(userId, days = 14) {
  const since = Date.now() - days * 86400_000;
  return db
    .prepare(
      `SELECT date(joined_at / 1000, 'unixepoch') AS day,
              COALESCE(SUM(bytes_sent), 0)     AS bytes_sent,
              COALESCE(SUM(bytes_received), 0) AS bytes_received,
              COUNT(*)                          AS sessions
         FROM usage_sessions
        WHERE user_id = ? AND joined_at >= ?
        GROUP BY day ORDER BY day ASC`
    )
    .all(userId, since)
    .map((r) => ({
      day: r.day,
      gbSent: +(r.bytes_sent / 1e9).toFixed(3),
      gbReceived: +(r.bytes_received / 1e9).toFixed(3),
      sessions: r.sessions,
    }));
}

/**
 * What the integration actually looks like from our side, and what is wrong
 * with it.
 *
 * Exists because a customer can do everything on their side "correctly" against
 * the wrong shape of the API, and from the outside that is indistinguishable
 * from the platform being at fault. Guessing costs a round trip each time.
 */
export function integrationReport(userId, { sinceMs } = {}) {
  const since = sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;

  const clients = db
    .prepare(
      `SELECT COALESCE(client, 'unknown')         AS client,
              COALESCE(client_version, 'unknown') AS version,
              COUNT(*)                            AS sessions,
              MAX(joined_at)                      AS last_seen
         FROM usage_sessions
        WHERE user_id = ? AND joined_at >= ?
        GROUP BY client, version
        -- Most recent first, not most numerous. Sorting by count buries the
        -- client actually in use behind a pile of historical sessions from
        -- before client reporting existed, which reads as "still broken".
        ORDER BY last_seen DESC`
    )
    .all(userId, since);

  const browsers = db
    .prepare(
      `SELECT user_agent, COUNT(*) AS sessions
         FROM usage_sessions
        WHERE user_id = ? AND joined_at >= ? AND user_agent IS NOT NULL
        GROUP BY user_agent ORDER BY sessions DESC LIMIT 20`
    )
    .all(userId, since)
    .map((r) => ({ browser: describeBrowser(r.user_agent), sessions: r.sessions }));

  const endpoints = db
    .prepare(
      `SELECT method, path, calls, last_at FROM api_calls
        WHERE user_id = ? ORDER BY calls DESC`
    )
    .all(userId)
    .map((r) => ({ method: r.method, path: r.path, calls: r.calls, lastAt: r.last_at }));

  const rooms = db
    .prepare(
      `SELECT COALESCE(mode, 'meeting') AS mode,
              SUM(CASE WHEN require_entire_screen = 1 THEN 1 ELSE 0 END) AS strict,
              COUNT(*) AS rooms
         FROM rooms WHERE user_id = ? GROUP BY mode`
    )
    .all(userId);

  // Publishers reached through the iframe rather than the SDK. Legal, but it
  // means their users click twice to start a share.
  const iframePublishers = db
    .prepare(
      `SELECT COUNT(DISTINCT u.identity) AS n
         FROM usage_sessions u
         JOIN media_samples m ON m.peer_id = u.peer_id
        WHERE u.user_id = ? AND u.joined_at >= ?
          AND COALESCE(u.client, '') = 'embed' AND m.source = 'screen'`
    )
    .get(userId, since);

  return {
    since,
    clients,
    browsers,
    endpoints,
    rooms: Object.fromEntries(rooms.map((r) => [r.mode, { rooms: r.rooms, strict: r.strict }])),
    findings: diagnose({ clients, endpoints, rooms, iframePublishers: iframePublishers?.n || 0 }),
  };
}

/** Turns the raw picture into specific, actionable advice. */
function diagnose({ clients, endpoints, rooms, iframePublishers }) {
  const out = [];
  const called = (method, match) =>
    endpoints.some((e) => e.method === method && e.path.includes(match));
  const seen = (name) => clients.some((c) => c.client === name && c.sessions > 0);

  if (clients.length === 0) {
    out.push({
      level: "info",
      title: "Nothing has connected yet",
      detail: "No participant has joined a room in this window, so there is nothing to assess.",
    });
    return out;
  }

  // Refuse to pass judgement without evidence. Sessions that predate client
  // identification, or a frontend that has not picked it up, both look like
  // "unknown" — and reporting "looks correct" from no data is worse than
  // reporting nothing, because it stops someone looking.
  const identified = clients.filter((c) => c.client !== "unknown");
  const unknownSessions = clients
    .filter((c) => c.client === "unknown")
    .reduce((sum, c) => sum + c.sessions, 0);

  if (identified.length > 0) {
    const current = identified[0];
    out.push({
      level: "ok",
      title: `Currently running ${current.client} ${current.version}`,
      detail:
        `Most recent session was ${current.client} ${current.version}.` +
        (unknownSessions
          ? ` The ${unknownSessions} session(s) listed as unknown are older ones from before ` +
            "clients reported themselves, and will age out of this window."
          : ""),
    });
  }

  if (identified.length === 0) {
    out.push({
      level: "info",
      title: "No client has identified itself yet",
      detail:
        `All ${unknownSessions} session(s) in this window predate client reporting, or are running a ` +
        "cached build. Nothing here can tell an SDK integration from an iframe one until a fresh " +
        "session connects — reload the sharing page and share again.",
    });
    // Everything below reasons about which client was used, so stop here
    // rather than guess.
    return out.concat(endpointFindings({ endpoints, rooms }));
  }

  if (iframePublishers > 0) {
    out.push({
      level: "warn",
      title: `${iframePublishers} publisher${iframePublishers === 1 ? "" : "s"} shared through the iframe`,
      detail:
        "The iframe cannot open the screen picker from your own button, so those users have to " +
        "click twice. Use the publisher SDK for the person sharing and keep the iframe for people " +
        "watching. See /docs/publisher-prompt.txt.",
    });
  }

  if (seen("sdk")) {
    const versions = clients.filter((c) => c.client === "sdk").map((c) => c.version);
    if (new Set(versions).size > 1) {
      out.push({
        level: "warn",
        title: "More than one SDK version is in use",
        detail:
          `Seen: ${[...new Set(versions)].join(", ")}. Older builds are usually a cached copy of ` +
          "grav-stream.js. A hard refresh, or a cache-busting query on the script tag, clears it.",
      });
    }
  }

  const rest = endpointFindings({ endpoints, rooms });
  const all = out.concat(rest);
  if (all.every((f) => f.level === "ok" || f.level === "info")) {
    all.unshift({
      level: "ok",
      title: "The integration looks correct",
      detail: "Clients, endpoints and room modes are all consistent with the documented approach.",
    });
  }
  return all;
}

/** Checks that hold regardless of which client library was used. */
function endpointFindings({ endpoints, rooms }) {
  const out = [];
  const called = (method, match) =>
    endpoints.some((e) => e.method === method && e.path.includes(match));

  if (!called("POST", "/tokens")) {
    out.push({
      level: "error",
      title: "No room tokens have been minted",
      detail:
        "Participants cannot join a room without a token from POST /api/v1/rooms/:roomId/tokens. " +
        "If joins are working anyway, they are using rooms created outside the v1 API.",
    });
  }

  const meeting = rooms.find((r) => r.mode === "meeting");
  const screen = rooms.find((r) => r.mode === "screen");
  const meetingRooms = meeting?.rooms || 0;
  const screenRooms = screen?.rooms || 0;

  // Worth surfacing because it is a deliberate policy with a visible cost: the
  // share is refused outright rather than reported and allowed.
  if (screenRooms > 0 && screen.strict === screenRooms) {
    out.push({
      level: "info",
      title: "Every screen room refuses anything but a whole display",
      detail:
        `All ${screenRooms} screen room(s) set requireEntireScreen: true, so picking a window or a ` +
        "tab fails with ENTIRE_SCREEN_REQUIRED and no share starts. Pass false to accept any " +
        "surface and be told which one was chosen, then apply your own rule.",
    });
  }

  if (meetingRooms > 0 && screenRooms === 0) {
    out.push({
      level: "warn",
      title: "Every room is a meeting room",
      detail:
        'Screen monitoring should create rooms with mode "screen". A meeting room asks the sharer ' +
        "for a camera and microphone they do not need, and shows a meeting interface.",
    });
  }

  if (!called("GET", "/rooms/")) {
    out.push({
      level: "info",
      title: "Room status is never polled",
      detail:
        "GET /api/v1/rooms/:roomId reports who is connected and which surface they picked. Worth " +
        "polling if you want to show live monitoring state in your own product.",
    });
  }

  return out;
}

/** Just enough of a user agent to be useful, without storing a fingerprint. */
function describeBrowser(ua = "") {
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Unknown";
  const version = ua.match(/(?:Edg|OPR|Firefox|Chrome|Version)\/(\d+)/)?.[1];
  const os =
    /Windows NT 10/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Android/.test(ua) ? "Android"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown OS";
  return `${browser}${version ? " " + version : ""} · ${os}`;
}
