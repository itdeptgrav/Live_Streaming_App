// Machine-readable export of the integration guide.
//
// Served as plain text so it can be pasted into an AI assistant, or fetched by
// one, to give it the whole picture in a single document. Generated from a
// template here rather than read from INTEGRATION.md because Vercel builds
// only the `web` directory — the repository root is not on disk at runtime.

export const dynamic = "force-static";

const API = "https://stream.grav.in";
const EMBED = "https://live.grav.in";

const DOC = `# Grav Stream — complete integration reference

Self-hosted screen sharing and video. A product integrates with two
server-side REST calls and one iframe. There is no SDK, no npm package, and no
WebRTC code on the consuming side.

- API + signaling: ${API}
- Dashboard + embed UI: ${EMBED}
- Transport: mediasoup SFU over WebRTC; signaling over WebSocket.

## Mental model

    your backend  --API key-->  POST /api/v1/rooms             -> { roomId }
                  --API key-->  POST /api/v1/rooms/:id/tokens  -> { token }
    your frontend ----------->  <iframe src="${EMBED}/embed/:roomId?token=...">
                                        |
                                        v
                                browser <-> ${API} (WebSocket + WebRTC media)

The API key stays on your server and mints short-lived per-user room tokens.
It must never reach the browser.

## Two room modes

| mode      | Use for                                     | Embed behaviour                                   |
|-----------|---------------------------------------------|---------------------------------------------------|
| screen    | Screen monitoring: one shares, others watch | Screen picker only; camera and mic never requested |
| meeting   | Round-table calls                            | Camera + mic, and a screen can also be shared      |

## Two participant roles

Roles are per token, so one room serves both sides.

| role      | Can publish | Devices requested | Typical user      |
|-----------|-------------|-------------------|-------------------|
| publisher | yes         | screen (+ camera/mic in meeting mode) | the employee sharing |
| viewer    | NO          | none at all       | the manager watching |

A viewer joins automatically with no permission prompt. The SFU rejects any
publish attempt from a viewer token, so this is access control, not a UI state.

## Authentication

    Authorization: Bearer gsk_live_xxxxxxxxxxxxxxxxxxxxxxxx

Create keys in the dashboard (${EMBED}/dashboard/keys). The plaintext key is
shown once; only a hash is stored. A lost key must be revoked and replaced.

## REST API

### POST /api/v1/rooms
Request:
    { "name": "Alice - workstation", "mode": "screen", "requireEntireScreen": false, "maxParticipants": 12 }
Response:
    { "roomId": "c42ce8ff", "name": "Alice - workstation", "mode": "screen",
      "requireEntireScreen": false, "maxParticipants": 12, "url": "wss://stream.grav.in" }

Fields:
- mode: "meeting" (default) or "screen".
- requireEntireScreen: default false. When true the SFU refuses any share that
  is not a whole display.
- maxParticipants: clamped to the server ceiling of 30.

Rooms are durable. They survive restarts and periods with nobody connected, so
the roomId can be stored in your own database and reused.

### GET /api/v1/rooms
    { "rooms": [ { "roomId", "name", "mode", "requireEntireScreen", "createdAt",
                   "endedAt", "maxParticipants", "totalParticipants",
                   "live", "participantCount" } ] }

### GET /api/v1/rooms/:roomId
The endpoint a monitoring dashboard polls.

    {
      "roomId": "c42ce8ff",
      "name": "Alice - workstation",
      "mode": "screen",
      "requireEntireScreen": false,
      "live": true,
      "participantCount": 2,
      "participants": [
        {
          "peerId": "...",
          "identity": "employee-42",
          "name": "Alice",
          "role": "publisher",
          "joinedAt": 1786353378689,
          "sharing": {
            "screen": { "displaySurface": "monitor", "width": 1920, "height": 1080,
                        "startedAt": 1786353381020 },
            "camera": false,
            "mic": false
          },
          "media": { "mic": false, "camera": false, "screen": true }
        }
      ],
      "endedAt": null
    }

sharing.screen is present only while a screen is live. displaySurface is the
browser's own report: "monitor" (whole display), "window" (one application
window), "browser" (one tab), or null if the browser will not say.

"live" means at least one participant is connected.

### DELETE /api/v1/rooms/:roomId
    { "ok": true }
Force-ends the room and disconnects everyone. An ended room does not come back.

### POST /api/v1/rooms/:roomId/tokens
Request:
    { "identity": "employee-42", "name": "Alice", "role": "publisher", "ttlSeconds": 21600 }
Response:
    { "token": "eyJhbGciOiJIUzI1NiIs...", "url": "wss://stream.grav.in",
      "roomId": "c42ce8ff", "role": "publisher", "mode": "screen" }

- identity: your stable user id. Required.
- name: display name shown to others.
- role: "publisher" or "viewer".
- canPublish: legacy override; role is the ergonomic form.
- ttlSeconds: default 6 hours, capped at 24.

### GET /api/v1/usage
    { "summary": { "sessions", "rooms", "participantMinutes", "liveParticipants", "since" },
      "daily":   [ { "day": "2026-08-10", "sessions": 12, "participantMinutes": 310 } ] }

Participant-minutes is the billable unit: one person connected for one minute.
Still-connected peers are counted up to the present, so the number moves live.

## Embedding

    <iframe
      src="${EMBED}/embed/ROOM_ID?token=ROOM_TOKEN"
      allow="camera; microphone; display-capture; autoplay"
      style="width:100%;height:100%;border:0"
    ></iframe>

The allow attribute is MANDATORY. Without it the browser silently blocks
camera, microphone and screen capture inside the frame, and the user sees an
error instead of a permission prompt. This is the most common mistake.

There is no lobby. The embed connects as soon as it loads. Viewers go straight
to watching. A publisher in a screen room sees only a share button, because
getDisplayMedia is the one call a browser will not make without a click inside
the frame that calls it.

### Query parameters

| Param        | Values                    | Default        | Effect |
|--------------|---------------------------|----------------|--------|
| token        | required                  | -              | The room token |
| parentOrigin | an origin                 | *              | Restrict postMessage to this origin |
| ui           | full, minimal, bare       | full           | Chrome preset |
| header       | 0 / 1                     | from ui        | Top status bar |
| controls     | 0 / 1                     | from ui        | Bottom button bar |
| participants | 0 / 1                     | from ui        | "N connected" count |
| timer        | 0 / 1                     | from ui        | Elapsed clock |
| theme        | dark, light               | dark           | Colour scheme |
| accent       | hex colour                | #34d399        | Accent, url-encoded e.g. %2300aaff |
| startLabel   | text                      | "Start sharing"| Relabels the start button |
| selfPreview  | 0 / 1                     | 0              | Show the sharer their own screen |

Individual flags override the preset. ui=bare&controls=1 gives buttons only.

In a screen room the shared screen is rendered edge to edge with no borders,
labels or badges, plus a single low-contrast "Grav Stream" mark bottom-right.

selfPreview is off by default: a preview of a whole display, drawn on that
display, is an infinite mirror and occupies the space the person is working in.

## postMessage events (iframe -> host)

Always verify the origin:

    window.addEventListener("message", (event) => {
      if (event.origin !== "${EMBED}") return;
      if (event.data?.source !== "grav-stream") return;
      const { type, ...data } = event.data;
    });

| type                   | payload                                                    | when |
|------------------------|------------------------------------------------------------|------|
| ready                  | { roomId, role, mode }                                     | embed loaded, exactly once |
| joined                 | { peerId, identity, role, mode }                           | connected |
| screen-share-started   | { displaySurface, width, height, frameRate, label, isEntireScreen } | share began |
| screen-share-stopped   | {}                                                         | share ended, including via the browser bar |
| screen-share-cancelled | {}                                                         | picker dismissed |
| media-state            | { mic, camera, screen }                                    | a local device toggled |
| remote-screen-started  | { peerId, displaySurface, width, height }                  | someone else began sharing |
| participant-joined     | { identity, name }                                         | someone joined |
| participant-left       | { peerId }                                                 | someone left |
| left                   | {}                                                         | local user ended the session |
| error                  | { message, code, capture? }                                | see codes |

### Error codes

| code                     | meaning |
|--------------------------|---------|
| ENTIRE_SCREEN_REQUIRED   | A window or tab was picked in a room that demands a whole display |
| SURFACE_UNKNOWN          | The browser will not report the surface, so policy cannot be verified |
| PERMISSION_DENIED        | Blocked by the browser, usually a missing iframe allow attribute |
| EMBED_NOT_VISIBLE        | The iframe is hidden or zero-sized, so no picker can open |
| DEVICE_PERMISSION_DENIED | Camera/mic unavailable in a meeting room |
| SERVER_UNREACHABLE       | Could not reach the streaming server |
| UNKNOWN_TRANSPORT        | Publish arrived for a transport that no longer exists; reconnect |

## postMessage commands (host -> iframe)

    iframeEl.contentWindow.postMessage(
      { source: "grav-stream-parent", type: "stop-screen-share" },
      "${EMBED}"
    );

Types: start-screen-share, stop-screen-share, toggle-screen-share, toggle-mic,
toggle-camera, leave.

IMPORTANT: user activation does not cross a postMessage boundary. A click in
your page cannot open the screen picker inside the iframe, so
start-screen-share and toggle-screen-share cannot reliably START a share — the
user must press the embed's own button. Stop, mute and leave always work.

The embed must also be visible when a share starts. A display:none, zero-sized
or fully covered frame gets no picker; the embed reports EMBED_NOT_VISIBLE.

## Screen selection: reporting versus enforcement

The surface is ALWAYS reported. Whether a non-conforming pick is REFUSED is a
separate per-room choice, off by default.

| | requireEntireScreen: true | requireEntireScreen: false (default) |
|---|---|---|
| Sharing a window or tab | refused by the SFU | allowed |
| displaySurface reported | yes | yes, always |
| Who decides the rule | Grav Stream | your application |

Report-only pattern:

    if (event.data.type === "screen-share-started" && !event.data.isEntireScreen) {
      flagForManager(employee, event.data.displaySurface);
    }

Handle displaySurface: null. With enforcement on it is refused as
SURFACE_UNKNOWN; with enforcement off the share succeeds and you get null.
Treat that as unverified, not compliant. Chrome and Edge report it reliably.

mode and requireEntireScreen are independent. Disabling enforcement does not
turn a screen room back into a meeting.

Why the check is server-side: getDisplayMedia's displaySurface constraint is
only a hint — the picker still lets the user choose anything. So the selection
is verified after capture, and the claimed surface is re-checked by the SFU
before the producer is created. A modified client that lies is still refused.

What it does NOT prove: it guarantees the captured surface is a whole display.
It cannot tell what is on that display, detect a virtual machine or a second
monitor, or stop someone photographing their screen.

## End-to-end example (Node/Express)

    const headers = {
      Authorization: \`Bearer \${process.env.GRAV_STREAM_API_KEY}\`,
      "Content-Type": "application/json",
    };

    async function api(path, body) {
      const res = await fetch(\`${API}\${path}\`, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || \`Grav Stream returned \${res.status}\`);
      return data;
    }

    // One durable room per employee, created once and reused.
    async function ensureRoomFor(employee) {
      if (employee.gravRoomId) return employee.gravRoomId;
      const room = await api("/api/v1/rooms", {
        name: \`\${employee.name} - workstation\`,
        mode: "screen",
        maxParticipants: 10,
      });
      await db.saveGravRoomId(employee.id, room.roomId);
      return room.roomId;
    }

    app.post("/monitoring/go-online", async (req, res) => {
      const roomId = await ensureRoomFor(req.user);
      const { token } = await api(\`/api/v1/rooms/\${roomId}/tokens\`, {
        identity: req.user.id, name: req.user.name, role: "publisher",
        ttlSeconds: 9 * 60 * 60,
      });
      res.json({ roomId, token });
    });

    app.get("/monitoring/:employeeId/watch", async (req, res) => {
      if (!req.user.canMonitor) return res.status(403).json({ error: "Forbidden" });
      const employee = await db.getEmployee(req.params.employeeId);
      const roomId = await ensureRoomFor(employee);
      const { token } = await api(\`/api/v1/rooms/\${roomId}/tokens\`, {
        identity: req.user.id, name: req.user.name, role: "viewer", ttlSeconds: 3600,
      });
      res.json({ roomId, token });
    });

## Migrating from LiveKit

| LiveKit (livekit-server-sdk)      | Grav Stream                         |
|-----------------------------------|-------------------------------------|
| svc.createRoom({ name })          | POST /api/v1/rooms                  |
| svc.listRooms([name])             | GET /api/v1/rooms/:roomId           |
| svc.deleteRoom(name)              | DELETE /api/v1/rooms/:roomId        |
| new AccessToken(...).toJwt()      | POST /api/v1/rooms/:roomId/tokens   |
| grant identity / name             | body identity / name                |
| grant canPublish / canSubscribe   | body role, or canPublish/canSubscribe |
| ttl: "6h"                         | body ttlSeconds: 21600              |

On the client, <LiveKitRoom> + <VideoConference /> and any imperative
new Room().connect() are replaced by the iframe. livekit-client,
@livekit/components-react and @livekit/components-styles can be removed.

## Operational notes

- Media (RTP) flows directly between browsers and the SFU on UDP 40000-49999.
  It does not pass through the HTTP reverse proxy; those ports must be open.
- MEDIASOUP_ANNOUNCED_IP must be the server's public IP or remote participants
  cannot connect.
- TOKEN_SECRET signs room tokens. Rotating it invalidates every outstanding
  token immediately.
- ALLOWED_ORIGINS must list the embed/dashboard origin exactly, no trailing
  slash, or browsers block the API calls.
- Accounts, API keys, rooms and usage live in SQLite under DATA_DIR, outside
  the deploy directory. Live room state is in memory and does not survive a
  restart; rooms themselves are rehydrated from the database on next join.
`;

export async function GET() {
  return new Response(DOC, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
