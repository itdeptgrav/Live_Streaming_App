// Browser client for the platform API on the realtime server.
//
// The session token is kept in localStorage rather than a cookie so the
// dashboard can live on any origin (live.grav.in, Vercel preview URLs, or
// localhost) without cross-site cookie configuration.
const API_BASE = (process.env.NEXT_PUBLIC_SIGNALING_URL || "").replace(/^ws/, "http");

const TOKEN_KEY = "grav_stream_session";

export function getSessionToken() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSessionToken(token) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Could not reach the streaming server");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---- auth ----
export const signup = (payload) => request("/api/auth/signup", { method: "POST", body: payload, auth: false });
export const login = (payload) => request("/api/auth/login", { method: "POST", body: payload, auth: false });
export const logout = () => request("/api/auth/logout", { method: "POST" });
export const me = () => request("/api/auth/me");

// ---- dashboard ----
export const listKeys = () => request("/api/keys");
export const createKey = (name) => request("/api/keys", { method: "POST", body: { name } });
export const revokeKey = (id) => request(`/api/keys/${id}`, { method: "DELETE" });
export const getUsage = () => request("/api/dashboard/usage");
export const getRooms = () => request("/api/dashboard/rooms");
export const getAnalytics = (days = 7) => request(`/api/dashboard/analytics?days=${days}`);
