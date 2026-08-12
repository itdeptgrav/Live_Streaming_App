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
// The capture and the connection have deliberately separate lifetimes. A
// screen capture cannot be recreated without another user gesture, so a
// dropped socket must never be allowed to destroy it — the connection is
// rebuilt around the surviving track instead.
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

const VERSION = "1.2.0";

// Backoff between reconnection attempts. Ends deliberately: a share that has
// been unreachable for a minute is better ended honestly than left pretending.
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 20000];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  constructor({ track, stream, capture, roomId, url, token, settings }) {
    this._track = track;
    this._stream = stream;
    this._url = url;
    this._token = token;
    this._settings = settings;

    // The current connection. Replaced wholesale on reconnect; everything else
    // about the session survives.
    this._wire = null;
    this._statsTimer = null;
    this._handlers = {};
    // Set by stop() so a deliberate close is never mistaken for a drop.
    this._stopping = false;

    this.capture = capture;
    this.roomId = roomId;
    this.active = true;
    this.connected = false;
    // True while nobody is subscribed. The share is still established; the
    // encoder is simply not being asked to do anything.
    this.idle = false;
    this.watchers = 0;
  }

  /** on("ended" | "watchers" | "reconnecting" | "resumed", handler) */
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

  _send(msg) {
    const ws = this._wire?.ws;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
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
    const stats = await readEncoderStats(this._wire?.producer);
    if (!stats) return null;
    return {
      ...stats,
      resolution: stats.width && stats.height ? `${stats.width}x${stats.height}` : null,
      connected: this.connected,
      watchers: this.watchers,
      capture: this.capture,
    };
  }

  _applyDemand(watchers) {
    this.watchers = watchers;
    const producer = this._wire?.producer;
    if (!producer) return;
    const shouldPause = watchers === 0;
    try {
      if (shouldPause && !producer.paused) producer.pause();
      else if (!shouldPause && producer.paused) producer.resume();
      this.idle = shouldPause;
    } catch {}
    this._emit("watchers", { watchers, idle: this.idle });
  }

  _startStats() {
    clearInterval(this._statsTimer);
    // Reports what the encoder is doing, for the life of the share. Without
    // this the platform can only see that bytes moved, never why a particular
    // machine struggled.
    this._statsTimer = setInterval(async () => {
      if (!this.active || !this.connected) return;
      const stats = await readEncoderStats(this._wire?.producer);
      if (stats) this._send({ type: "meet-stats", source: "screen", ...stats });
    }, STATS_INTERVAL_MS);
  }

  /** Tears down the connection but leaves the capture alone. */
  _dropWire() {
    const wire = this._wire;
    this._wire = null;
    this.connected = false;
    if (!wire) return;
    try {
      wire.ws.onclose = null;
      wire.ws.onmessage = null;
      wire.ws.onerror = null;
      // stopTracks:false at produce time, so this releases the transport
      // without touching the capture the track belongs to.
      wire.producer?.close();
      wire.sendTransport?.close();
      wire.ws.close();
    } catch {}
  }

  /** Releases the capture. Only ever called when the session is really over. */
  _releaseCapture() {
    try {
      this._track.onended = null;
      this._stream?.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  /** Stops sharing and releases the capture. Safe to call twice. */
  stop() {
    if (!this.active) return;
    this.active = false;
    this._stopping = true;
    clearInterval(this._statsTimer);
    try {
      if (this._wire?.producer) {
        this._send({ type: "meet-close-producer", producerId: this._wire.producer.id });
      }
      this._send({ type: "meet-leave" });
    } catch {}
    this._dropWire();
    this._releaseCapture();
    this._emit("ended", {});
  }
}

/**
 * Opens a connection and starts publishing the given track.
 *
 * Separated from share() so it can be run again against a surviving capture
 * when a connection drops — which is the whole point: the track is the part
 * that cannot be recreated without asking the user again.
 */
async function openWire({ url, roomId, token, track, settings, session }) {
  const ws = await openSocket(url);

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

  // Demand can be announced before this function has returned, so it is held
  // and applied once the wire is installed. The server only re-announces on
  // change, and the first notice is always "nobody is watching" — dropping it
  // would leave the encoder running for an audience of none.
  let heldDemand;

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "meet-producer-demand") {
      if (session._wire?.producer?.id === msg.producerId) session._applyDemand(msg.watchers);
      else heldDemand = msg.watchers;
      return;
    }
    if (msg.rid && pending.has(msg.rid)) {
      const p = pending.get(msg.rid);
      if (msg.type === "error") {
        const err = new GravStreamError(msg.code || "SERVER_ERROR", msg.message);
        p.reject(err);
      } else p.resolve(msg);
      return;
    }
    if (msg.type === "meet-joined") joined.resolve(msg);
    else if (msg.type === "error") {
      joined.reject(new GravStreamError(msg.code || "SERVER_ERROR", msg.message));
    }
  };

  try {
    ws.send(
      JSON.stringify({ type: "meet-join", roomId, token, client: "sdk", clientVersion: VERSION })
    );
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
      // The capture outlives any one connection, so closing a producer must
      // never stop its track — that is what made a dropped socket permanent.
      stopTracks: false,
      encodings: screenEncodings(settings.maxBitrate),
      codecOptions: SCREEN_CODEC_OPTIONS,
      appData: {
        source: "screen",
        displaySurface: session.capture.displaySurface,
        width: session.capture.width,
        height: session.capture.height,
      },
    });

    await preferSharpness(producer, settings.contentHint);
    return { ws, device, sendTransport, producer, heldDemand };
  } catch (err) {
    try {
      ws.close();
    } catch {}
    throw err instanceof GravStreamError
      ? err
      : new GravStreamError("PUBLISH_FAILED", err.message || "Could not publish the screen.");
  }
}

/** Installs a freshly opened wire on the session and resumes reporting. */
function adoptWire(session, wire) {
  session._wire = wire;
  session.connected = true;
  session.capture.codec = negotiatedCodec(wire.producer);
  session._startStats();
  session._send({ type: "meet-media-state", mic: false, camera: false, screen: true });

  if (wire.heldDemand !== undefined) session._applyDemand(wire.heldDemand);

  wire.ws.onclose = () => handleDrop(session);
}

/**
 * Rebuilds the connection around the surviving capture.
 *
 * Previously a dropped socket ended the share and stopped the tracks, so a
 * momentary network blip cost the user their session and another click. The
 * capture is the only irreplaceable part; everything else is rebuilt.
 */
async function handleDrop(session) {
  if (!session.active || session._stopping) return;

  session.connected = false;
  clearInterval(session._statsTimer);
  session._dropWire();

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (!session.active || session._stopping) return;

    session._emit("reconnecting", {
      attempt: attempt + 1,
      of: RETRY_DELAYS_MS.length,
      inMs: RETRY_DELAYS_MS[attempt],
    });
    await sleep(RETRY_DELAYS_MS[attempt]);
    if (!session.active || session._stopping) return;

    // A capture the user stopped from the browser's own bar cannot be revived,
    // so there is nothing left to reconnect for.
    if (session._track.readyState !== "live") break;

    try {
      const wire = await openWire({
        url: session._url,
        roomId: session.roomId,
        token: session._token,
        track: session._track,
        settings: session._settings,
        session,
      });
      adoptWire(session, wire);
      session._emit("resumed", { attempts: attempt + 1 });
      return;
    } catch {
      // Try again; the loop's own guard decides when to give up.
    }
  }

  session.active = false;
  session._releaseCapture();
  session._emit("ended", { reason: "disconnected" });
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
 * @param {number} [opts.maxBitrate]
 * @param {number} [opts.fps]
 * @param {number} [opts.maxWidth]
 * @param {number} [opts.maxHeight]
 * @param {string} [opts.contentHint] "detail" (default) or "motion"
 * @returns {Promise<Session>}
 */
export async function share(opts = {}) {
  const { token, serverUrl, requireEntireScreen = false } = opts;
  if (!token) throw new GravStreamError("TOKEN_REQUIRED", "A room token is required.");

  const claims = readClaims(token);
  if (!claims) throw new GravStreamError("TOKEN_INVALID", "The room token could not be read.");
  if (claims.canPublish === false) {
    throw new GravStreamError(
      "TOKEN_IS_VIEWER",
      'This token is a viewer token and cannot publish. Mint one with role: "publisher".'
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

  const settings = resolveScreenSettings(opts);

  // ---- capture first, while the user gesture is still valid ----
  // Anything awaited before this consumes the activation and the picker is
  // refused, so the network connection is deliberately opened afterwards.
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: screenVideoConstraints(opts),
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

  if ("contentHint" in track) track.contentHint = settings.contentHint;

  const session = new Session({
    track,
    stream,
    capture,
    roomId: claims.room,
    url,
    token,
    settings,
  });

  let wire;
  try {
    wire = await openWire({
      url,
      roomId: claims.room,
      token,
      track,
      settings,
      session,
    });
  } catch (err) {
    // Nothing was established, so the capture is ours to release.
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  adoptWire(session, wire);

  // The browser's own "Stop sharing" bar ends the track without telling us,
  // and that ending is final — there is no capture left to reconnect around.
  track.onended = () => session.stop();

  return session;
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
