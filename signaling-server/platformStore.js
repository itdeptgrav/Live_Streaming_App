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

export function openUsageSession({ userId, roomId, peerId, identity, displayName }) {
  const id = newId("use");
  db.prepare(
    `INSERT INTO usage_sessions (id, user_id, room_id, peer_id, identity, display_name, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, roomId, peerId, identity || null, displayName || null, Date.now());
  return id;
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
