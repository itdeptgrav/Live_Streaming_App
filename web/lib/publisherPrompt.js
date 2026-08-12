// A hand-to-your-AI brief for the one integration that trips people up:
// making the host's own button open the screen picker directly, with no
// dialog of ours in between.
//
// Kept in its own file, and deliberately free of backticks, because it is a
// long document inside a JS template literal and an unescaped backtick would
// silently truncate it.

export const PUBLISHER_PROMPT = `# Task: make our own button start a Grav Stream screen share

You are integrating Grav Stream into an existing web application.

## Goal

When the user clicks OUR button, the browser's native screen picker must open
immediately. There must be no intermediate dialog from Grav Stream, and no
second click anywhere.

## The rule that decides the whole design

Do NOT use the Grav Stream iframe for the person who is SHARING.

Browsers only allow getDisplayMedia() in the document that received the user's
click, and that permission does not cross a cross-origin iframe. So a click on
your button cannot open the picker inside Grav Stream's iframe — which is why
the iframe has its own button, and why you are currently seeing two dialogs.

Use the publisher SDK instead. It runs inside YOUR page, so your click is valid.

The iframe is still correct for people WATCHING a screen. Keep it there.

## Step 1 — backend returns token AND url

Your server calls Grav Stream with your secret API key and returns both fields
to the browser. The API key must never reach the browser.

    POST https://stream.grav.in/api/v1/rooms/:roomId/tokens
    Authorization: Bearer <GRAV_STREAM_API_KEY>
    Body:    { "identity": "...", "name": "...", "role": "publisher", "ttlSeconds": 32400 }
    Returns: { "token": "...", "url": "wss://stream.grav.in", "roomId": "...", "role": "publisher", "mode": "screen" }

Return { token, url } to your frontend. The url is the address the SDK connects
to. If you currently return only the token, add the url.

Create the room once per user with mode "screen" and store its roomId — rooms
are durable and survive restarts, so reuse it rather than creating a new one
each time.

## Step 2 — load the SDK

    <script src="https://live.grav.in/v1/grav-stream.js"></script>

No npm install and no bundler. It exposes a global named GravStream.

## Step 3 — call share() straight from your click handler

    // Fetch the credentials BEFORE the click. Browsers keep a click's
    // permission alive for only about five seconds, and a slow request inside
    // the handler can spend it, causing the picker to be refused.
    let credentials = await fetch("/api/monitoring/go-online").then(r => r.json());

    goOnlineButton.addEventListener("click", async () => {
      try {
        const session = await GravStream.share({
          token: credentials.token,
          serverUrl: credentials.url,
        });

        // Live. session.capture describes what the user actually picked:
        //   { displaySurface: "monitor" | "window" | "browser",
        //     width, height, frameRate, label, isEntireScreen }
        setOnline(session.capture);

        // Fires when the user stops from the browser's own "Stop sharing" bar,
        // or if the connection drops.
        session.on("ended", () => setOffline());

        stopButton.onclick = () => session.stop();
      } catch (err) {
        if (err.code === "CANCELLED") return;   // user dismissed the picker
        showError(err.message);
      }
    });

## What to REMOVE

- The Grav Stream iframe on the sharing screen. It is what produces the second
  "Start sharing" box.
- Any dialog of your own that exists only to explain the picker. The browser's
  picker is the prompt; a modal in front of it is one more click for no gain.

## Error codes from share()

Every rejection carries err.code. All of them are raised BEFORE any prompt
appears, except CANCELLED and PERMISSION_DENIED:

    CANCELLED               user dismissed the picker — treat as a no-op
    PERMISSION_DENIED       the browser blocked capture
    TOKEN_IS_VIEWER         you minted role "viewer" — mint role "publisher"
    TOKEN_EXPIRED           mint a fresh token
    TOKEN_REQUIRED          no token was passed
    TOKEN_INVALID           the token could not be read
    SERVER_URL_REQUIRED     you did not pass serverUrl
    ENTIRE_SCREEN_REQUIRED  only when you pass requireEntireScreen: true
    SURFACE_UNKNOWN         the browser will not report the surface
    SERVER_UNREACHABLE      could not reach the streaming server
    PUBLISH_FAILED          connected, but could not publish

## If you want to require a whole screen

By default every surface is accepted and reported. Two independent ways to act:

1. Check it yourself and decide:

       if (!session.capture.isEntireScreen) {
         warnUser(session.capture.displaySurface);   // "window" or "browser"
       }

2. Refuse it outright, by passing requireEntireScreen: true to share(). The
   share then throws ENTIRE_SCREEN_REQUIRED and never starts.

displaySurface can be null in browsers that will not report it. Treat that as
unverified rather than as compliant.

## For the people WATCHING

Keep the iframe. A viewer needs no permission and no gesture, so it connects on
its own with nothing to click:

    <iframe
      src="https://live.grav.in/embed/ROOM_ID?token=VIEWER_TOKEN"
      allow="camera; microphone; display-capture; autoplay"
      style="width:100%;height:100%;border:0"
    ></iframe>

Mint that token with role "viewer". The server rejects any publish attempt from
a viewer token, so it is a real boundary rather than a UI setting. The allow
attribute is required even for viewers.

In a screen room the watcher's iframe shows the shared screen edge to edge with
no border, no name label and no controls, so it can be dropped into your own
panel without fighting your layout.

## Quality and long sessions — already handled, do not re-implement

The SDK sets these for you. Do not override them unless you have measured a
reason to:

- Capture is capped at 1920x1200 and 10 frames per second. A desktop is mostly
  static, so the frame rate matters far more than it would for camera video,
  and halving it is the cheapest way to keep the encoder ahead of the capture.
- The encoder is ASKED to shed frame rate before sharpness, not forced to hold
  resolution. An encoder with no way to shed load queues frames in memory, and
  that queue is what sends browser memory into gigabytes while making every
  update arrive seconds late.
- H.264 is preferred over VP8, because nearly every machine has a hardware
  H.264 encoder and VP8 is software-only. This is the difference between a
  responsive machine and one that reports "not responding".
- The signaling socket is kept alive with a server-side ping, so a share that
  runs for a full working day is not cut off by an idle timeout.
- screen-share-started now reports the negotiated codec. Read it. If it says
  VP8, that machine is encoding in software and its CPU will suffer; if it says
  H264 the work is on the GPU where it belongs.

- Encoding stops entirely when nobody is subscribed, and resumes when someone
  opens the view. A screen watched a few minutes an hour costs the sharer's
  machine almost nothing for the rest of it. session.watchers and the
  "watchers" event tell you whether anyone is currently looking.

## The session survives a dropped connection

A screen capture cannot be recreated without another user gesture, so the SDK
never throws one away because the network blinked. If the socket drops it
reconnects around the same capture, with backoff, and only gives up after
about forty seconds.

Handle these so your interface tells the truth:

    session.on("reconnecting", (e) => showBanner("Reconnecting " + e.attempt + " of " + e.of));
    session.on("resumed",      () => hideBanner());
    session.on("ended",        (e) => {
      // e.reason === "disconnected" -> the connection could not be recovered
      // e.reason undefined          -> stop() was called, or the user pressed
      //                                the browser's own "Stop sharing" bar
      setOffline(e.reason);
    });

session.connected tells you the current state at any moment. Do not tear down
your own UI on "reconnecting" — the share is still alive and the user is still
sharing; only "ended" is final.

## Diagnosing a slow session

Do not report "it is slow" — call session.getStats() on the SHARING machine
while it is sharing:

    const s = await session.getStats();
    console.log(s);
    // { codec: "H264", encoder: "ExternalEncoder", hardware: true,
    //   resolution: "1920x1080", fps: 10, kbps: 2500,
    //   limitedBy: "none", framesSent, framesDropped, paused, watchers }

Read two fields first:

- codec. "VP8" means the browser is encoding in software and that machine's
  CPU will suffer no matter what else is tuned. "H264" means the work is on
  dedicated hardware, where it belongs.
- limitedBy. "cpu" means the machine cannot keep up. "bandwidth" means the
  network cannot. "none" means neither, and the problem is elsewhere.

encoder is the underlying implementation: a vendor name or "ExternalEncoder"
is hardware; "libvpx" or "OpenH264" is software.

## Full reference

https://live.grav.in/docs/llms.txt
`;

export const PUBLISHER_PROMPT_FILENAME = "grav-stream-publisher-prompt";
