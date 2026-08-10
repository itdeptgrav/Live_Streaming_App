# Reference integration

A deliberately separate app that consumes Grav Stream exactly the way a real
customer (cowork, or anyone else) would. Use it to prove an integration works
end-to-end before wiring it into a product.

**It shares nothing with the platform.** No imported modules, no SDK, no
`mediasoup-client`, no WebRTC code — only:

1. HTTP calls to `/api/v1/*` with an API key, made **server-side**
2. An `<iframe>` pointing at the embed URL
3. `postMessage` in both directions

If this app works, a real integration works. If it breaks, the API contract is
wrong — not the customer's code.

---

## Run it

You need an API key from the dashboard (**/dashboard/keys**).

### Against production

```bash
GRAV_STREAM_API_KEY=gsk_live_xxxxxxxx \
GRAV_API=https://stream.grav.in \
GRAV_EMBED=https://live.grav.in \
node server.js
```

### Against a local stack

With the signaling server on `:4000` and the Next app on `:3000`:

```bash
GRAV_STREAM_API_KEY=gsk_live_xxxxxxxx node server.js
```

Then open <http://localhost:5050>.

There is **no `npm install`** — it is one file using only the Node standard
library and global `fetch`.

---

## What to test

| Action | What it proves |
| ------ | -------------- |
| **Create & join** | Room creation and host token minting work with your key |
| Copy the room ID into a second browser and **Join** | Multi-party: two independent tokens in one room |
| Tick **View-only** before joining | `canPublish: false` is enforced by the SFU, not just hidden in the UI |
| **Share screen** inside the call | `display-capture` passes through the iframe `allow` attribute |
| Watch the **events** panel | `ready`, `joined`, `participants-changed`, `left`, `error` all fire |
| Click **Toggle mic / camera / screen / Leave** | The parent→iframe control channel works without an SDK |
| Watch **Live room status** | `GET /api/v1/rooms/:id` reports real connected participants |

To prove the part that matters most — that it works across networks — open the
app on your machine and have someone on a **different network** join the same
room ID. If that works, `MEDIASOUP_ANNOUNCED_IP` and the UDP firewall rules are
correct.

---

## The whole integration, in brief

Server-side (never in the browser — the API key must not be exposed):

```js
const room  = await callApi("/api/v1/rooms", { method: "POST", body: { name: title } });
const { token } = await callApi(`/api/v1/rooms/${room.roomId}/tokens`,
                                { method: "POST", body: { identity: user.id, name: user.name } });
return { embedUrl: `https://live.grav.in/embed/${room.roomId}?token=${token}` };
```

Browser:

```html
<iframe src="EMBED_URL" allow="camera; microphone; display-capture; autoplay"></iframe>
```

> The `allow` attribute is **required**. Without it the browser silently blocks
> camera, microphone, and screen sharing inside the frame — the user gets an
> error instead of a permission prompt. This is the single most common
> integration mistake.

See [../INTEGRATION.md](../INTEGRATION.md) for the full API reference.
