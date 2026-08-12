// Encoder tuning for screen content, shared by the embed and the SDK so the
// two cannot drift apart.
//
// The failure this exists to prevent: if the encoder cannot keep up with the
// capture, and it is also forbidden from shedding load, frames queue in memory.
// The queue is unbounded, so browser memory climbs into gigabytes and every
// frame arrives seconds after it was captured. High memory and high latency
// are the same bug seen from two directions.
//
// The rule is therefore: always leave the pipeline at least one way to shed
// load. For text we want it to drop frames rather than resolution, which is
// what degradationPreference expresses — but "cannot downscale AND cannot keep
// up" must never be reachable.

/**
 * Defaults, all overridable per session.
 *
 * A hard frame-rate cap is the worst of both worlds: it makes scrolling and
 * video choppy even on a machine with capacity to spare, and it does nothing
 * for a machine that is genuinely struggling. Ask for 30 and let
 * degradationPreference drop it when the encoder cannot keep up — fast when
 * there is room, graceful when there is not.
 *
 * Note that a screen capture produces frames only when something changes, so a
 * mostly-static desktop legitimately averages a handful of frames per second.
 * That is not the encoder failing; it is nothing having happened.
 */
export const SCREEN_DEFAULTS = {
  maxWidth: 1920,
  // 1200 rather than 1080: 16:10 laptop panels are common, and an exact-fit cap
  // avoids a rescale step that costs CPU for no visible gain.
  maxHeight: 1200,
  fps: 30,
  maxBitrate: 5_000_000,
  // "detail" keeps text sharp under pressure. "motion" trades some sharpness
  // for smoothness and is more likely to engage a hardware encoder, since
  // hardware paths are tuned for camera video.
  contentHint: "detail",
};

const clamp = (value, lo, hi, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
};

/** Normalises caller-supplied overrides against sane bounds. */
export function resolveScreenSettings(options = {}) {
  return {
    maxWidth: clamp(options.maxWidth, 640, 3840, SCREEN_DEFAULTS.maxWidth),
    maxHeight: clamp(options.maxHeight, 480, 2160, SCREEN_DEFAULTS.maxHeight),
    fps: clamp(options.fps, 1, 60, SCREEN_DEFAULTS.fps),
    maxBitrate: clamp(options.maxBitrate, 250_000, 20_000_000, SCREEN_DEFAULTS.maxBitrate),
    contentHint: ["detail", "motion", "text"].includes(options.contentHint)
      ? options.contentHint
      : SCREEN_DEFAULTS.contentHint,
  };
}

/** Capture constraints for a desktop. */
export function screenVideoConstraints(options = {}) {
  const s = resolveScreenSettings(options);
  return {
    // A hint only; the picker still lets the user choose a window or a tab.
    displaySurface: "monitor",
    width: { max: s.maxWidth },
    height: { max: s.maxHeight },
    // ideal rather than exact: the browser is free to deliver fewer frames
    // when nothing is moving, which is most of the time on a desktop.
    frameRate: { ideal: s.fps, max: s.fps },
  };
}

/**
 * Encoding parameters.
 *
 * Deliberately does NOT pin scaleResolutionDownBy. Pinning it removes the
 * encoder's last escape valve, and a pipeline that cannot shed load buffers
 * instead — which is far worse for the viewer than a brief dip in sharpness.
 */
export function screenEncodings(maxBitrate = SCREEN_DEFAULTS.maxBitrate) {
  return [{ maxBitrate }];
}

export const SCREEN_CODEC_OPTIONS = { videoGoogleStartBitrate: 2500 };

/** Back-compat for callers that imported the constant form. */
export const SCREEN_VIDEO_CONSTRAINTS = screenVideoConstraints();

/**
 * Asks the sender to trade frame rate for resolution when it is under
 * pressure. This is the supported way to say "keep text sharp": unlike pinning
 * the resolution, the encoder may still fall back to downscaling as a last
 * resort rather than queueing frames.
 *
 * Best-effort — not every browser exposes it, and a failure here is not worth
 * failing a working share over.
 */
export async function preferSharpness(producer, contentHint = "detail") {
  const sender = producer?.rtpSender;
  if (!sender || typeof sender.getParameters !== "function") return null;
  try {
    const params = sender.getParameters();
    // Text wants resolution held and frame rate sacrificed; motion wants the
    // opposite. Either way the encoder keeps a way to shed load, which is what
    // stops frames queueing into memory.
    params.degradationPreference =
      contentHint === "motion" ? "maintain-framerate" : "maintain-resolution";
    await sender.setParameters(params);
    return true;
  } catch {
    return false;
  }
}

/**
 * The codec actually negotiated, e.g. "H264" or "VP8".
 *
 * Worth surfacing to integrators: VP8 encodes in software on most machines and
 * H.264 does not, so this single value explains most "why is my CPU pinned"
 * reports without anyone opening webrtc-internals.
 */
export function negotiatedCodec(producer) {
  const sender = producer?.rtpSender;
  if (!sender || typeof sender.getParameters !== "function") return null;
  try {
    const mime = sender.getParameters()?.codecs?.[0]?.mimeType;
    return mime ? mime.replace(/^video\//i, "") : null;
  } catch {
    return null;
  }
}

/**
 * Reads the encoder's own account of what it is doing.
 *
 * Everything here is invisible to the server: the negotiated codec, whether
 * the encoder is hardware, and whether the machine or the network is the
 * limiting factor all live in the browser. Reporting it is the difference
 * between diagnosing a slow session and guessing at it.
 */
export async function readEncoderStats(producer) {
  const sender = producer?.rtpSender;
  if (!sender?.getStats) return null;

  let report;
  try {
    report = await sender.getStats();
  } catch {
    return null;
  }

  let out = null;
  let remote = null;
  const codecs = new Map();
  report.forEach((s) => {
    if (s.type === "codec") codecs.set(s.id, s.mimeType);
    if (s.type === "outbound-rtp" && s.kind === "video") out = s;
    if (s.type === "remote-inbound-rtp" && s.kind === "video") remote = s;
  });
  if (!out) return null;

  return {
    codec: (codecs.get(out.codecId) || "").replace(/^video\//i, "") || null,
    // A vendor name or "ExternalEncoder" means hardware; "libvpx" and
    // "OpenH264" mean software, and a pinned CPU.
    encoder: out.encoderImplementation || null,
    hardware: out.powerEfficientEncoder ?? null,
    width: out.frameWidth ?? null,
    height: out.frameHeight ?? null,
    fps: out.framesPerSecond ?? null,
    kbps: out.targetBitrate ? Math.round(out.targetBitrate / 1000) : null,
    // "cpu" means the machine cannot keep up; "bandwidth" means the network.
    limitedBy: out.qualityLimitationReason ?? null,
    framesSent: out.framesSent ?? null,
    framesDropped: out.framesDropped ?? null,
    packetsLost: remote?.packetsLost ?? null,
    rttMs: remote?.roundTripTime != null ? Math.round(remote.roundTripTime * 1000) : null,
    paused: Boolean(producer.paused),
  };
}

/** How often a publisher reports in. Cheap enough to be continuous. */
export const STATS_INTERVAL_MS = 30_000;
