# Grav Stream — integration guide

Self-hosted video meetings. Your backend talks to a REST API; your frontend
embeds an iframe. There is no SDK to install and no WebRTC code to write.

- **API + signaling:** `https://stream.grav.in` (droplet, mediasoup SFU)
- **Dashboard + embed UI:** `https://live.grav.in`

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

{ "name": "Daily standup", "maxParticipants": 12 }
```

```json
{ "roomId": "c42ce8ff", "name": "Daily standup", "maxParticipants": 12, "url": "wss://stream.grav.in" }
```

`maxParticipants` is clamped to the server ceiling (30).

### Mint a room token

One token per participant, per meeting. `identity` is your stable user id;
`name` is what other participants see.

```http
POST /api/v1/rooms/c42ce8ff/tokens
Authorization: Bearer gsk_live_…
Content-Type: application/json

{ "identity": "employee-42", "name": "Alice", "canPublish": true, "canSubscribe": true, "ttlSeconds": 21600 }
```

```json
{ "token": "eyJhbGciOiJIUzI1NiIs…", "url": "wss://stream.grav.in", "roomId": "c42ce8ff" }
```

`ttlSeconds` defaults to 6 hours and is capped at 24. Set `canPublish: false`
for view-only attendees — the server rejects their publish attempts, it is not
merely a UI hint.

### Room status

```json
{
  "roomId": "c42ce8ff",
  "name": "Daily standup",
  "live": true,
  "participantCount": 3,
  "participants": [{ "peerId": "…", "identity": "employee-42", "name": "Alice" }],
  "endedAt": null
}
```

---

## 3. Embed the meeting

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
  if (event.data?.source !== "grav-stream") return;
  switch (event.data.type) {
    case "ready":                 break; // iframe loaded
    case "joined":                break; // { peerId, identity }
    case "left":                  break; // user hung up
    case "participants-changed":  break; // { count }
    case "error":                 break; // { message }
  }
});
```

In production, also check `event.origin === "https://live.grav.in"` before
trusting a message.

### Controlling the iframe

```js
iframeEl.contentWindow.postMessage(
  { source: "grav-stream-parent", type: "toggle-mic" },
  "https://live.grav.in"
);
```

Supported types: `toggle-mic`, `toggle-camera`, `toggle-screen-share`, `leave`.

---

## 4. End-to-end example (Node/Express)

```js
const GRAV_API = "https://stream.grav.in";
const KEY = process.env.GRAV_STREAM_API_KEY;

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function startMeeting(meetTitle) {
  const res = await fetch(`${GRAV_API}/api/v1/rooms`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: meetTitle, maxParticipants: 30 }),
  });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  return res.json(); // { roomId }
}

async function joinToken(roomId, user) {
  const res = await fetch(`${GRAV_API}/api/v1/rooms/${roomId}/tokens`, {
    method: "POST",
    headers,
    body: JSON.stringify({ identity: user.id, name: user.name }),
  });
  if (!res.ok) throw new Error(`mint token failed: ${res.status}`);
  return res.json(); // { token, url, roomId }
}

app.post("/meetings/:id/join", async (req, res) => {
  const { roomId } = await startMeeting(req.params.id);
  const { token } = await joinToken(roomId, req.user);
  res.json({ roomId, token }); // frontend builds the iframe URL from these
});
```

Frontend:

```jsx
<iframe
  src={`https://live.grav.in/embed/${roomId}?token=${token}`}
  allow="camera; microphone; display-capture; autoplay"
  style={{ width: "100%", height: "100%", border: 0 }}
/>
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

## 7. Operational notes

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
