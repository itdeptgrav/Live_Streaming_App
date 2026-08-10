"use client";

// The embeddable surface. One URL serves two very different jobs, decided by
// the token's role:
//
//   publisher - shares a screen (or camera, in meeting rooms)
//   viewer    - watches, and is never asked for camera or microphone
//
// Everything the host page needs is delivered over postMessage, so integrating
// products need no SDK and no WebRTC code.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readRoomTokenClaims, surfaceLabel } from "@/lib/roomToken";
import { resolveEmbedUi } from "@/lib/embedOptions";
import { captureScreen } from "@/lib/screenCapture";
import { useRoomConnection } from "./useRoomConnection";

const CHANNEL = "grav-stream";
const PARENT_CHANNEL = "grav-stream-parent";

export default function EmbedRoom({ roomId, token, parentOrigin = "*", options }) {
  const claims = useMemo(() => readRoomTokenClaims(token), [token]);

  const originRef = useRef(parentOrigin);
  useEffect(() => {
    originRef.current = parentOrigin;
  }, [parentOrigin]);

  const emit = useCallback((type, payload = {}) => {
    if (typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ source: CHANNEL, type, ...payload }, originRef.current);
  }, []);

  const room = useRoomConnection({ roomId, token, onEvent: emit });
  const {
    phase,
    error,
    setError,
    session,
    peers,
    videoTracks,
    audioTracks,
    connect,
    publish,
    unpublish,
    reportMediaState,
    requestKeyFrame,
    disconnect,
  } = room;

  // Server-confirmed values win; token claims only bridge the first paint.
  const role = session?.role || claims?.role || "publisher";
  const mode = session?.mode || claims?.mode || "meeting";
  const requireEntireScreen = session?.requireEntireScreen ?? claims?.requireEntireScreen ?? false;
  const isViewer = role === "viewer";

  // Chrome depends on what kind of session this is, so it cannot be settled
  // until the token has told us the mode and the role.
  const ui = useMemo(
    () => resolveEmbedUi(options, { mode, isViewer }),
    [options, mode, isViewer]
  );

  const [sharing, setSharing] = useState(null); // { capture }
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // Whether a producer exists at all, as opposed to whether it is currently
  // unmuted. State rather than a ref read, so the controls appear the moment
  // publishing succeeds.
  const [hasMic, setHasMic] = useState(false);
  const [hasCamera, setHasCamera] = useState(false);

  const screenStreamRef = useRef(null);
  const screenProducerRef = useRef(null);
  const micProducerRef = useRef(null);
  const cameraProducerRef = useRef(null);
  const localStreamRef = useRef(null);
  const localScreenVideoRef = useRef(null);
  const localCameraVideoRef = useRef(null);

  const readySentRef = useRef(false);
  useEffect(() => {
    if (readySentRef.current) return;
    readySentRef.current = true;
    emit("ready", { roomId, role: claims?.role, mode: claims?.mode });
  }, [emit, roomId, claims]);

  // Checked in an effect rather than during render: reading the clock while
  // rendering is impure, and an expiry that lands mid-session should surface
  // as an error rather than silently swapping the whole view.
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!claims?.expiresAt) return;
    const check = () => setExpired(claims.expiresAt < Date.now());
    check();
    const timer = setInterval(check, 30000);
    return () => clearInterval(timer);
  }, [claims]);

  // ---------------- connect ----------------

  // Held in a ref because enableCameraAndMic is defined below and startSession
  // only ever calls it asynchronously, after the user has already gestured.
  const enableDevicesRef = useRef(null);

  const startSession = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await connect({ needsSendTransport: !isViewer });
      // Meeting rooms are camera-first, and the click that got us here is a
      // valid user gesture for the permission prompt. Screen rooms deliberately
      // do NOT do this — an employee sharing a screen is never asked for a
      // camera or microphone.
      if (!isViewer && mode !== "screen") {
        await enableDevicesRef.current?.();
      }
    } catch {
      // connect() already surfaced the message.
    } finally {
      setBusy(false);
    }
  }, [connect, isViewer, mode, setError]);

  // Everyone connects on load. Joining a room needs no permission and no
  // gesture, so making the user click through a lobby of ours first was pure
  // ceremony. Only getDisplayMedia genuinely requires a gesture, so the screen
  // button is the one thing that survives.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (!token || autoJoinedRef.current || phase !== "idle") return;
    autoJoinedRef.current = true;
    startSession();
  }, [token, phase, startSession]);

  useEffect(() => {
    if (phase !== "live") return;
    reportMediaState({ mic: micOn, camera: cameraOn, screen: Boolean(sharing) });
    emit("media-state", { mic: micOn, camera: cameraOn, screen: Boolean(sharing) });
  }, [micOn, cameraOn, sharing, phase, reportMediaState, emit]);

  // ---------------- screen sharing ----------------

  const stopScreenShare = useCallback(
    ({ silent = false } = {}) => {
      unpublish(screenProducerRef.current);
      screenProducerRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setSharing(null);
      if (!silent) emit("screen-share-stopped", {});
    },
    [unpublish, emit]
  );

  const startScreenShare = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const { stream, track, capture } = await captureScreen({ requireEntireScreen });
      screenStreamRef.current = stream;

      try {
        screenProducerRef.current = await publish({
          track,
          source: "screen",
          displaySurface: capture.displaySurface,
          width: capture.width,
          height: capture.height,
          encodings: [{ maxBitrate: 3_000_000 }],
          codecOptions: { videoGoogleStartBitrate: 1000 },
        });
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
        throw err;
      }

      setSharing({ capture });
      // isEntireScreen saves every integrator from re-deriving the same check.
      emit("screen-share-started", {
        ...capture,
        isEntireScreen: capture.displaySurface === "monitor",
      });

      // The browser's own "Stop sharing" bar ends the track without telling us.
      track.onended = () => stopScreenShare();
    } catch (err) {
      if (err.code === "CANCELLED") {
        emit("screen-share-cancelled", {});
      } else {
        setError(err.message);
        emit("error", { message: err.message, code: err.code, capture: err.capture });
      }
    } finally {
      setBusy(false);
    }
  }, [requireEntireScreen, publish, emit, setError, stopScreenShare]);

  // ---------------- camera / mic (meeting rooms) ----------------

  const enableCameraAndMic = useCallback(async () => {
    setError(null);
    setBusy(true);
    // Requested separately so a busy or missing webcam cannot block audio too.
    let audioTrack = null;
    let videoTrack = null;
    try {
      const a = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = a.getAudioTracks()[0] || null;
    } catch {}
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      videoTrack = v.getVideoTracks()[0] || null;
    } catch {}

    if (!audioTrack && !videoTrack) {
      const message =
        "Camera and microphone are unavailable. Check the browser permission " +
        'prompt, and if this page is embedded, that the iframe has allow="camera; microphone".';
      setError(message);
      emit("error", { message, code: "DEVICE_PERMISSION_DENIED" });
      setBusy(false);
      return;
    }

    localStreamRef.current = new MediaStream([audioTrack, videoTrack].filter(Boolean));
    try {
      if (audioTrack) {
        micProducerRef.current = await publish({ track: audioTrack, source: "mic" });
        setHasMic(true);
        setMicOn(true);
      }
      if (videoTrack) {
        cameraProducerRef.current = await publish({ track: videoTrack, source: "camera" });
        setHasCamera(true);
        setCameraOn(true);
      }
    } catch (err) {
      setError(err.message);
      emit("error", { message: err.message, code: err.code });
    }
    setBusy(false);
  }, [publish, emit, setError]);

  useEffect(() => {
    enableDevicesRef.current = enableCameraAndMic;
  }, [enableCameraAndMic]);

  // Pausing the producer stops sending RTP entirely. Flipping track.enabled
  // instead would keep transmitting black frames and silence, wasting the
  // uplink on a connection we do not control.
  const toggleMic = useCallback(() => {
    const producer = micProducerRef.current;
    if (!producer) return;
    const next = producer.paused;
    next ? producer.resume() : producer.pause();
    setMicOn(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const producer = cameraProducerRef.current;
    if (!producer) return;
    const next = producer.paused;
    next ? producer.resume() : producer.pause();
    setCameraOn(next);
  }, []);

  const leave = useCallback(() => {
    stopScreenShare({ silent: true });
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    disconnect();
    emit("left", {});
  }, [stopScreenShare, disconnect, emit]);

  // ---------------- local previews ----------------

  useEffect(() => {
    if (localScreenVideoRef.current && screenStreamRef.current) {
      localScreenVideoRef.current.srcObject = screenStreamRef.current;
    }
  }, [sharing]);

  useEffect(() => {
    if (localCameraVideoRef.current && localStreamRef.current) {
      localCameraVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [cameraOn, phase]);

  // ---------------- parent control channel ----------------

  useEffect(() => {
    function onMessage(event) {
      if (event.data?.source !== PARENT_CHANNEL) return;
      switch (event.data.type) {
        case "start-screen-share":
          if (!isViewer && !sharing) startScreenShare();
          break;
        case "stop-screen-share":
          if (sharing) stopScreenShare();
          break;
        case "toggle-screen-share":
          if (isViewer) break;
          sharing ? stopScreenShare() : startScreenShare();
          break;
        case "toggle-mic":
          toggleMic();
          break;
        case "toggle-camera":
          toggleCamera();
          break;
        case "leave":
          leave();
          break;
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isViewer, sharing, startScreenShare, stopScreenShare, toggleMic, toggleCamera, leave]);

  // ---------------- derived view data ----------------

  const peerName = useCallback(
    (peerId) => peers.find((p) => p.peerId === peerId)?.name || "Participant",
    [peers]
  );
  const screenFeeds = videoTracks.filter((t) => t.source === "screen");
  const cameraFeeds = videoTracks.filter((t) => t.source !== "screen");
  const publishers = peers.filter((p) => p.role !== "viewer");

  // ---------------- render ----------------

  if (!token || !claims) {
    return (
      <Shell>
        <Notice
          tone="warn"
          title="This session link is not valid"
          body="No room token was supplied. Your application must mint a token server-side and include it in the embed URL."
        />
      </Shell>
    );
  }

  if (expired && phase !== "live") {
    return (
      <Shell>
        <Notice
          tone="warn"
          title="This session link has expired"
          body="Room tokens are short-lived. Refresh the page in your application to request a new one."
        />
      </Shell>
    );
  }

  if (phase === "ended") {
    return (
      <Shell>
        <Notice title="Session ended" body="You have left this session." />
      </Shell>
    );
  }

  const light = ui.theme === "light";

  // A screen session is edge-to-edge video: padding and gaps would letterbox
  // someone's desktop for no reason.
  const screenStage = mode === "screen" && (sharing || screenFeeds.length > 0);
  // The only permanent mark. Appears once a screen is actually live, and is
  // kept deliberately quiet — it identifies the platform, it does not sell it.
  const showWatermark = screenStage;

  return (
    <div
      style={{ "--accent": ui.accent }}
      className={`relative flex h-dvh w-full flex-col ${
        light ? "bg-white text-zinc-900" : "bg-[#09090b] text-zinc-100"
      }`}
    >
      {showWatermark && <Watermark light={light} />}
      {ui.header && (
        <TopBar
          role={role}
          mode={mode}
          phase={phase}
          sharing={sharing}
          watching={publishers}
          selfName={session?.name || claims.name}
          showTimer={ui.timer}
          light={light}
        />
      )}

      <div
        className={`relative flex min-h-0 flex-1 flex-col ${
          screenStage ? "" : "gap-3 p-3"
        }`}
      >
        {error && <ErrorBar message={error} onDismiss={() => setError(null)} />}

        {/* ---- viewer ---- */}
        {isViewer && (
          <ViewerStage
            screenMode={mode === "screen"}
            phase={phase}
            screenFeeds={screenFeeds}
            cameraFeeds={cameraFeeds}
            peerName={peerName}
            publishers={publishers}
            requestKeyFrame={requestKeyFrame}
          />
        )}

        {/* ---- publisher ---- */}
        {!isViewer && phase !== "live" && (
          <Connecting phase={phase} onRetry={startSession} />
        )}

        {!isViewer && phase === "live" && (
          <PublisherStage
            mode={mode}
            sharing={sharing}
            busy={busy}
            requireEntireScreen={requireEntireScreen}
            localScreenVideoRef={localScreenVideoRef}
            localCameraVideoRef={localCameraVideoRef}
            cameraOn={cameraOn}
            hasCamera={hasCamera}
            onStartShare={startScreenShare}
            onEnableDevices={enableCameraAndMic}
            screenFeeds={screenFeeds}
            cameraFeeds={cameraFeeds}
            peerName={peerName}
            requestKeyFrame={requestKeyFrame}
            selfPreview={ui.selfPreview}
            startLabel={ui.startLabel}
            quiet={!ui.header && !ui.controls}
          />
        )}
      </div>

      {/* Before a screen share starts, the centred button is the whole call to
          action — a second "Share screen" in a control bar underneath is the
          same command twice. The bar returns once sharing begins, to offer Stop. */}
      {phase === "live" && ui.controls && (mode !== "screen" || sharing) && (
        <ControlBar
          isViewer={isViewer}
          light={light}
          showParticipants={ui.participants}
          mode={mode}
          sharing={sharing}
          busy={busy}
          micOn={micOn}
          cameraOn={cameraOn}
          hasMic={hasMic}
          hasCamera={hasCamera}
          participantCount={peers.length + 1}
          onToggleShare={sharing ? () => stopScreenShare() : startScreenShare}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onLeave={leave}
          screenMode={mode === "screen"}
        />
      )}

      {audioTracks.map((t) => (
        <RemoteAudio key={t.producerId} stream={t.stream} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* presentational pieces                                               */
/* ------------------------------------------------------------------ */

function Shell({ children }) {
  return (
    <div className="grid h-dvh w-full place-items-center bg-[#09090b] p-6 text-zinc-100">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

function Notice({ title, body, tone = "neutral" }) {
  const ring = tone === "warn" ? "ring-amber-500/30" : "ring-white/10";
  return (
    <div className={`rounded-xl bg-white/5 p-5 ring-1 ${ring}`}>
      <h1 className="text-sm font-semibold">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{body}</p>
    </div>
  );
}

function Watermark({ light }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute right-2 bottom-1.5 z-10 text-[10px] font-normal tracking-wide select-none ${
        light ? "text-zinc-900/25" : "text-white/25"
      }`}
    >
      Grav Stream
    </span>
  );
}

function ErrorBar({ message, onDismiss }) {
  return (
    <div className="flex shrink-0 items-start gap-3 rounded-lg bg-red-500/10 px-3 py-2.5 ring-1 ring-red-500/25">
      <p className="flex-1 text-[13px] leading-relaxed text-red-200">{message}</p>
      <button
        onClick={onDismiss}
        className="rounded px-1.5 text-xs text-red-300/70 hover:text-red-200"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

function TopBar({ role, mode, phase, sharing, watching, selfName, showTimer = true, light = false }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  let label;
  if (role === "viewer") {
    const names = watching.map((p) => p.name).filter(Boolean);
    label = names.length ? `Viewing ${names.join(", ")}` : "Waiting for a participant";
  } else if (mode === "screen") {
    label = sharing ? "Your screen is being shared" : "Your screen is not being shared";
  } else {
    label = selfName ? `Joined as ${selfName}` : "Connected";
  }

  return (
    <header
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-2.5 ${
        light ? "border-zinc-950/10" : "border-white/8"
      }`}
    >
      <StatusDot phase={phase} sharing={sharing} role={role} />
      <span className="truncate text-[13px] text-zinc-300">{label}</span>
      {sharing && (
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-zinc-300">
          {surfaceLabel(sharing.capture.displaySurface)}
          {sharing.capture.width ? ` · ${sharing.capture.width}×${sharing.capture.height}` : ""}
        </span>
      )}
      {phase === "live" && showTimer && (
        <span className="ml-auto font-mono text-[11px] tabular-nums text-zinc-500">
          {mm}:{ss}
        </span>
      )}
    </header>
  );
}

function StatusDot({ phase, sharing, role }) {
  const live = phase === "live" && (role === "viewer" || sharing);
  const tone = phase !== "live" ? "bg-zinc-600" : live ? "bg-emerald-400" : "bg-amber-400";
  return (
    <span className="flex items-center gap-1.5">
      <span className={`relative flex h-2 w-2 rounded-full ${tone}`}>
        {live && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${tone} opacity-60`} />
        )}
      </span>
      <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {phase === "live" ? (live ? "Live" : "Idle") : phase === "connecting" ? "Connecting" : "Offline"}
      </span>
    </span>
  );
}

// No lobby, no dialog. Connecting needs no consent, so the only thing shown
// before a session is live is whether it is still connecting or has failed.
function Connecting({ phase, onRetry }) {
  if (phase === "connecting" || phase === "idle") {
    return (
      <div className="grid flex-1 place-items-center">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent" />
      </div>
    );
  }
  return (
    <div className="grid flex-1 place-items-center">
      <button
        onClick={onRetry}
        className="rounded-lg px-4 py-2 text-sm font-medium ring-1 ring-white/15 hover:bg-white/5"
      >
        Retry
      </button>
    </div>
  );
}

function PublisherStage({
  mode,
  sharing,
  busy,
  requireEntireScreen,
  localScreenVideoRef,
  localCameraVideoRef,
  cameraOn,
  hasCamera,
  onStartShare,
  onEnableDevices,
  screenFeeds,
  cameraFeeds,
  peerName,
  requestKeyFrame,
  selfPreview = false,
  startLabel,
  quiet = false,
}) {
  const screenMode = mode === "screen";

  if (screenMode && !sharing) {
    // bare: the button and nothing else. The host owns every other word on
    // the page, so explaining ourselves here would just talk over them.
    if (quiet) {
      return (
        <div className="grid flex-1 place-items-center">
          <button
            onClick={onStartShare}
            disabled={busy}
            style={{ background: "var(--accent)" }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-950 transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Waiting…" : startLabel || "Start sharing"}
          </button>
        </div>
      );
    }
    return (
      <div className="grid flex-1 place-items-center rounded-xl bg-white/[0.02] ring-1 ring-white/8">
        <div className="max-w-sm px-6 text-center">
          <h2 className="text-sm font-semibold text-white">You are connected but not sharing</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
            {requireEntireScreen
              ? "Choose a whole screen when the prompt appears — this session does not accept a single window or tab."
              : "Choose a screen, a window, or a tab when the prompt appears."}
          </p>
          <button
            onClick={onStartShare}
            disabled={busy}
            className="mt-4 rounded-lg bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-40"
          >
            {busy ? "Waiting for your choice…" : startLabel || "Start sharing"}
          </button>
        </div>
      </div>
    );
  }

  // While sharing a whole display, a live self-preview would show the screen
  // that contains the preview — an infinite mirror that also eats the space the
  // person is meant to be working in. Confirm the state in words instead.
  // Opt-in only: a preview of a whole display, shown on that display, is an
  // infinite mirror. Hosts that share a window may still want it.
  if (screenMode && sharing && !selfPreview) {
    return quiet ? <div className="flex-1" /> : <SharingConfirmation capture={sharing.capture} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {sharing && (
        <Frame label="Your screen" accent className="min-h-0 flex-1">
          <video ref={localScreenVideoRef} autoPlay muted playsInline className="h-full w-full object-contain" />
        </Frame>
      )}

      {screenFeeds.map((t) => (
        <RemoteVideo
          key={t.producerId}
          track={t}
          label={`${peerName(t.peerId)} — screen`}
          accent
          contain
          className="min-h-0 flex-1"
          requestKeyFrame={requestKeyFrame}
        />
      ))}

      {(!screenMode || cameraFeeds.length > 0 || hasCamera) && (
        <div className="flex h-28 shrink-0 gap-3 overflow-x-auto">
          {hasCamera && (
            <Frame label="You" compact>
              <video ref={localCameraVideoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
              {!cameraOn && <Curtain>Camera off</Curtain>}
            </Frame>
          )}
          {!hasCamera && !screenMode && (
            <button
              onClick={onEnableDevices}
              className="h-full shrink-0 rounded-lg px-4 text-xs text-zinc-300 ring-1 ring-white/10 hover:bg-white/5"
            >
              Enable camera &amp; mic
            </button>
          )}
          {cameraFeeds.map((t) => (
            <RemoteVideo
              key={t.producerId}
              track={t}
              label={peerName(t.peerId)}
              compact
              requestKeyFrame={requestKeyFrame}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Shown to someone sharing their whole display. Deliberately text-only and
// small: anything rendered here is itself on the screen being captured, so the
// watcher sees it too.
function SharingConfirmation({ capture }) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-xs px-6 text-center">
        <span className="mx-auto flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
        </span>
        <h2 className="mt-4 text-sm font-semibold text-white">Your screen is being shared</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
          {surfaceLabel(capture.displaySurface)}
          {capture.width ? ` · ${capture.width}×${capture.height}` : ""}
        </p>
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
          You can minimise this and carry on working. Sharing continues until
          you stop it.
        </p>
      </div>
    </div>
  );
}

function ViewerStage({ phase, screenFeeds, cameraFeeds, peerName, publishers, requestKeyFrame, screenMode }) {
  if (phase !== "live") {
    return (
      <div className="grid flex-1 place-items-center">
        <p className="text-sm text-zinc-500">Connecting to the session…</p>
      </div>
    );
  }

  if (screenFeeds.length === 0 && cameraFeeds.length === 0) {
    const who = publishers.map((p) => p.name).filter(Boolean).join(", ");
    return (
      <div className="grid flex-1 place-items-center rounded-xl bg-white/[0.02] ring-1 ring-white/8">
        <div className="max-w-sm px-6 text-center">
          <div className="mx-auto mb-3 h-8 w-8 animate-pulse rounded-full bg-white/10" />
          <h2 className="text-sm font-semibold text-white">
            {publishers.length ? "Nothing is being shared yet" : "Nobody has joined yet"}
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-zinc-400">
            {publishers.length
              ? `${who} is connected but has not started sharing. This view updates automatically.`
              : "This view updates automatically as soon as someone joins and starts sharing."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {screenFeeds.map((t) => (
        <RemoteVideo
          key={t.producerId}
          track={t}
          // In a monitoring session the screen IS the interface. Borders,
          // names and surface badges are our furniture sitting on top of
          // someone else's product, so they are dropped entirely.
          bare={screenMode}
          label={screenMode ? null : `${peerName(t.peerId)} — screen`}
          badge={!screenMode && t.displaySurface ? surfaceLabel(t.displaySurface) : null}
          accent={!screenMode}
          contain
          className="min-h-0 flex-1"
          requestKeyFrame={requestKeyFrame}
        />
      ))}
      {cameraFeeds.length > 0 && (
        <div className={screenFeeds.length ? "flex h-28 shrink-0 gap-3 overflow-x-auto" : "grid min-h-0 flex-1 grid-cols-2 gap-3"}>
          {cameraFeeds.map((t) => (
            <RemoteVideo
              key={t.producerId}
              track={t}
              label={peerName(t.peerId)}
              compact={screenFeeds.length > 0}
              requestKeyFrame={requestKeyFrame}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ControlBar({
  isViewer,
  light = false,
  showParticipants = true,
  mode,
  sharing,
  busy,
  micOn,
  cameraOn,
  hasMic,
  hasCamera,
  participantCount,
  onToggleShare,
  onToggleMic,
  onToggleCamera,
  onLeave,
  screenMode = false,
}) {
  return (
    <div
      className={`flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3 ${
        light ? "border-zinc-950/10" : "border-white/8"
      }`}
    >
      {showParticipants && (
        <span className="text-[11px] text-zinc-500">{participantCount} connected</span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {!isViewer && (
          <Button onClick={onToggleShare} disabled={busy} tone={sharing ? "active" : "default"}>
            {sharing ? "Stop sharing" : "Share screen"}
          </Button>
        )}
        {!isViewer && mode !== "screen" && hasMic && (
          <Button onClick={onToggleMic} tone={micOn ? "default" : "danger"}>
            {micOn ? "Mute" : "Unmute"}
          </Button>
        )}
        {!isViewer && mode !== "screen" && hasCamera && (
          <Button onClick={onToggleCamera} tone={cameraOn ? "default" : "danger"}>
            {cameraOn ? "Stop video" : "Start video"}
          </Button>
        )}
        {/* A screen session ends when the host closes or navigates away from
            the frame, so a leave button is a second way to do what closing
            already does — and on the watching side there is nothing to leave. */}
        {!screenMode && (
          <Button onClick={onLeave} tone="danger">
            {isViewer ? "Close" : "Leave"}
          </Button>
        )}
      </div>
    </div>
  );
}

function Button({ onClick, disabled, tone = "default", children }) {
  const tones = {
    default: "bg-white/8 text-zinc-100 hover:bg-white/12",
    active: "bg-emerald-500/90 text-white hover:bg-emerald-500",
    danger: "bg-red-500/90 text-white hover:bg-red-500",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3.5 py-2 text-[13px] font-medium transition disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function Frame({ children, label, badge, accent, compact, bare = false, className = "" }) {
  if (bare) {
    return <div className={`relative overflow-hidden bg-black ${className}`}>{children}</div>;
  }
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-black ring-1 ${
        accent ? "ring-emerald-500/40" : "ring-white/10"
      } ${compact ? "aspect-video h-full shrink-0" : ""} ${className}`}
    >
      {children}
      <div className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1.5">
        <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
          {label}
        </span>
        {badge && (
          <span className="rounded bg-emerald-500/85 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}

function Curtain({ children }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-zinc-900/90 text-xs text-zinc-400">
      {children}
    </div>
  );
}

function RemoteAudio({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
    ref.current.play().catch(() => {});
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function RemoteVideo({ track, label, badge, accent, compact, contain, bare, className, requestKeyFrame }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // Remote audio plays through separate <audio> elements, so these are
    // video-only and safe to mute — which is also what stops Chrome's autoplay
    // policy from rejecting play().
    video.muted = true;
    video.srcObject = track.stream;
    video.play().catch(() => setBlocked(true));

    // A consumer created paused only receives deltas once resumed, and a static
    // screen can go minutes without emitting a keyframe. videoWidth is the only
    // reliable proof frames decoded — play() can stay pending forever — so poll
    // it and nudge the SFU until something lands.
    let tries = 0;
    const timer = setInterval(() => {
      const v = ref.current;
      if (!v) return;
      if (v.videoWidth > 0) {
        setBlocked(false);
        clearInterval(timer);
        return;
      }
      if (++tries > 10) {
        clearInterval(timer);
        return;
      }
      requestKeyFrame(track.consumerId);
      v.play().catch(() => {});
    }, 1500);

    return () => clearInterval(timer);
  }, [track.stream, track.consumerId, requestKeyFrame]);

  const forcePlay = () => ref.current?.play().then(() => setBlocked(false)).catch(() => {});

  useEffect(() => {
    if (!blocked) return;
    window.addEventListener("click", forcePlay, { once: true });
    return () => window.removeEventListener("click", forcePlay);
  }, [blocked]);

  return (
    <Frame label={label} badge={badge} accent={accent} compact={compact} bare={bare} className={className}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={`h-full w-full ${contain ? "object-contain" : "object-cover"}`}
      />
      {blocked && (
        <button onClick={forcePlay} className="absolute inset-0 grid place-items-center bg-black/70 text-sm">
          Click to play
        </button>
      )}
    </Frame>
  );
}
