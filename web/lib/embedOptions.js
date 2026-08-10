// Presentation options for the embed, read from the iframe URL.
//
// The host application owns its own layout. If it already draws a header, a
// timer and a set of buttons, ours duplicate them and the two collide. So
// every piece of chrome can be switched off independently and driven over
// postMessage instead.

const TRUE = new Set(["1", "true", "yes", "on"]);
const FALSE = new Set(["0", "false", "no", "off"]);

function flag(value, fallback) {
  if (value == null) return fallback;
  const v = String(value).toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

// Presets are the common cases; individual flags still win over them.
const PRESETS = {
  full: { header: true, controls: true, participants: true, timer: true },
  minimal: { header: false, controls: true, participants: false, timer: false },
  bare: { header: false, controls: false, participants: false, timer: false },
};

/** Accepts a plain object of query params (already decoded). */
export function readEmbedOptions(query = {}) {
  const preset = PRESETS[String(query.ui || "").toLowerCase()] || PRESETS.full;

  return {
    header: flag(query.header, preset.header),
    controls: flag(query.controls, preset.controls),
    participants: flag(query.participants, preset.participants),
    timer: flag(query.timer, preset.timer),
    // A screen-mode publisher normally gets a text confirmation rather than a
    // mirror of their own display. Hosts that want the preview can ask for it.
    selfPreview: flag(query.selfPreview, false),
    theme: ["dark", "light"].includes(String(query.theme).toLowerCase())
      ? String(query.theme).toLowerCase()
      : "dark",
    accent: sanitizeColor(query.accent) || "#34d399",
    // Shown in place of the default "Start sharing" wording.
    startLabel: typeof query.startLabel === "string" ? query.startLabel.slice(0, 40) : null,
  };
}

// Only hex colours are accepted: the value lands in a style attribute, and
// anything looser would let a crafted URL inject arbitrary CSS.
function sanitizeColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^#?/, "#");
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : null;
}
