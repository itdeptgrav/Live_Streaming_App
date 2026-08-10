// Integration docs. This page is the rendered twin of INTEGRATION.md at the
// repository root — endpoints, event names and error codes are kept identical
// to it on purpose. Change both together or neither.

export const metadata = {
  title: "Grav Stream — Integration docs",
};

const PRE =
  "overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-200 ring-1 ring-white/10";
const RING = "ring-1 ring-zinc-950/10 dark:ring-white/10";
const CODE =
  "font-mono text-[0.85em] rounded bg-zinc-950/5 px-1 py-0.5 dark:bg-white/10";
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950";

const METHOD_TONE = {
  GET: "text-sky-700 dark:text-sky-400",
  POST: "text-emerald-700 dark:text-emerald-400",
  DELETE: "text-rose-700 dark:text-rose-400",
};

function C({ children }) {
  return <code className={CODE}>{children}</code>;
}

function Section({ id, title, children }) {
  return (
    <section id={id} className="flex scroll-mt-20 flex-col gap-4">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Callout({ tone = "amber", title, children }) {
  const tones = {
    amber:
      "bg-amber-500/10 ring-amber-600/25 text-amber-900 dark:text-amber-200",
    rose: "bg-rose-500/10 ring-rose-600/25 text-rose-900 dark:text-rose-200",
    emerald:
      "bg-emerald-500/10 ring-emerald-600/25 text-emerald-900 dark:text-emerald-200",
  };
  return (
    <div className={`rounded-xl p-4 ring-1 ${tones[tone]}`}>
      {title && <p className="text-sm font-semibold">{title}</p>}
      <div className="mt-1 text-sm leading-relaxed">{children}</div>
    </div>
  );
}

function Table({ caption, head, rows }) {
  return (
    <div className={`overflow-x-auto rounded-xl ${RING}`}>
      <table className="w-full min-w-[34rem] text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr className="border-b border-zinc-950/10 dark:border-white/10">
            {head.map((h) => (
              <th key={h} scope="col" className="px-4 py-3 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-zinc-950/10 last:border-0 dark:border-white/10"
            >
              {row.map((cell, j) => (
                <td
                  key={j}
                  className={`px-4 py-3 align-top ${
                    j === 0 ? "" : "text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Endpoint({ method, path, summary, request, response, children }) {
  return (
    <div className={`flex flex-col gap-3 rounded-xl p-4 sm:p-5 ${RING}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`font-mono text-xs font-semibold ${METHOD_TONE[method]}`}
        >
          {method}
        </span>
        <code className="font-mono text-sm break-all">{path}</code>
      </div>
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        {summary}
      </p>
      {children}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {request && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Request
            </span>
            <pre className={PRE}>
              <code>{request}</code>
            </pre>
          </div>
        )}
        <div
          className={`flex min-w-0 flex-col gap-1.5 ${
            request ? "" : "lg:col-span-2"
          }`}
        >
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Response
          </span>
          <pre className={PRE}>
            <code>{response}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

const TOC = [
  { id: "concept", label: "How it fits together" },
  { id: "api-key", label: "Get an API key" },
  { id: "modes", label: "Room modes" },
  { id: "roles", label: "Participant roles" },
  { id: "rest", label: "REST API" },
  { id: "embed", label: "Embed the room" },
  { id: "events", label: "Events from the iframe" },
  { id: "errors", label: "Error codes" },
  { id: "control", label: "Controlling the iframe" },
  { id: "example", label: "End-to-end example" },
  { id: "usage", label: "Usage & billing data" },
];

const EVENTS = [
  ["ready", "{ roomId, role, mode }", "The embed has loaded. Exactly once."],
  ["joined", "{ peerId, identity, role, mode }", "Connected to the room"],
  [
    "screen-share-started",
    "{ displaySurface, width, height, frameRate, label }",
    "The user began sharing — this is where you learn what they picked",
  ],
  [
    "screen-share-stopped",
    "{}",
    'Sharing ended, including via the browser’s own "Stop sharing" bar',
  ],
  [
    "screen-share-cancelled",
    "{}",
    "The user dismissed the picker without choosing",
  ],
  ["media-state", "{ mic, camera, screen }", "Any local device is toggled"],
  [
    "remote-screen-started",
    "{ peerId, displaySurface, width, height }",
    "Someone else started sharing (useful for viewers)",
  ],
  ["participant-joined", "{ identity, name }", "Someone joined"],
  ["participant-left", "{ peerId }", "Someone left"],
  ["left", "{}", "The local user ended their session"],
  [
    "error",
    "{ message, code, capture? }",
    "Something failed — see the error codes below",
  ],
];

const ERRORS = [
  [
    "ENTIRE_SCREEN_REQUIRED",
    "They picked a window or tab in a room that demands a full display. capture.displaySurface says which.",
    "“Share your entire screen, not a single window.”",
  ],
  [
    "SURFACE_UNKNOWN",
    "The browser will not report the surface, so the policy cannot be verified.",
    "“Use Chrome or Edge.”",
  ],
  [
    "PERMISSION_DENIED",
    "Blocked by the browser, usually a missing iframe allow attribute.",
    "Check the allow attribute.",
  ],
  [
    "DEVICE_PERMISSION_DENIED",
    "Camera/mic unavailable in a meeting room.",
    "Check the permission prompt.",
  ],
  [
    "SERVER_UNREACHABLE",
    "Could not reach the streaming server.",
    "Retry / check status.",
  ],
];

export default function DocsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 font-sans sm:px-8">
      <header className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
          Integration guide
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Grav Stream API
        </h1>
        <p className="max-w-2xl leading-relaxed text-zinc-600 dark:text-zinc-400">
          Self-hosted screen sharing and video. Your backend talks to a REST API;
          your frontend embeds an iframe. There is no SDK to install and no
          WebRTC code to write.
        </p>
        <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className={`rounded-xl p-4 ${RING}`}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">
              API + signaling
            </dt>
            <dd className="mt-1 font-mono text-sm break-all">
              https://stream.grav.in
            </dd>
          </div>
          <div className={`rounded-xl p-4 ${RING}`}>
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">
              Dashboard + embed UI
            </dt>
            <dd className="mt-1 font-mono text-sm break-all">
              https://live.grav.in
            </dd>
          </div>
        </dl>
      </header>

      <nav
        aria-label="On this page"
        className={`mt-10 rounded-xl p-4 ${RING}`}
      >
        <p className="text-xs text-zinc-500 dark:text-zinc-400">On this page</p>
        <ul className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          {TOC.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={`rounded text-sm text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-12 flex flex-col gap-14">
        {/* ------------------------------------------------------ concept */}
        <Section id="concept" title="How it fits together">
          <pre className={PRE}>
            <code>{`your backend  ──API key──▶  POST /api/v1/rooms          → { roomId }
              ──API key──▶  POST /api/v1/rooms/:id/tokens → { token, url }
                                     │
                                     ▼  (roomId + token sent to your frontend)
your frontend ─────────────▶ <iframe src="https://live.grav.in/embed/:roomId?token=…">
                                     │
                                     ▼
                            browser ⇄ stream.grav.in (WebSocket + WebRTC media)`}</code>
          </pre>

          <Callout tone="rose" title="The API key never reaches the browser">
            It only ever lives on your server and is used to mint short-lived,
            per-user room tokens. Anyone holding the key can create rooms and
            mint tokens on your account — keep it in your backend secrets, and
            revoke it from the API keys page if it leaks.
          </Callout>
        </Section>

        {/* ------------------------------------------------------ api key */}
        <Section id="api-key" title="1. Get an API key">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Sign up at <C>https://live.grav.in/signup</C>, then{" "}
            <strong className="font-medium text-zinc-900 dark:text-zinc-100">
              Dashboard → API keys → Create key
            </strong>
            . The plaintext key is shown{" "}
            <strong className="font-medium text-zinc-900 dark:text-zinc-100">
              once
            </strong>{" "}
            — store it in your backend&apos;s environment as e.g.{" "}
            <C>GRAV_STREAM_API_KEY</C>. Only a hash is kept server-side, so a
            lost key must be revoked and replaced.
          </p>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Keys look like <C>gsk_live_…</C> and are sent as a bearer token:
          </p>
          <pre className={PRE}>
            <code>
              Authorization: Bearer gsk_live_xxxxxxxxxxxxxxxxxxxxxxxx
            </code>
          </pre>
        </Section>

        {/* -------------------------------------------------------- modes */}
        <Section id="modes" title="Two room modes">
          <Table
            caption="Room modes"
            head={["Mode", "Use it for", "What the embed does"]}
            rows={[
              [
                <code key="s" className="font-mono text-xs">
                  screen
                </code>,
                "Screen monitoring: one person shares, others watch",
                "Publisher gets a screen picker; camera and mic are never requested",
              ],
              [
                <code key="m" className="font-mono text-xs">
                  meeting
                </code>,
                "Round-table calls",
                "Publisher gets camera + mic, and can also share a screen",
              ],
            ]}
          />
        </Section>

        {/* -------------------------------------------------------- roles */}
        <Section id="roles" title="Two participant roles">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Roles are set per token, so one room serves both sides.
          </p>
          <Table
            caption="Participant roles"
            head={["Role", "Can publish", "Devices requested", "Typical user"]}
            rows={[
              [
                <code key="p" className="font-mono text-xs">
                  publisher
                </code>,
                "Yes",
                "Screen (and camera/mic in meeting mode)",
                "The employee sharing",
              ],
              [
                <code key="v" className="font-mono text-xs">
                  viewer
                </code>,
                <strong key="n" className="font-medium">
                  No
                </strong>,
                <strong key="d" className="font-medium">
                  None — no camera or microphone prompt at all
                </strong>,
                "The manager watching",
              ],
            ]}
          />
          <Callout tone="emerald" title="This is an access-control boundary">
            A <C>viewer</C> joins automatically with no permission prompt. The
            SFU rejects any publish attempt from a viewer token, so it is not a
            UI preference you can defeat by tampering with the client.
          </Callout>
        </Section>

        {/* --------------------------------------------------------- REST */}
        <Section id="rest" title="2. REST API">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Base URL <C>https://stream.grav.in</C>. Every request carries{" "}
            <C>Authorization: Bearer gsk_live_…</C>.
          </p>

          <Table
            caption="Endpoint summary"
            head={["Method", "Path", "Purpose"]}
            rows={[
              ["POST", "/api/v1/rooms", "Create a room"],
              ["GET", "/api/v1/rooms", "List your rooms"],
              [
                "GET",
                "/api/v1/rooms/:roomId",
                "Room status + live participants",
              ],
              ["DELETE", "/api/v1/rooms/:roomId", "Force-end a room"],
              [
                "POST",
                "/api/v1/rooms/:roomId/tokens",
                "Mint a per-user room token",
              ],
              ["GET", "/api/v1/usage", "Usage rollup"],
            ].map(([m, p, s]) => [
              <span
                key="m"
                className={`font-mono text-xs font-semibold ${METHOD_TONE[m]}`}
              >
                {m}
              </span>,
              <code key="p" className="font-mono text-xs break-all">
                {p}
              </code>,
              s,
            ])}
          />

          <h3 className="mt-4 text-base font-medium">Create a room</h3>
          <Endpoint
            method="POST"
            path="/api/v1/rooms"
            summary="Call this once per monitoring session or meeting."
            request={`POST /api/v1/rooms
Authorization: Bearer gsk_live_…
Content-Type: application/json

{
  "name": "Alice - workstation",
  "mode": "screen",
  "requireEntireScreen": true,
  "maxParticipants": 12
}`}
            response={`{
  "roomId": "c42ce8ff",
  "name": "Alice - workstation",
  "mode": "screen",
  "requireEntireScreen": true,
  "maxParticipants": 12,
  "url": "wss://stream.grav.in"
}`}
          />
          <Table
            caption="Create-room fields"
            head={["Field", "Default", "Meaning"]}
            rows={[
              [
                <code key="a" className="font-mono text-xs">
                  mode
                </code>,
                <code key="b" className="font-mono text-xs">
                  &quot;meeting&quot;
                </code>,
                <>
                  <C>&quot;screen&quot;</C> for monitoring,{" "}
                  <C>&quot;meeting&quot;</C> for calls
                </>,
              ],
              [
                <code key="c" className="font-mono text-xs">
                  requireEntireScreen
                </code>,
                <>
                  <C>true</C> when <C>mode</C> is <C>screen</C>
                </>,
                "Reject window and browser-tab shares",
              ],
              [
                <code key="d" className="font-mono text-xs">
                  maxParticipants
                </code>,
                "30",
                "Clamped to the server ceiling (30)",
              ],
            ]}
          />

          <h3 className="mt-4 text-base font-medium">List your rooms</h3>
          <Endpoint
            method="GET"
            path="/api/v1/rooms"
            summary="Every room created on your account, newest first."
            response={`{
  "rooms": [
    {
      "roomId": "c42ce8ff",
      "name": "Alice - workstation",
      "live": true,
      "participantCount": 2,
      "createdAt": 1786353378689,
      "endedAt": null,
      "maxParticipants": 12,
      "totalParticipants": 11
    }
  ]
}`}
          />

          <h3 className="mt-4 text-base font-medium">Mint a room token</h3>
          <Endpoint
            method="POST"
            path="/api/v1/rooms/:roomId/tokens"
            summary="One token per participant. identity is your stable user id; name is what others see. Use role: viewer for the watching manager — a viewer is never prompted for camera or microphone, and the SFU rejects any publish attempt from that token. ttlSeconds defaults to 6 hours, capped at 24."
            request={`POST /api/v1/rooms/c42ce8ff/tokens
Authorization: Bearer gsk_live_…
Content-Type: application/json

{
  "identity": "employee-42",
  "name": "Alice",
  "role": "publisher",
  "ttlSeconds": 21600
}`}
            response={`{
  "token": "eyJhbGciOiJIUzI1NiIs…",
  "url": "wss://stream.grav.in",
  "roomId": "c42ce8ff",
  "role": "publisher",
  "mode": "screen"
}`}
          />

          <h3 className="mt-4 text-base font-medium">Room status</h3>
          <Endpoint
            method="GET"
            path="/api/v1/rooms/:roomId"
            summary="This is the endpoint a monitoring dashboard polls. sharing.screen is present only while a screen is actually live, and reports which surface was chosen."
            response={`{
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
        "screen": {
          "displaySurface": "monitor",
          "width": 1920,
          "height": 1080,
          "startedAt": 1786353381020
        },
        "camera": false,
        "mic": false
      },
      "media": { "mic": false, "camera": false, "screen": true }
    }
  ],
  "endedAt": null
}`}
          />
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            <C>displaySurface</C> is the browser&apos;s own report of what the
            user picked:
          </p>
          <Table
            caption="displaySurface values"
            head={["Value", "Meaning"]}
            rows={[
              [
                <code key="a" className="font-mono text-xs">
                  monitor
                </code>,
                "An entire display",
              ],
              [
                <code key="b" className="font-mono text-xs">
                  window
                </code>,
                "A single application window",
              ],
              [
                <code key="c" className="font-mono text-xs">
                  browser
                </code>,
                "A single browser tab",
              ],
            ]}
          />

          <h3 className="mt-4 text-base font-medium">Force-end a room</h3>
          <Endpoint
            method="DELETE"
            path="/api/v1/rooms/:roomId"
            summary="End the room and disconnect everyone still in it."
            response={`{ "ok": true }`}
          />

          <h3 className="mt-4 text-base font-medium">Usage rollup</h3>
          <Endpoint
            method="GET"
            path="/api/v1/usage"
            summary="Aggregate usage for your account — the same numbers shown on the Overview page."
            response={`{
  "summary": {
    "sessions": 128,
    "rooms": 14,
    "participantMinutes": 3540,
    "liveParticipants": 2
  },
  "daily": [
    { "day": "2026-08-10", "sessions": 12, "participantMinutes": 310 }
  ]
}`}
          />
        </Section>

        {/* -------------------------------------------------------- embed */}
        <Section id="embed" title="3. Embed the room">
          <pre className={PRE}>
            <code>{`<iframe
  src="https://live.grav.in/embed/ROOM_ID?token=ROOM_TOKEN"
  allow="camera; microphone; display-capture; autoplay"
  style="width: 100%; height: 100%; border: 0"
></iframe>`}</code>
          </pre>

          <Callout tone="amber" title="The allow attribute is mandatory">
            Without{" "}
            <C>allow=&quot;camera; microphone; display-capture; autoplay&quot;</C>{" "}
            the browser silently blocks camera, microphone and screen sharing
            inside the iframe. The user sees a permissions error, not a prompt —
            and the embed reports{" "}
            <code className="font-mono text-[0.85em]">PERMISSION_DENIED</code>{" "}
            rather than anything that points at the missing attribute. This is
            the single most common integration mistake.
          </Callout>

          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            You build the embed URL yourself from the room id and token. The{" "}
            <C>url</C> field in the API responses is the realtime server the
            media connects to, not this page. Give the iframe a real height — it
            fills whatever box you put it in.
          </p>

          <Table
            caption="Embed query parameters"
            head={["Param", "Effect"]}
            rows={[
              [
                <code key="a" className="font-mono text-xs">
                  token
                </code>,
                <>
                  <strong className="font-medium text-zinc-900 dark:text-zinc-100">
                    Required.
                  </strong>{" "}
                  The room token from the API.
                </>,
              ],
              [
                <code key="b" className="font-mono text-xs">
                  parentOrigin
                </code>,
                <>
                  Restricts <C>postMessage</C> events to this exact origin.
                  Defaults to <C>*</C>.
                </>,
              ],
            ]}
          />
        </Section>

        {/* ------------------------------------------------------- events */}
        <Section id="events" title="Events from the iframe">
          <pre className={PRE}>
            <code>{`window.addEventListener("message", (event) => {
  if (event.origin !== "https://live.grav.in") return;   // always check this
  if (event.data?.source !== "grav-stream") return;
  const { type, ...data } = event.data;
  // …
});`}</code>
          </pre>

          <Table
            caption="Events posted by the embed"
            head={["Event", "Payload", "Fires when"]}
            rows={EVENTS.map(([type, payload, when]) => [
              <code key="t" className="font-mono text-xs whitespace-nowrap">
                {type}
              </code>,
              <code key="p" className="font-mono text-xs">
                {payload}
              </code>,
              when,
            ])}
          />
        </Section>

        {/* ------------------------------------------------------- errors */}
        <Section id="errors" title="Error codes">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Delivered on the <C>error</C> event as{" "}
            <C>{"{ message, code, capture? }"}</C>.
          </p>
          <Table
            caption="Error codes"
            head={["code", "Meaning", "What to tell the user"]}
            rows={ERRORS.map(([code, meaning, tell]) => [
              <code key="c" className="font-mono text-xs">
                {code}
              </code>,
              meaning,
              tell,
            ])}
          />
          <Callout tone="emerald" title="Enforcement is server-side">
            Even if a client is tampered with, the SFU refuses a screen producer
            whose surface violates the room policy. The{" "}
            <C>ENTIRE_SCREEN_REQUIRED</C> event exists so you can{" "}
            <em>explain</em> the rejection, not to implement it.
          </Callout>
        </Section>

        {/* ------------------------------------------------------ control */}
        <Section id="control" title="Controlling the iframe">
          <pre className={PRE}>
            <code>{`iframeEl.contentWindow.postMessage(
  { source: "grav-stream-parent", type: "start-screen-share" },
  "https://live.grav.in"
);`}</code>
          </pre>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Supported types: <C>start-screen-share</C>, <C>stop-screen-share</C>,{" "}
            <C>toggle-screen-share</C>, <C>toggle-mic</C>, <C>toggle-camera</C>,{" "}
            <C>leave</C>.
          </p>
          <Callout tone="amber" title="A user gesture is required">
            Browsers only open the screen picker in response to a user gesture.
            Calling <C>start-screen-share</C> from your own button click works;
            calling it on a timer or on page load will be blocked.
          </Callout>
        </Section>

        {/* ------------------------------------------------------ example */}
        <Section id="example" title="4. End-to-end example">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            The screen-monitoring flow: create a <C>screen</C> room for one
            employee, mint a <C>publisher</C> token for them and a <C>viewer</C>{" "}
            token for their manager, then poll room status to see what is
            actually being shared.
          </p>

          <h3 className="text-base font-medium">Backend (Node / Express)</h3>
          <pre className={PRE}>
            <code>{`// server.js — Node 18+ (global fetch)
import express from "express";

const app = express();
app.use(express.json());

const GRAV_API = "https://stream.grav.in";
const KEY = process.env.GRAV_STREAM_API_KEY; // server-side only, never shipped

const headers = {
  Authorization: \`Bearer \${KEY}\`,
  "Content-Type": "application/json",
};

async function grav(path, { method = "GET", body } = {}) {
  const res = await fetch(GRAV_API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || \`Grav Stream request failed (\${res.status})\`);
  }
  return res.json();
}

// 1. One monitoring room per workstation.
async function createScreenRoom(employee) {
  return grav("/api/v1/rooms", {
    method: "POST",
    body: {
      name: \`\${employee.name} - workstation\`,
      mode: "screen",
      requireEntireScreen: true,
      maxParticipants: 12,
    },
  }); // → { roomId, mode, requireEntireScreen, url }
}

// 2. One token per person. The role decides everything.
async function mintToken(roomId, user, role) {
  return grav(\`/api/v1/rooms/\${roomId}/tokens\`, {
    method: "POST",
    body: {
      identity: user.id,
      name: user.name,
      role,           // "publisher" for the employee, "viewer" for the manager
      ttlSeconds: 28800,
    },
  }); // → { token, url, roomId, role, mode }
}

// The employee opens this to start sharing.
app.post("/monitoring/:employeeId/share", async (req, res) => {
  const employee = await db.employees.find(req.params.employeeId);
  const { roomId } = await createScreenRoom(employee);
  await db.employees.update(employee.id, { roomId });

  const { token } = await mintToken(roomId, employee, "publisher");
  res.json({ roomId, token });
});

// The manager opens this to watch. No camera or mic prompt will appear.
app.post("/monitoring/:employeeId/watch", async (req, res) => {
  const employee = await db.employees.find(req.params.employeeId);
  if (!employee.roomId) return res.status(409).json({ error: "Not sharing" });

  const { token } = await mintToken(employee.roomId, req.user, "viewer");
  res.json({ roomId: employee.roomId, token });
});

// 3. Poll room status to verify what is actually on screen.
app.get("/monitoring/:employeeId/status", async (req, res) => {
  const employee = await db.employees.find(req.params.employeeId);
  const room = await grav(\`/api/v1/rooms/\${employee.roomId}\`);

  const publisher = room.participants.find((p) => p.role === "publisher");
  const screen = publisher?.sharing?.screen;

  res.json({
    live: room.live,
    watching: room.participantCount,
    sharing: Boolean(screen),
    surface: screen?.displaySurface ?? null,   // "monitor" | "window" | "browser"
    resolution: screen ? \`\${screen.width}x\${screen.height}\` : null,
  });
});

app.listen(3001);`}</code>
          </pre>

          <h3 className="text-base font-medium">
            Frontend — the employee who shares
          </h3>
          <pre className={PRE}>
            <code>{`"use client";

import { useEffect, useRef, useState } from "react";

export default function ShareMyScreen({ employeeId }) {
  const frameRef = useRef(null);
  const [session, setSession] = useState(null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    fetch(\`/monitoring/\${employeeId}/share\`, { method: "POST" })
      .then((r) => r.json())
      .then(setSession);
  }, [employeeId]);

  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== "https://live.grav.in") return;
      if (event.data?.source !== "grav-stream") return;

      switch (event.data.type) {
        case "screen-share-started":
          setProblem(null);
          console.log("sharing", event.data.displaySurface);
          break;
        case "screen-share-cancelled":
          setProblem("You need to pick a screen to start your shift.");
          break;
        case "error":
          if (event.data.code === "ENTIRE_SCREEN_REQUIRED") {
            setProblem("Share your entire screen, not a single window.");
          } else if (event.data.code === "SURFACE_UNKNOWN") {
            setProblem("Use Chrome or Edge.");
          } else {
            setProblem(event.data.message);
          }
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function startSharing() {
    // Called from a real click, so the browser will open the picker.
    frameRef.current?.contentWindow?.postMessage(
      { source: "grav-stream-parent", type: "start-screen-share" },
      "https://live.grav.in"
    );
  }

  if (!session) return <p>Preparing…</p>;

  return (
    <div style={{ height: "80vh" }}>
      {problem && <p role="alert">{problem}</p>}
      <button onClick={startSharing}>Share my screen</button>
      <iframe
        ref={frameRef}
        src={
          "https://live.grav.in/embed/" +
          session.roomId +
          "?token=" +
          encodeURIComponent(session.token)
        }
        allow="camera; microphone; display-capture; autoplay"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </div>
  );
}`}</code>
          </pre>

          <h3 className="text-base font-medium">
            Frontend — the manager who watches
          </h3>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Identical markup, a <C>viewer</C> token instead. No device prompt
            appears, and the <C>allow</C> attribute is still required so the
            embed can play incoming media.
          </p>
          <pre className={PRE}>
            <code>{`<iframe
  src={\`https://live.grav.in/embed/\${roomId}?token=\${token}\`}
  allow="camera; microphone; display-capture; autoplay"
  style={{ width: "100%", height: "100%", border: 0 }}
/>`}</code>
          </pre>
        </Section>

        {/* -------------------------------------------------------- usage */}
        <Section id="usage" title="5. Usage & billing data">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            <C>GET /api/v1/usage</C> — or the dashboard Overview page — returns:
          </p>
          <pre className={PRE}>
            <code>{`{
  "summary": {
    "sessions": 128,
    "rooms": 14,
    "participantMinutes": 3540,
    "liveParticipants": 2
  },
  "daily": [
    { "day": "2026-08-10", "sessions": 12, "participantMinutes": 310 }
  ]
}`}</code>
          </pre>
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            <strong className="font-medium text-zinc-900 dark:text-zinc-100">
              Participant-minutes
            </strong>{" "}
            is the billable unit: one person connected for one minute. Peers
            still connected are counted up to the current moment, so the number
            moves during a live session.
          </p>
        </Section>
      </div>
    </main>
  );
}
