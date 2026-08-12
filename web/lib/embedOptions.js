// Presentation options for the embed, read from the iframe URL.
//
// The host application owns its own layout. If it already draws a header, a
// timer and a set of buttons, ours duplicate them and the two collide. So
// every piece of chrome can be switched off independently and driven over
// postMessage instead.
//
// Resolution order, weakest to strongest:
//   1. defaults for the room mode and the participant's role
//   2. a `ui` preset, if one was named
//   3. individual flags
//
// Parsing is split from resolution because the mode and role only arrive with
// the token, after the URL has already been read.

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function flag(value) {
  if (value == null) return undefined;
  const v = String(value).toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return undefined;
}

const PRESETS = {
  full: { header: true, controls: true, participants: true, timer: true },
  minimal: { header: false, controls: true, participants: false, timer: false },
  bare: { header: false, controls: false, participants: false, timer: false },
};

const CHROME_KEYS = ["header", "controls", "participants", "timer", "selfPreview"];

/** Reads the URL. Chrome flags stay undefined unless explicitly given. */
export function readEmbedOptions(query = {}) {
  const explicit = {};
  for (const key of CHROME_KEYS) {
    const value = flag(query[key]);
    if (value !== undefined) explicit[key] = value;
  }

  return {
    preset: PRESETS[String(query.ui || "").toLowerCase()] || null,
    explicit,
    theme: ["dark", "light"].includes(String(query.theme).toLowerCase())
      ? String(query.theme).toLowerCase()
      : "dark",
    accent: sanitizeColor(query.accent) || "#34d399",
    startLabel: typeof query.startLabel === "string" ? query.startLabel.slice(0, 40) : null,
    // Capture tuning, passed straight through and clamped by screenTuning.
    // Exposed so a host can trade sharpness for smoothness, or dial a fleet of
    // older machines down, without waiting on a release from us.
    capture: {
      fps: query.fps,
      maxWidth: query.maxWidth,
      maxHeight: query.maxHeight,
      maxBitrate: query.maxBitrate,
      contentHint: query.contentHint,
    },
  };
}

/**
 * Applies mode- and role-aware defaults, then the preset, then explicit flags.
 *
 * A screen session is not a meeting: there is no one to introduce, no call to
 * time, and nothing to leave — closing the frame ends it. So the status bar is
 * off by default, and a watcher gets no controls at all. A publisher keeps the
 * control bar because the share button lives there and the browser will not
 * open a picker without a click inside this frame.
 */
export function resolveEmbedUi(options, { mode, isViewer } = {}) {
  const screen = mode === "screen";

  const base = screen
    ? {
        header: false,
        timer: false,
        participants: false,
        controls: !isViewer,
        selfPreview: false,
      }
    : { header: true, timer: true, participants: true, controls: true, selfPreview: false };

  return {
    ...base,
    ...(options?.preset || {}),
    ...(options?.explicit || {}),
    theme: options?.theme || "dark",
    accent: options?.accent || "#34d399",
    startLabel: options?.startLabel || null,
    capture: options?.capture || {},
  };
}

// Only hex colours are accepted: the value lands in a style attribute, and
// anything looser would let a crafted URL inject arbitrary CSS.
function sanitizeColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^#?/, "#");
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null;
}
