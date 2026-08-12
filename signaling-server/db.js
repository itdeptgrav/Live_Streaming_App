// SQLite persistence for the platform layer (accounts, API keys, usage).
// The realtime layer itself stays in-memory — this is only the durable
// bookkeeping that has to survive restarts.
//
// better-sqlite3 is synchronous by design. That is the right call here: every
// query in this file is a single-row lookup or a small insert on a local file,
// so the async ceremony would cost more than the blocking does.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "platform.db"));

// WAL lets the dashboard read while a room writes usage rows without blocking.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

-- Only the hash is stored. The plaintext key is shown once at creation and is
-- unrecoverable afterwards, so a database leak cannot be replayed against the API.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

CREATE TABLE IF NOT EXISTS rooms (
  room_id          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT,
  max_participants INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id);

-- One row per peer session. left_at is NULL while the peer is connected; the
-- duration is derived on read so a crashed server cannot leave a row that
-- inflates usage forever (see reconcileOpenSessions).
CREATE TABLE IF NOT EXISTS usage_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id      TEXT NOT NULL,
  peer_id      TEXT NOT NULL,
  identity     TEXT,
  display_name TEXT,
  joined_at    INTEGER NOT NULL,
  left_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_sessions(user_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_usage_room ON usage_sessions(room_id);
`);

// Additive migrations. SQLite has no "ADD COLUMN IF NOT EXISTS", so each one
// checks the live schema first. Keep them idempotent — this runs on every boot.
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: ${table}.${column}`);
}

// A room is either a screen-monitoring session or a round-table meeting. The
// mode changes what the embed asks the browser for, so it is stored per room
// and copied into every token minted for it.
addColumnIfMissing("rooms", "mode", "TEXT NOT NULL DEFAULT 'meeting'");
// When set, publishers must share a whole display — not a window or a tab.
addColumnIfMissing("rooms", "require_entire_screen", "INTEGER NOT NULL DEFAULT 0");

// Bandwidth actually moved, recorded when a peer disconnects. This is the
// number that maps to the hosting bill, and it cannot be derived from duration
// alone because a paused producer costs nothing.
addColumnIfMissing("usage_sessions", "bytes_sent", "INTEGER");
addColumnIfMissing("usage_sessions", "bytes_received", "INTEGER");

// What the browser reports about its own encoder, sampled periodically.
//
// The server cannot see any of this: which codec was negotiated, whether the
// encoder is hardware, and whether the machine or the network is the
// constraint all live in the client. Without it, diagnosing "it is slow"
// depends on asking someone to read numbers back over chat.
db.exec(`
CREATE TABLE IF NOT EXISTS media_samples (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  room_id        TEXT NOT NULL,
  peer_id        TEXT NOT NULL,
  identity       TEXT,
  at             INTEGER NOT NULL,
  role           TEXT,
  source         TEXT,
  codec          TEXT,
  encoder        TEXT,
  hardware       INTEGER,
  width          INTEGER,
  height         INTEGER,
  fps            REAL,
  kbps           INTEGER,
  limited_by     TEXT,
  frames_sent    INTEGER,
  frames_dropped INTEGER,
  packets_lost   INTEGER,
  rtt_ms         REAL,
  paused         INTEGER,
  watchers       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_samples_user_time ON media_samples(user_id, at);
CREATE INDEX IF NOT EXISTS idx_samples_room ON media_samples(room_id, at);
`);

// Samples arrive every 30s per publisher, so they would grow without bound on
// a 512 MB box. Two weeks is long enough to investigate a complaint and short
// enough to stay small.
export function pruneMediaSamples(days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = db.prepare("DELETE FROM media_samples WHERE at < ?").run(cutoff);
  if (result.changes > 0) console.log(`[db] pruned ${result.changes} media sample(s)`);
}

// Which client library connected, and from what. Without this we cannot tell
// an integrator running a stale cached build from one wired up incorrectly,
// and both look identical from the outside.
addColumnIfMissing("usage_sessions", "client", "TEXT");
addColumnIfMissing("usage_sessions", "client_version", "TEXT");
addColumnIfMissing("usage_sessions", "user_agent", "TEXT");

// Which endpoints a customer's backend actually calls. Counts only — the point
// is to spot an integration using the wrong shape of the API, not to log
// traffic.
db.exec(`
CREATE TABLE IF NOT EXISTS api_calls (
  user_id  TEXT NOT NULL,
  method   TEXT NOT NULL,
  path     TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  last_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, method, path)
);
`);

// Notable things that happened, as opposed to how well they were going.
// Quality samples say a session was healthy; they cannot say a share was
// refused, a connection dropped and recovered, or a picture froze. Those are
// the events people actually report, so they are recorded as events.
db.exec(`
CREATE TABLE IF NOT EXISTS session_events (
  id       TEXT PRIMARY KEY,
  user_id  TEXT NOT NULL,
  room_id  TEXT,
  peer_id  TEXT,
  identity TEXT,
  at       INTEGER NOT NULL,
  level    TEXT NOT NULL,
  type     TEXT NOT NULL,
  code     TEXT,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON session_events(user_id, at);
`);

export function pruneSessionEvents(days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const r = db.prepare("DELETE FROM session_events WHERE at < ?").run(cutoff);
  if (r.changes > 0) console.log(`[db] pruned ${r.changes} session event(s)`);
}

// A hard restart leaves peer rows with left_at NULL and nobody to close them.
// Closing them at boot means "still connected" only ever describes live peers.
export function reconcileOpenSessions() {
  const now = Date.now();
  const result = db
    .prepare("UPDATE usage_sessions SET left_at = ? WHERE left_at IS NULL")
    .run(now);
  if (result.changes > 0) {
    console.log(`[db] closed ${result.changes} orphaned usage session(s) from a previous run`);
  }
}
