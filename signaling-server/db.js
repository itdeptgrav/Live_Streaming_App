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
