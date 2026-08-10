// Reference integration — pretend this is a customer's product (e.g. cowork).
//
// The point of this app is that it uses NOTHING from the streaming platform
// except the public REST API and the embed URL. No shared code, no SDK, no
// mediasoup, no WebRTC. If this works, a real customer integration works.
//
// The API key lives here on the server and is never sent to the browser. The
// browser only ever receives a short-lived room token.
//
//   node server.js
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 5050;
const API = (process.env.GRAV_API || "http://localhost:4000").replace(/\/$/, "");
const EMBED = (process.env.GRAV_EMBED || "http://localhost:3000").replace(/\/$/, "");
const API_KEY = process.env.GRAV_STREAM_API_KEY;

if (!API_KEY) {
  console.error(
    "GRAV_STREAM_API_KEY is not set.\n" +
      "Create a key at the dashboard (/dashboard/keys), then:\n" +
      "  GRAV_STREAM_API_KEY=gsk_live_... node server.js"
  );
  process.exit(1);
}

const authHeaders = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

/** Thin wrapper that surfaces the platform's error text instead of swallowing it. */
async function callApi(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: authHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Streaming API returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
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

/** Builds the URL the browser will put in its iframe. */
function embedUrl(roomId, token) {
  return `${EMBED}/embed/${roomId}?token=${encodeURIComponent(token)}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // --- Host starts a meeting: create the room, then mint their own token ---
    if (req.method === "POST" && p === "/api/meetings") {
      const { title, displayName } = await readBody(req);

      const room = await callApi("/api/v1/rooms", {
        method: "POST",
        body: { name: title || "Untitled meeting", maxParticipants: 20 },
      });

      const { token } = await callApi(`/api/v1/rooms/${room.roomId}/tokens`, {
        method: "POST",
        body: {
          identity: `host-${Date.now()}`,
          name: displayName || "Host",
        },
      });

      return json(res, 201, {
        roomId: room.roomId,
        title: room.name,
        embedUrl: embedUrl(room.roomId, token),
      });
    }

    // --- Someone else joins an existing meeting: mint a token for them ---
    const joinMatch = p.match(/^\/api\/meetings\/([\w-]+)\/join$/);
    if (req.method === "POST" && joinMatch) {
      const roomId = joinMatch[1];
      const { displayName, viewOnly } = await readBody(req);

      const { token } = await callApi(`/api/v1/rooms/${roomId}/tokens`, {
        method: "POST",
        body: {
          identity: `guest-${Math.random().toString(36).slice(2, 8)}`,
          name: displayName || "Guest",
          // Proves the server-side permission flag: a view-only participant is
          // rejected by the SFU if they try to publish, not merely hidden in UI.
          canPublish: !viewOnly,
        },
      });

      return json(res, 200, { roomId, embedUrl: embedUrl(roomId, token) });
    }

    // --- Live status, polled by the page to show who is actually connected ---
    const infoMatch = p.match(/^\/api\/meetings\/([\w-]+)$/);
    if (req.method === "GET" && infoMatch) {
      return json(res, 200, await callApi(`/api/v1/rooms/${infoMatch[1]}`));
    }

    if (req.method === "DELETE" && infoMatch) {
      return json(res, 200, await callApi(`/api/v1/rooms/${infoMatch[1]}`, { method: "DELETE" }));
    }

    if (req.method === "GET" && p === "/api/usage") {
      return json(res, 200, await callApi("/api/v1/usage"));
    }

    // --- static page ---
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[example] ${req.method} ${p}:`, err.message);
    json(res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Reference integration on http://localhost:${PORT}`);
  console.log(`  streaming API : ${API}`);
  console.log(`  embed origin  : ${EMBED}`);
  console.log(`  api key       : ${API_KEY.slice(0, 16)}…`);
});
