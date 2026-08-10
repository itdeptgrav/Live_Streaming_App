const PRE = "bg-zinc-100 dark:bg-zinc-900 rounded p-4 overflow-x-auto text-xs";

function Endpoint({ method, path, summary, request, response }) {
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {method}
        </span>
        <code className="font-mono text-sm break-all">{path}</code>
      </div>
      <p className="text-sm text-zinc-500">{summary}</p>
      {request && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Request body</span>
          <pre className={PRE}>{request}</pre>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Response</span>
        <pre className={PRE}>{response}</pre>
      </div>
    </div>
  );
}

export const metadata = {
  title: "Grav Stream — Integration docs",
};

export default function DocsPage() {
  return (
    <main className="flex-1 max-w-5xl mx-auto w-full p-8 flex flex-col gap-10">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Integration docs</h1>
        <p className="text-sm text-zinc-500">
          Grav Stream gives you hosted video meetings behind a REST API and a
          single iframe. Your backend creates a room and mints a short-lived
          token for each user; your frontend embeds the meeting. Your API key
          never touches the browser.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">How it works</h2>
        <ol className="flex flex-col gap-2 text-sm text-zinc-500 list-decimal pl-5">
          <li>
            Your backend calls{" "}
            <code className="font-mono text-xs">POST /api/v1/rooms</code> with
            your API key to create a room.
          </li>
          <li>
            For each user joining, your backend calls{" "}
            <code className="font-mono text-xs">
              POST /api/v1/rooms/:roomId/tokens
            </code>{" "}
            to mint a per-user token.
          </li>
          <li>
            Your backend returns the room id and token to your frontend.
          </li>
          <li>
            Your frontend renders the embed iframe with that token. Done.
          </li>
        </ol>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Base URL</span>
            <code className="font-mono text-sm">https://stream.grav.in</code>
          </div>
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
            <span className="text-sm text-zinc-500">Auth header</span>
            <code className="font-mono text-sm break-all">
              Authorization: Bearer YOUR_API_KEY
            </code>
          </div>
        </div>

        <p className="text-sm text-red-600">
          Server-side only. Anyone holding your API key can create rooms and
          mint tokens on your account — keep it in your backend secrets and
          rotate it from the API keys page if it leaks.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">REST API</h2>

        <Endpoint
          method="POST"
          path="/api/v1/rooms"
          summary="Create a room. Call this once per meeting. maxParticipants is capped at 30 and defaults to 30."
          request={`{
  "name": "Weekly standup",
  "maxParticipants": 30
}`}
          response={`{
  "roomId": "rm_9f3c1a72",
  "name": "Weekly standup",
  "maxParticipants": 30,
  // realtime server the media connects to — not the embed URL
  "url": "wss://stream.grav.in"
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/rooms"
          summary="List every room on your account."
          response={`{
  "rooms": [
    {
      "roomId": "rm_9f3c1a72",
      "name": "Weekly standup",
      "live": true,
      "participantCount": 3,
      "createdAt": 1770714764000,
      "endedAt": null,
      "maxParticipants": 30,
      "totalParticipants": 11
    }
  ]
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/rooms/:roomId"
          summary="Read the live state of a single room."
          response={`{
  "roomId": "rm_9f3c1a72",
  "name": "Weekly standup",
  "live": true,
  "participantCount": 2,
  "participants": [
    { "peerId": "pr_41ab", "identity": "user_128", "name": "Ada" },
    { "peerId": "pr_77cd", "identity": "user_452", "name": "Linus" }
  ],
  "endedAt": null
}`}
        />

        <Endpoint
          method="DELETE"
          path="/api/v1/rooms/:roomId"
          summary="End a room and disconnect everyone still in it."
          response={`{
  "ok": true
}`}
        />

        <Endpoint
          method="POST"
          path="/api/v1/rooms/:roomId/tokens"
          summary="Mint a token for one participant. Tokens are single-user — never reuse one across people. identity is required; canPublish and canSubscribe default to true; ttlSeconds defaults to 21600 (6h) and is capped at 86400 (24h)."
          request={`{
  "identity": "user_128",
  "name": "Ada Lovelace",
  "canPublish": true,
  "canSubscribe": true,
  "ttlSeconds": 3600
}`}
          response={`{
  "token": "eyJhbGciOi...",
  // realtime server the embed connects to — not the embed URL
  "url": "wss://stream.grav.in",
  "roomId": "rm_9f3c1a72"
}`}
        />

        <Endpoint
          method="GET"
          path="/api/v1/usage"
          summary="Aggregate usage for your account — the same numbers shown on the Overview page. summary covers the last 30 days; daily covers the last 14, oldest first."
          response={`{
  "summary": {
    "participantMinutes": 4820,
    "sessions": 96,
    "rooms": 14,
    "liveParticipants": 3,
    "since": 1768122764000
  },
  "daily": [
    { "day": "2026-08-08", "sessions": 12, "participantMinutes": 610 },
    { "day": "2026-08-09", "sessions": 9,  "participantMinutes": 448 }
  ]
}`}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Embedding the meeting</h2>
        <p className="text-sm text-zinc-500">
          Once your backend has a room id and a token, render the embed in an
          iframe. You build this URL yourself from the room id and token — the{" "}
          <code className="font-mono text-xs">url</code> field in the API
          responses is the realtime server the media connects to, not this page.
          Give the iframe a real height — it fills whatever box you put it in.
        </p>

        <pre className={PRE}>{`<iframe
  src="https://live.grav.in/embed/ROOM_ID?token=ROOM_TOKEN"
  allow="camera; microphone; display-capture; autoplay"
  style="width:100%;height:100%;border:0"
/>`}</pre>

        <p className="text-sm text-red-600">
          The <code className="font-mono text-xs">allow</code> attribute is
          required. Without it the browser blocks camera, microphone and screen
          sharing inside the iframe, and participants join with no media and no
          obvious error.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">postMessage events</h2>
        <p className="text-sm text-zinc-500">
          The iframe posts messages up to the parent window so you can react to
          the call. Every message it sends carries{" "}
          <code className="font-mono text-xs">source: &quot;grav-stream&quot;</code>{" "}
          and the <code className="font-mono text-xs">roomId</code> — check the
          source and ignore everything else, since any frame can post to your
          window.
        </p>

        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-zinc-500">
                <th className="font-normal px-4 py-3">type</th>
                <th className="font-normal px-4 py-3">Payload</th>
                <th className="font-normal px-4 py-3">Meaning</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="px-4 py-3 font-mono text-xs">ready</td>
                <td className="px-4 py-3 text-zinc-500">—</td>
                <td className="px-4 py-3 text-zinc-500">
                  The iframe has loaded and is ready.
                </td>
              </tr>
              <tr className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="px-4 py-3 font-mono text-xs">joined</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {"{ peerId, identity }"}
                </td>
                <td className="px-4 py-3 text-zinc-500">
                  The local user joined the room.
                </td>
              </tr>
              <tr className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="px-4 py-3 font-mono text-xs">left</td>
                <td className="px-4 py-3 text-zinc-500">—</td>
                <td className="px-4 py-3 text-zinc-500">
                  The local user left or hung up.
                </td>
              </tr>
              <tr className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="px-4 py-3 font-mono text-xs">error</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {"{ message }"}
                </td>
                <td className="px-4 py-3 text-zinc-500">
                  Something failed — bad or expired token, room ended, no media
                  permission.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs">
                  participants-changed
                </td>
                <td className="px-4 py-3 font-mono text-xs">{"{ count }"}</td>
                <td className="px-4 py-3 text-zinc-500">
                  Someone joined or left the room.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <pre className={PRE}>{`window.addEventListener("message", (e) => {
  if (!e.data || e.data.source !== "grav-stream") return;

  switch (e.data.type) {
    case "ready":
      console.log("embed ready");
      break;
    case "joined":
      console.log("joined as", e.data.identity, e.data.peerId);
      break;
    case "participants-changed":
      setParticipantCount(e.data.count);
      break;
    case "left":
      router.push("/call-ended");
      break;
    case "error":
      console.error("grav stream:", e.data.message);
      break;
  }
});`}</pre>

        <h3 className="font-medium">Controlling the call from the parent</h3>
        <p className="text-sm text-zinc-500">
          Post back into the iframe with{" "}
          <code className="font-mono text-xs">
            source: &quot;grav-stream-parent&quot;
          </code>{" "}
          and one of <code className="font-mono text-xs">toggle-mic</code>,{" "}
          <code className="font-mono text-xs">toggle-camera</code>,{" "}
          <code className="font-mono text-xs">toggle-screen-share</code>,{" "}
          <code className="font-mono text-xs">leave</code>.
        </p>

        <pre className={PRE}>{`const frame = document.querySelector("iframe");

function control(type) {
  frame.contentWindow.postMessage(
    { source: "grav-stream-parent", type },
    "https://live.grav.in"
  );
}

control("toggle-mic");
control("toggle-camera");
control("toggle-screen-share");
control("leave");`}</pre>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">End-to-end example</h2>

        <h3 className="font-medium">1. Backend (Node.js)</h3>
        <p className="text-sm text-zinc-500">
          One endpoint that creates the room, mints a token for the signed-in
          user, and returns just the room id and token to the browser.
        </p>

        <pre className={PRE}>{`// server.js — Express, Node 18+ (global fetch)
import express from "express";

const app = express();
app.use(express.json());

const GRAV_BASE = "https://stream.grav.in";
const GRAV_KEY = process.env.GRAV_STREAM_API_KEY; // server-side only

async function grav(path, { method = "GET", body } = {}) {
  const res = await fetch(GRAV_BASE + path, {
    method,
    headers: {
      Authorization: \`Bearer \${GRAV_KEY}\`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || \`Grav Stream request failed (\${res.status})\`);
  }
  return res.json();
}

// Your own auth decides who is allowed into which meeting.
app.post("/api/meetings", async (req, res) => {
  const user = req.user; // however you authenticate

  try {
    // 1. Create the room
    const room = await grav("/api/v1/rooms", {
      method: "POST",
      body: { name: req.body.title, maxParticipants: 30 },
    });

    // 2. Mint a token for this one user
    const minted = await grav(\`/api/v1/rooms/\${room.roomId}/tokens\`, {
      method: "POST",
      body: {
        identity: user.id,
        name: user.displayName,
        canPublish: true,
        canSubscribe: true,
        ttlSeconds: 3600,
      },
    });

    // 3. Return only what the browser needs — never the API key
    res.json({ roomId: room.roomId, token: minted.token });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(3001);`}</pre>

        <h3 className="font-medium">2. Frontend (React)</h3>

        <pre className={PRE}>{`"use client";

import { useEffect, useState } from "react";

export default function Meeting({ title }) {
  const [meeting, setMeeting] = useState(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    })
      .then((r) => r.json())
      .then(setMeeting);
  }, [title]);

  useEffect(() => {
    function onMessage(e) {
      if (!e.data || e.data.source !== "grav-stream") return;
      if (e.data.type === "participants-changed") setCount(e.data.count);
      if (e.data.type === "error") console.error(e.data.message);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (!meeting) return <p>Starting meeting…</p>;

  return (
    <div style={{ height: "80vh" }}>
      <p>{count} in the call</p>
      <iframe
        src={
          "https://live.grav.in/embed/" +
          meeting.roomId +
          "?token=" +
          encodeURIComponent(meeting.token)
        }
        allow="camera; microphone; display-capture; autoplay"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </div>
  );
}`}</pre>
      </section>
    </main>
  );
}
