import { screenVideoConstraints, resolveScreenSettings } from "./screenTuning";

// Screen capture with surface reporting and policy enforcement.
//
// A monitoring product cares *which* surface was picked: sharing one browser
// tab is not evidence of anything. getDisplayMedia's `displaySurface`
// constraint is only a HINT — the browser's picker still lets the user choose
// anything — so the selection must be verified after the fact, not requested
// and assumed.

/** What the browser reports, normalised. Null when it declines to say. */
export function describeCapture(track) {
  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  return {
    displaySurface: settings.displaySurface || null,
    width: settings.width || null,
    height: settings.height || null,
    frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
    label: track.label || null,
  };
}

export class ScreenCaptureError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

/**
 * Prompts for a screen and returns { stream, track, capture }.
 *
 * Throws ScreenCaptureError with a `code` the UI can branch on:
 *   CANCELLED               - user dismissed the picker
 *   PERMISSION_DENIED       - blocked by the browser or a missing iframe allow=
 *   EMBED_NOT_VISIBLE       - the iframe is hidden, so no picker can open
 *   ENTIRE_SCREEN_REQUIRED  - policy wanted a whole display, user picked otherwise
 *   SURFACE_UNKNOWN         - policy applies but the browser won't report the surface
 *   NO_VIDEO_TRACK          - capture produced nothing usable
 */
export async function captureScreen({ requireEntireScreen = false, settings } = {}) {
  const tuning = resolveScreenSettings(settings || {});
  // The picker is opened by THIS frame, so this frame has to be on screen when
  // it happens. A hidden or zero-sized iframe gets no picker and, in some
  // browsers, no error either — it simply never resolves. Fail loudly instead,
  // because a silent no-op here looks like a broken product.
  if (window.innerWidth === 0 || window.innerHeight === 0) {
    throw new ScreenCaptureError(
      "EMBED_NOT_VISIBLE",
      "The screen picker cannot open because this view is hidden. Make the " +
        "Grav Stream iframe visible before starting a share — it cannot be " +
        "display:none, zero-sized, or behind another element."
    );
  }
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    throw new ScreenCaptureError(
      "EMBED_NOT_VISIBLE",
      "The screen picker cannot open while this tab is in the background. " +
        "Return to the tab and try again."
    );
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: screenVideoConstraints(tuning),
      audio: false,
      // Keep the picker focused on real screens and stop the capture preview
      // from being offered as a capture target (the infinite-mirror problem).
      monitorTypeSurfaces: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
    });
  } catch (err) {
    // Chrome reports a dismissed picker and a blocked permission with the same
    // NotAllowedError, separable only by whether a prompt was ever shown.
    if (err.name === "NotAllowedError" && /permission|disallowed|denied by system/i.test(err.message)) {
      throw new ScreenCaptureError(
        "PERMISSION_DENIED",
        "Screen sharing is blocked by the browser. If this page is embedded, the " +
          'iframe needs allow="display-capture".'
      );
    }
    if (err.name === "NotAllowedError") {
      throw new ScreenCaptureError("CANCELLED", "Screen sharing was cancelled.");
    }
    throw new ScreenCaptureError("PERMISSION_DENIED", err.message || "Could not start screen capture.");
  }

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new ScreenCaptureError("NO_VIDEO_TRACK", "The selected source produced no video.");
  }

  const capture = describeCapture(track);

  if (requireEntireScreen && capture.displaySurface !== "monitor") {
    stream.getTracks().forEach((t) => t.stop());
    if (!capture.displaySurface) {
      throw new ScreenCaptureError(
        "SURFACE_UNKNOWN",
        "This browser will not report which surface you picked, so an " +
          "entire-screen requirement cannot be verified. Please use Chrome or Edge.",
        { capture }
      );
    }
    throw new ScreenCaptureError(
      "ENTIRE_SCREEN_REQUIRED",
      "You need to share your entire screen, not a single window or tab.",
      { capture }
    );
  }

  // Tells the encoder this is text and UI rather than motion video: keeps text
  // legible and stops aggressive downscaling of a mostly-static screen.
  if ("contentHint" in track) track.contentHint = tuning.contentHint;

  return { stream, track, capture };
}
