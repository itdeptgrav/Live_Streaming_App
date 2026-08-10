# Grav Stream — integration guide

Self-hosted screen sharing and video. Your backend talks to a REST API; your
frontend embeds an iframe. There is no SDK to install and no WebRTC code to
write.

- **API + signaling:** `https://stream.grav.in` (droplet, mediasoup SFU)
- **Dashboard + embed UI:** `https://live.grav.in`

## Two room modes

| Mode | Use it for | What the embed does |
| --- | --- | --- |
| `screen` | Screen monitoring: one person shares, others watch | Publisher gets a screen picker; camera and mic are never requested |
| `meeting` | Round-table calls | Publisher gets camera + mic, and can also share a screen |

## Two participant roles

Roles are set per token, so one room serves both sides.

| Role | Can publish | Devices requested | Typical user |
| --- | --- | --- | --- |
| `publisher` | Yes | Screen (and camera/mic in meeting mode) | The employee sharing |
| `viewer` | **No** | **None** — no camera or microphone prompt at all | The manager watching |

A `viewer` joins automatically with no permission prompt. The SFU rejects any
publish attempt from a viewer token, so this is an access control boundary,
not a UI preference.

---

## How it fits together

```
your backend  ──API key──▶  POST /api/v1/rooms          → { roomId }
              ──API key──▶  POST /api/v1/rooms/:id/tokens → { token, url }
                                     │
                                     ▼  (roomId + token sent to your frontend)
your frontend ─────────────▶ <iframe src="https://live.grav.in/embed/:roomId?token=…">
                                     │
                                     ▼
                            browser ⇄ stream.grav.in (WebSocket + WebRTC media)
```

The **API key never reaches the browser.** It only ever lives on your server and
is used to mint short-lived, per-user room tokens.

---

## 1. Get an API key

Sign up at `https://live.grav.in/signup`, then **Dashboard → API keys → Create
key**. The plaintext key is shown **once** — store it in your backend's
environment as e.g. `GRAV_STREAM_API_KEY`. Only a hash is kept server-side, so a
lost key must be revoked and replaced.

Keys look like `gsk_live_…` and are sent as a bearer token:

```
Authorization: Bearer gsk_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 2. REST API

Base URL: `https://stream.grav.in`

| Method   | Path                           | Purpose                       |
| -------- | ------------------------------ | ----------------------------- |
| `POST`   | `/api/v1/rooms`                | Create a room                 |
| `GET`    | `/api/v1/rooms`                | List your rooms               |
| `GET`    | `/api/v1/rooms/:roomId`        | Room status + live participants |
| `DELETE` | `/api/v1/rooms/:roomId`        | Force-end a room              |
| `POST`   | `/api/v1/rooms/:roomId/tokens` | Mint a per-user room token    |
| `GET`    | `/api/v1/usage`                | Usage rollup                  |

### Create a room

```http
POST /api/v1/rooms
Authorization: Bearer gsk_live_…
Content-Type: application/json

{ "name": "Alice - workstation", "mode": "screen", "requireEntireScreen": true, "maxParticipants": 12 }
```

```json
{
  "roomId": "c42ce8ff",
  "name": "Alice - workstation",
  "mode": "screen",
  "requireEntireScreen": true,
  "maxParticipants": 12,
  "url": "wss://stream.grav.in"
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"meeting"` | `"screen"` for monitoring, `"meeting"` for calls |
| `requireEntireScreen` | `true` when `mode` is `screen` | Reject window and browser-tab shares |
| `maxParticipants` | 30 | Clamped to the server ceiling (30) |

### Mint a room token

One token per participant. `identity` is your stable user id; `name` is what
others see.

```http
POST /api/v1/rooms/c42ce8ff/tokens
Authorization: Bearer gsk_live_…
Content-Type: application/json

{ "identity": "employee-42", "name": "Alice", "role": "publisher", "ttlSeconds": 21600 }
```

```json
{ "token": "eyJhbGciOiJIUzI1NiIs…", "url": "wss://stream.grav.in", "roomId": "c42ce8ff", "role": "publisher", "mode": "screen" }
```

Use `"role": "viewer"` for the watching manager. A viewer is never prompted for
camera or microphone, and the SFU rejects any publish attempt from that token.

`ttlSeconds` defaults to 6 hours, capped at 24.

### Room status

This is the endpoint a monitoring dashboard polls. `sharing.screen` is present
only while a screen is actually live, and reports which surface was chosen.

```json
{
  "roomId": "c42ce8ff",
  "name": "Alice - workstation",
  "mode": "screen",
  "requireEntireScreen": true,
  "live": true,
  "participantCount": 2,
  "participants": [
    {
      "peerId": "…",
      "identity": "employee-42",
      "name": "Alice",
      "role": "publisher",
      "joinedAt": 1786353378689,
      "sharing": {
        "screen": { "displaySurface": "monitor", "width": 1920, "height": 1080, "startedAt": 1786353381020 },
        "camera": false,
        "mic": false
      },
      "media": { "mic": false, "camera": false, "screen": true }
    }
  ],
  "endedAt": null
}
```

`displaySurface` is the browser's own report of what the user picked:

| Value | Meaning |
| --- | --- |
| `monitor` | An entire display |
| `window` | A single application window |
| `browser` | A single browser tab |

---

## 3. Embed the session

```html
<iframe
  src="https://live.grav.in/embed/ROOM_ID?token=ROOM_TOKEN"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 100%; border: 0"
></iframe>
```

> **The `allow` attribute is required.** Without it the browser blocks camera,
> microphone, and screen sharing inside the iframe and the user sees a
> permissions error, not a prompt.

Optional query params:

| Param          | Effect                                                              |
| -------------- | ------------------------------------------------------------------- |
| `token`        | **Required.** The room token from the API.                          |
| `parentOrigin` | Restricts `postMessage` events to this exact origin. Defaults to `*`. |

### Events from the iframe

```js
window.addEventListener("message", (event) => {
  if (event.origin !== "https://live.grav.in") return;   // always check this
  if (event.data?.source !== "grav-stream") return;
  const { type, ...data } = event.data;
  // …
});
```

| Event | Payload | Fires when |
| --- | --- | --- |
| `ready` | `{ roomId, role, mode }` | The embed has loaded. Exactly once. |
| `joined` | `{ peerId, identity, role, mode }` | Connected to the room |
| `screen-share-started` | `{ displaySurface, width, height, frameRate, label }` | The user began sharing — **this is where you learn what they picked** |
| `screen-share-stopped` | `{}` | Sharing ended, including via the browser's own "Stop sharing" bar |
| `screen-share-cancelled` | `{}` | The user dismissed the picker without choosing |
| `media-state` | `{ mic, camera, screen }` | Any local device is toggled |
| `remote-screen-started` | `{ peerId, displaySurface, width, height }` | Someone else started sharing (useful for viewers) |
| `participant-joined` | `{ identity, name }` | Someone joined |
| `participant-left` | `{ peerId }` | Someone left |
| `left` | `{}` | The local user ended their session |
| `error` | `{ message, code, capture? }` | Something failed — see codes below |

#### Error codes

| `code` | Meaning | What to tell the user |
| --- | --- | --- |
| `ENTIRE_SCREEN_REQUIRED` | They picked a window or tab in a room that demands a full display. `capture.displaySurface` says which. | "Share your entire screen, not a single window." |
| `SURFACE_UNKNOWN` | The browser will not report the surface, so the policy cannot be verified. | "Use Chrome or Edge." |
| `PERMISSION_DENIED` | Blocked by the browser, usually a missing iframe `allow`. | Check the `allow` attribute. |
| `DEVICE_PERMISSION_DENIED` | Camera/mic unavailable in a meeting room. | Check the permission prompt. |
| `SERVER_UNREACHABLE` | Could not reach the streaming server. | Retry / check status. |

Enforcement is server-side: even if a client is tampered with, the SFU refuses
a screen producer whose surface violates the room policy. The event exists so
you can *explain* the rejection, not to implement it.

### Controlling the iframe

```js
iframeEl.contentWindow.postMessage(
  { source: "grav-stream-parent", type: "start-screen-share" },
  "https://live.grav.in"
);
```

Supported types: `start-screen-share`, `stop-screen-share`,
`toggle-screen-share`, `toggle-mic`, `toggle-camera`, `leave`.

> Browsers require a user gesture to open the screen picker. Calling
> `start-screen-share` from your own button click works; calling it on a timer
> or on page load will be blocked.

---

## 4. End-to-end example: screen monitoring (Node/Express)

One durable room per employee. The employee gets a `publisher` token, each
manager gets a `viewer` token for the same room.

```js
const GRAV_API = "https://stream.grav.in";
const EMBED = "https://live.grav.in";
const headers = {
  Authorization: `Bearer ${process.env.GRAV_STREAM_API_KEY}`,
  "Content-Type": "application/json",
};

async function api(path, body) {
  const res = await fetch(`${GRAV_API}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Grav Stream returned ${res.status}`);
  return data;
}

// Created once per employee and reused. Rooms survive restarts and periods
// with nobody connected, so the id can live in your own database.
async function ensureRoomFor(employee) {
  if (employee.gravRoomId) return employee.gravRoomId;
  const room = await api("/api/v1/rooms", {
    name: `${employee.name} - workstation`,
    mode: "screen",
    requireEntireScreen: true,
    maxParticipants: 10,
  });
  await db.saveGravRoomId(employee.id, room.roomId);
  return room.roomId;
}

const embedUrl = (roomId, token) =>
  `${EMBED}/embed/${roomId}?token=${encodeURIComponent(token)}&parentOrigin=${encodeURIComponent("https://your-app.com")}`;

// The employee goes online and starts sharing.
app.post("/monitoring/go-online", async (req, res) => {
  const roomId = await ensureRoomFor(req.user);
  const { token } = await api(`/api/v1/rooms/${roomId}/tokens`, {
    identity: req.user.id,
    name: req.user.name,
    role: "publisher",
    ttlSeconds: 9 * 60 * 60, // a working day
  });
  res.json({ roomId, embedUrl: embedUrl(roomId, token) });
});

// A manager opens an employee's live screen.
app.get("/monitoring/:employeeId/watch", async (req, res) => {
  if (!req.user.canMonitor) return res.status(403).json({ error: "Forbidden" });

  const employee = await db.getEmployee(req.params.employeeId);
  const roomId = await ensureRoomFor(employee);
  const { token } = await api(`/api/v1/rooms/${roomId}/tokens`, {
    identity: req.user.id,
    name: req.user.name,
    role: "viewer", // never prompted for camera or mic
    ttlSeconds: 3600,
  });
  res.json({ embedUrl: embedUrl(roomId, token) });
});

// Who is actually sharing right now, for a monitoring dashboard.
app.get("/monitoring/status/:employeeId", async (req, res) => {
  const employee = await db.getEmployee(req.params.employeeId);
  if (!employee.gravRoomId) return res.json({ online: false });

  const info = await api(`/api/v1/rooms/${employee.gravRoomId}`);
  const sharer = info.participants.find((p) => p.sharing.screen);
  res.json({
    online: info.live,
    sharing: Boolean(sharer),
    surface: sharer?.sharing.screen.displaySurface || null,
    since: sharer?.sharing.screen.startedAt || null,
  });
});
```

Frontend — the whole client integration:

```jsx
<iframe
  src={embedUrl}
  allow="camera; microphone; display-capture; autoplay"
  style={{ width: "100%", height: "100%", border: 0 }}
/>
```

> **`allow` is mandatory.** Without it the browser blocks screen capture inside
> the frame and the user gets an error instead of a picker. This is the single
> most common integration mistake.

Reacting to what the employee picked:

```js
window.addEventListener("message", (event) => {
  if (event.origin !== "https://live.grav.in") return;
  if (event.data?.source !== "grav-stream") return;

  if (event.data.type === "screen-share-started") {
    const { displaySurface, width, height } = event.data;
    console.log(`sharing ${displaySurface} at ${width}x${height}`);
  }
  if (event.data.type === "error" && event.data.code === "ENTIRE_SCREEN_REQUIRED") {
    showBanner("Please share your entire screen, not a single window or tab.");
  }
});
```

---

## 5. Migrating from LiveKit

The server-side surface maps almost one-to-one, so a LiveKit backend converts
by replacing SDK calls with `fetch`:

| LiveKit (`livekit-server-sdk`)      | Grav Stream                            |
| ----------------------------------- | -------------------------------------- |
| `svc.createRoom({ name })`          | `POST /api/v1/rooms`                   |
| `svc.listRooms([name])`             | `GET /api/v1/rooms/:roomId`            |
| `svc.deleteRoom(name)`              | `DELETE /api/v1/rooms/:roomId`         |
| `new AccessToken(...).toJwt()`      | `POST /api/v1/rooms/:roomId/tokens`    |
| grant `identity` / `name`           | body `identity` / `name`               |
| grant `canPublish` / `canSubscribe` | body `canPublish` / `canSubscribe`     |
| `ttl: "6h"`                         | body `ttlSeconds: 21600`               |

On the client, `<LiveKitRoom>` + `<VideoConference />` (and any imperative
`new Room().connect()`) are replaced by the iframe above. `livekit-client`,
`@livekit/components-react`, and `@livekit/components-styles` can then be
removed entirely.

---

## 6. Usage & billing data

`GET /api/v1/usage` (or the dashboard Overview page) returns:

```json
{
  "summary": { "sessions": 128, "rooms": 14, "participantMinutes": 3540, "liveParticipants": 2 },
  "daily":   [{ "day": "2026-08-10", "sessions": 12, "participantMinutes": 310 }]
}
```

**Participant-minutes** is the billable unit: one person connected for one
minute. Peers still connected are counted up to the current moment, so the
number moves during a live call.

---

## 7. Enforcing "entire screen only"

This is the part most monitoring products get wrong, so it is worth being
explicit about what is and is not guaranteed.

`getDisplayMedia({ video: { displaySurface: "monitor" } })` is only a **hint**.
Chrome pre-selects the Entire Screen tab in its picker, but the user can still
choose a window or a single browser tab. Nothing in the browser API prevents
that.

So the selection is verified, not requested:

1. The embed reads `track.getSettings().displaySurface` after capture starts.
2. If the room requires a full display and the user picked otherwise, the embed
   stops the track and reports `ENTIRE_SCREEN_REQUIRED`.
3. The claimed surface is sent to the server with the publish request, and the
   **SFU refuses the producer** if it violates the room policy.

Step 3 is what makes this an actual control: a modified client that lies about
its surface still gets refused, because the check does not run in the browser.

**Browser support caveat.** If a browser will not report `displaySurface`, the
policy cannot be verified and the share is refused with `SURFACE_UNKNOWN`.
Chrome and Edge report it. Set `requireEntireScreen: false` if you need to
support browsers that do not.

**What this does not do:** it cannot tell you what is *on* the screen, detect a
virtual display or VM, or stop someone photographing their monitor. It
guarantees the captured surface is a whole display, nothing more.

---

## 8. Operational notes

- Media (RTP) flows directly between browsers and `stream.grav.in` on UDP
  40000–49999 — it does **not** pass through Nginx. Those ports must stay open.
- `MEDIASOUP_ANNOUNCED_IP` must be the droplet's **public** IP or participants on
  other networks cannot connect.
- `TOKEN_SECRET` signs room tokens. Rotating it invalidates every outstanding
  token immediately.
- `ALLOWED_ORIGINS` must list your dashboard/embed origin exactly, with no
  trailing slash, or browsers will block the API calls.
- The SQLite database lives in `DATA_DIR` (`/var/lib/grav-stream`), deliberately
  outside the deploy directory so re-uploading the app cannot destroy accounts
  or usage history. Back that directory up.
