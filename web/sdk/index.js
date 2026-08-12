// Grav Stream publisher SDK.
//
// Exists for one reason: getDisplayMedia needs user activation in the document
// that calls it, and activation does not cross a cross-origin iframe boundary.
// Running here — in the host page — means the host's own button works, with no
// second click and no visible frame.
//
// Publishing only. Watching stays on the iframe, which has no gesture
// constraint and already handles video rendering.
//
//   <script src="https://live.grav.in/v1/grav-stream.js"></script>
//   const session = await GravStream.share({ token, serverUrl });
//
import { Device } from "mediasoup-client";
import {
  screenVideoConstraints,
  resolveScreenSettings,
  screenEncodings,
  SCREEN_CODEC_OPTIONS,
  preferSharpness,
  negotiatedCodec,
  readEncoderStats,
  STATS_INTERVAL_MS,
} from "../lib/screenTuning.js";

const VERSION = "1.0.0";

function readClaims(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export class GravStreamError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "GravStreamError";
    this.code = code;
    Object.assign(this, detail);
  }
}

/** What the browser reports about the captured surface. */
function describeCapture(track) {
  const s = typeof track.getSettings === "function" ? track.getSettings() : {};
  return {
    displaySurface: s.displaySurface || null,
    width: s.width || null,
    height: s.height || null,
    frameRate: s.frameRate ? Math.round(s.frameRate) : null,
    label: track.label || null,
    isEntireScreen: s.displaySurface === "monitor",
  };
}

class Session {
  constructor({ ws, device, sendTransport, producer, stream, capture, roomId }) {
    this._ws = ws;
    this._device = device;
    this._sendTransport = sendTransport;
    this._producer = producer;
    this._stream = stream;
    this.capture = capture;
    this.roomId = roomId;
    this.active = true;
    // True while nobody is subscribed. The share is still established; the
    // encoder is simply not being asked to do anything.
    this.idle = false;
    this.watchers = 0;
    this._handlers = {};
  }

  /** on("ended" | "watchers", handler) */
  on(event, handler) {
    (this._handlers[event] ||= []).push(handler);
    return this;
  }

  _emit(event, payload) {
    for (const h of this._handlers[event] || []) {
      try {
        h(payload);
      } catch (err) {
        console.error("[grav-stream] handler threw:", err);
      }
    }
  }

  /**
   * A compact snapshot of what the encoder is actually doing.
   *
   * Exists because "it is slow" is not diagnosable. The two fields that settle
   * almost every report are `codec` (VP8 means software encoding, and a pinned
   * CPU) and `limitedBy` ("cpu" means the machine cannot keep up, "bandwidth"
   * means the network cannot).
   */
  async getStats() {
    const sender = this._producer?.rtpSender;
    if (!sender?.getStats) return null;
    const report = await sender.getStats();

    let out = null;
    let codec = null;
    const codecs = new Map();
    report.forEach((s) => {
      if (s.type === "codec") codecs.set(s.id, s.mimeType);
      if (s.type === "outbound-rtp" && s.kind === "video") out = s;
    });
    if (out?.codecId) codec = codecs.get(out.codecId);

    return {
      codec: (codec || "unknown").replace(/^video\//i, ""),
      // "ExternalEncoder" / a vendor name means hardware. "libvpx" or
      // "OpenH264" means software, and that machine will struggle.
      encoder: out?.encoderImplementation || "unknown",
      hardware: out?.powerEfficientEncoder ?? null,
      resolution: out ? `${out.frameWidth}x${out.frameHeight}` : null,
      fps: out?.framesPerSecond ?? null,
      kbps: out?.targetBitrate ? Math.round(out.targetBitrate / 1000) : null,
      // "cpu" is the machine failing to keep up; "bandwidth" is the network.
      limitedBy: out?.qualityLimitationReason ?? null,
      framesSent: out?.framesSent ?? null,
      framesDropped: out?.framesDropped ?? null,
      paused: Boolean(this._producer?.paused),
      watchers: this.watchers,
      capture: this.capture,
    };
  }

  /** Stops sharing and releases the capture. Safe to call twice. */
  stop() {
    if (!this.active) return;
    this.active = false;
    if (this._statsTimer) clearInterval(this._statsTimer);
    try {
      if (this._producer && this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: "meet-close-producer", producerId: this._producer.id }));
      }
      this._producer?.close();
    } catch {}
    this._stream?.getTracks().forEach((t) => t.stop());
    try {
      this._sendTransport?.close();
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: "meet-leave" }));
      }
      this._ws?.close();
    } catch {}
    this._emit("ended", {});
  }
}

/**
 * Prompts for a screen and publishes it.
 *
 * MUST be called synchronously from a user gesture (a click handler), or the
 * browser will refuse to open the picker.
 *
 * @param {object}  opts
 * @param {string}  opts.token       Room token minted by your backend.
 * @param {string} [opts.serverUrl]  wss:// URL. Defaults to the `url` your
 *                                   backend received alongside the token.
 * @param {boolean}[opts.requireEntireScreen] Refuse window/tab locally too.
 * @param {number} [opts.maxBitrate]  Default 5 Mbps.
 * @param {number} [opts.fps]         Default 30. Capture produces frames only
 *                                    when the screen changes, so a static
 *                                    desktop still averages far less.
 * @param {number} [opts.maxWidth]    Default 1920.
 * @param {number} [opts.maxHeight]   Default 1200.
 * @param {string} [opts.contentHint] "detail" (default, sharp text) or
 *                                    "motion" (smoother, more likely to use a
 *                                    hardware encoder).
 * @returns {Promise<Session>}
 */
export async function share({
  token,
  serverUrl,
  requireEntireScreen = false,
  ...tuning
} = {}) {
  const settings = resolveScreenSettings(tuning);
  if (!token) throw new GravStreamError("TOKEN_REQUIRED", "A room token is required.");

  const claims = readClaims(token);
  if (!claims) throw new GravStreamError("TOKEN_INVALID", "The room token could not be read.");
  if (claims.canPublish === false) {
    throw new GravStreamError(
      "TOKEN_IS_VIEWER",
      "This token is a viewer token and cannot publish. Mint one with role: \"publisher\"."
    );
  }
  if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) {
    throw new GravStreamError("TOKEN_EXPIRED", "This room token has expired.");
  }

  const url = serverUrl || claims.url;
  if (!url) {
    throw new GravStreamError(
      "SERVER_URL_REQUIRED",
      "Pass serverUrl — the wss:// address your backend received with the token."
    );
  }
  const roomId = claims.room;

  // ---- capture first, while the user gesture is still valid ----
  // Anything awaited before this consumes the activation and the picker is
  // refused, so the network connection is deliberately opened afterwards.
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: screenVideoConstraints(settings),
      audio: false,
      monitorTypeSurfaces: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
    });
  } catch (err) {
    if (err.name === "NotAllowedError" && /permission|disallowed|denied by system/i.test(err.message)) {
      throw new GravStreamError("PERMISSION_DENIED", "Screen sharing is blocked by the browser.");
    }
    if (err.name === "NotAllowedError") {
      throw new GravStreamError("CANCELLED", "Screen sharing was cancelled.");
    }
    throw new GravStreamError("CAPTURE_FAILED", err.message || "Could not start screen capture.");
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new GravStreamError("NO_VIDEO_TRACK", "The selected source produced no video.");
  }

  const capture = describeCapture(track);

  if (requireEntireScreen && !capture.isEntireScreen) {
    stream.getTracks().forEach((t) => t.stop());
    throw new GravStreamError(
      capture.displaySurface ? "ENTIRE_SCREEN_REQUIRED" : "SURFACE_UNKNOWN",
      capture.displaySurface
        ? "You need to share your entire screen, not a single window or tab."
        : "This browser will not report which surface was picked.",
      { capture }
    );
  }

  // Tells the encoder what kind of content this is, which decides whether it
  // protects sharpness or smoothness when it has to choose.
  if ("contentHint" in track) track.contentHint = settings.contentHint;

  // ---- connect and publish ----
  let ws;
  try {
    ws = await openSocket(url);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  const pending = new Map();
  let rid = 0;
  const request = (msg) =>
    new Promise((resolve, reject) => {
      const id = `s${++rid}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new GravStreamError("TIMEOUT", `${msg.type} timed out.`));
      }, 15000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ ...msg, rid: id }));
    });

  let joined;
  const joinedPromise = new Promise((resolve, reject) => {
    joined = { resolve, reject };
  });

  // Assigned once the session exists; the socket starts receiving before then.
  let live = null;
  // The server announces demand the moment a producer is created, which can
  // land before this client has finished building its Session. The server only
  // re-announces on change, so a dropped first notice — always "nobody is
  // watching" — would leave the encoder running forever. Hold it instead.
  const pendingDemand = new Map();

  const applyDemand = (session, watchers) => {
    session.watchers = watchers;
    const shouldPause = watchers === 0;
    try {
      if (shouldPause && !session._producer.paused) session._producer.pause();
      else if (!shouldPause && session._producer.paused) session._producer.resume();
      session.idle = shouldPause;
    } catch {}
    session._emit("watchers", { watchers, idle: session.idle });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // Nobody is watching, so stop encoding. A monitored screen is looked at
    // for a few minutes an hour; the rest of the time the sharer's machine
    // should be left alone rather than encoding frames nobody receives.
    if (msg.type === "meet-producer-demand") {
      if (live && msg.producerId === live._producer?.id) applyDemand(live, msg.watchers);
      else pendingDemand.set(msg.producerId, msg.watchers);
      return;
    }

    if (msg.rid && pending.has(msg.rid)) {
      const p = pending.get(msg.rid);
      if (msg.type === "error") p.reject(new GravStreamError(msg.code || "SERVER_ERROR", msg.message));
      else p.resolve(msg);
      return;
    }
    if (msg.type === "meet-joined") joined.resolve(msg);
    else if (msg.type === "error") joined.reject(new GravStreamError(msg.code || "SERVER_ERROR", msg.message));
  };

  const cleanup = () => {
    stream.getTracks().forEach((t) => t.stop());
    try {
      ws.close();
    } catch {}
  };

  try {
    ws.send(JSON.stringify({ type: "meet-join", roomId, token }));
    const joinInfo = await joinedPromise;

    const device = new Device();
    await device.load({ routerRtpCapabilities: joinInfo.rtpCapabilities });

    const info = await request({ type: "meet-create-transport", direction: "send" });
    const sendTransport = device.createSendTransport({
      id: info.transportId,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
    });

    sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
      request({ type: "meet-connect-transport", transportId: sendTransport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
    sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      request({
        type: "meet-produce",
        transportId: sendTransport.id,
        kind,
        rtpParameters,
        source: appData?.source,
        displaySurface: appData?.displaySurface,
        width: appData?.width,
        height: appData?.height,
      })
        .then((reply) => callback({ id: reply.producerId }))
        .catch(errback);
    });

    const producer = await sendTransport.produce({
      track,
      encodings: screenEncodings(settings.maxBitrate),
      codecOptions: SCREEN_CODEC_OPTIONS,
      appData: {
        source: "screen",
        displaySurface: capture.displaySurface,
        width: capture.width,
        height: capture.height,
      },
    });

    // Shed frame rate rather than sharpness under load. Expressed through
    // degradationPreference rather than by pinning the resolution, so the
    // encoder keeps a way to fall back further — without one, frames queue in
    // memory and both latency and memory climb without bound.
    await preferSharpness(producer, settings.contentHint);
    capture.codec = negotiatedCodec(producer);

    const session = new Session({
      ws,
      device,
      sendTransport,
      producer,
      stream,
      capture,
      roomId,
    });
    live = session;
    // Anything that arrived while the session was still being built.
    if (pendingDemand.has(producer.id)) applyDemand(session, pendingDemand.get(producer.id));

    // Report what the encoder is doing, for the life of the share. Without
    // this the platform can only see that bytes moved, never why a particular
    // machine struggled.
    const statsTimer = setInterval(async () => {
      if (!session.active || ws.readyState !== WebSocket.OPEN) return;
      const stats = await readEncoderStats(producer);
      if (stats) ws.send(JSON.stringify({ type: "meet-stats", source: "screen", ...stats }));
    }, STATS_INTERVAL_MS);
    session._statsTimer = statsTimer;

    // The browser's own "Stop sharing" bar ends the track without telling us.
    track.onended = () => session.stop();
    ws.onclose = () => {
      if (session.active) {
        session.active = false;
        session._stream?.getTracks().forEach((t) => t.stop());
        session._emit("ended", { reason: "disconnected" });
      }
    };

    // Report the surface even when nothing is being enforced, so the host can
    // apply its own policy.
    ws.send(
      JSON.stringify({ type: "meet-media-state", mic: false, camera: false, screen: true })
    );

    return session;
  } catch (err) {
    cleanup();
    throw err instanceof GravStreamError
      ? err
      : new GravStreamError("PUBLISH_FAILED", err.message || "Could not publish the screen.");
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {}
      reject(new GravStreamError("SERVER_UNREACHABLE", "Timed out reaching the streaming server."));
    }, 15000);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GravStreamError("SERVER_UNREACHABLE", "Could not reach the streaming server."));
    };
  });
}

export const version = VERSION;

const GravStream = { share, version: VERSION, GravStreamError };
export default GravStream;
