// Credentials, sessions, API keys, and room tokens.
//
// Everything here is built on node:crypto rather than bcrypt/jsonwebtoken so
// the droplet needs no extra native builds. scrypt is a memory-hard KDF (the
// property bcrypt is usually chosen for) and HS256 is ~20 lines of HMAC.
import crypto from "crypto";
import { db } from "./db.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Signs room tokens. Rotating this invalidates every outstanding room token,
// which is the desired behaviour if it ever leaks.
const TOKEN_SECRET = process.env.TOKEN_SECRET;
if (!TOKEN_SECRET) {
  console.warn(
    "[auth] TOKEN_SECRET is not set — generating an ephemeral one. Room tokens " +
      "will be invalidated on every restart. Set TOKEN_SECRET in .env for production."
  );
}
const SIGNING_KEY = TOKEN_SECRET || crypto.randomBytes(32).toString("hex");

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

// ---------------- passwords ----------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  // Lengths always match here, but timingSafeEqual throws if they don't.
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------------- dashboard sessions ----------------

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(newId("sess"), userId, sha256(token), now, now + SESSION_TTL_MS);
  return token;
}

export function userForSessionToken(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.created_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, createdAt: row.created_at };
}

export function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

// ---------------- API keys ----------------

// Format: gsk_live_<32 bytes base64url>. The prefix is stored in the clear so
// the dashboard can show "gsk_live_abcd…" next to each key for identification.
export function generateApiKey() {
  const secret = crypto.randomBytes(24).toString("base64url");
  const key = `gsk_live_${secret}`;
  return { key, prefix: key.slice(0, 16), hash: sha256(key) };
}

export function userForApiKey(key) {
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT k.id AS key_id, u.id, u.email, u.name
         FROM api_keys k JOIN users u ON u.id = k.user_id
        WHERE k.key_hash = ? AND k.revoked_at IS NULL`
    )
    .get(sha256(key));
  if (!row) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.key_id);
  return { id: row.id, email: row.email, name: row.name, apiKeyId: row.key_id };
}

// ---------------- room tokens (HS256 JWT) ----------------

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(data) {
  return crypto.createHmac("sha256", SIGNING_KEY).update(data).digest("base64url");
}

/**
 * Mints a room token. This is what a customer's backend hands to their end
 * user; the browser presents it on meet-join and never sees the API key.
 */
export function createRoomToken({ roomId, identity, name, canPublish = true, canSubscribe = true, ttlSeconds = 6 * 60 * 60, userId }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: identity,
      name,
      room: roomId,
      owner: userId,
      canPublish,
      canSubscribe,
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  const body = `${header}.${payload}`;
  return `${body}.${sign(body)}`;
}

/** Returns the payload, or null if the token is malformed, forged, or expired. */
export function verifyRoomToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
