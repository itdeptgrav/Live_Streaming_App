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
              (SELECT COUNT(*) FROM usage_sessions u WHERE u.room_id = r.room_id) AS total_participants
         FROM rooms r WHERE r.user_id = ?
        ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(userId, limit)
    .map((r) => ({
      roomId: r.room_id,
      name: r.name,
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

export function closeUsageSession(usageId) {
  if (!usageId) return;
  db.prepare("UPDATE usage_sessions SET left_at = ? WHERE id = ? AND left_at IS NULL").run(
    Date.now(),
    usageId
  );
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
