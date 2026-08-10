"use client";

// Embeddable meeting surface. This is the entire integration story for a
// customer: mint a room token on their backend, then point an iframe here.
// No SDK, no npm package, no WebRTC code on their side.
//
//   <iframe src="https://live.grav.in/embed/<roomId>?token=<token>"
//           allow="camera; microphone; display-capture; autoplay" />
//
// The media plumbing below is the same mediasoup flow the standalone /meet
// page uses — including the keyframe-nudge workaround for black screen-share
// tiles — with room tokens, participant identity, and a postMessage bridge
// added so the host page can observe and control the call without an SDK.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Device } from "mediasoup-client";
import { SIGNALING_URL } from "@/lib/realtime";
import { getIceServers } from "@/lib/webrtcConfig";

const CHANNEL = "grav-stream";
const PARENT_CHANNEL = "grav-stream-parent";

export default function EmbedRoom({ roomId, token, parentOrigin }) {
  // Kept in a ref, not state: it is never rendered, and letting it change
  // `emit`'s identity would re-run the teardown effect and end a live call.
  const parentOriginRef = useRef(parentOrigin || "*");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  const [videoTiles, setVideoTiles] = useState([]);
  const [audioTiles, setAudioTiles] = useState([]);
  const [peers, setPeers] = useState([]); // [{peerId, identity, name}]
  const [self, setSelf] = useState({ identity: null, name: "You" });

  const [sharingScreen, setSharingScreen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);

  const localVideoRef = useRef(null);
  const localScreenRef = useRef(null);

  const wsRef = useRef(null);
  const iceServersRef = useRef(null);
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  const micProducerRef = useRef(null);
  const cameraProducerRef = useRef(null);
  const screenProducerRef = useRef(null);

  const remoteVideosRef = useRef(new Map());
  const remoteAudiosRef = useRef(new Map());
  const peersRef = useRef(new Map());

  const consumeQueueRef = useRef(Promise.resolve());
  // rid -> {resolve, reject}. The server echoes `rid` on every reply, so
  // concurrent requests of the same type can never resolve each other's promise.
  const pendingRef = useRef(new Map());
  const ridRef = useRef(0);

  // ---------------- parent bridge ----------------

  const emit = useCallback(
    (type, payload = {}) => {
      if (typeof window === "undefined" || window.parent === window) return;
      window.parent.postMessage(
        { source: CHANNEL, type, roomId, ...payload },
        parentOriginRef.current
      );
    },
    [roomId]
  );

  // Guarded so integrators receive exactly one `ready` per load. Without this,
  // React StrictMode's double-invoked effects emit it twice in development and
  // a host app that starts work on `ready` would do it twice too.
  const readySentRef = useRef(false);
  useEffect(() => {
    if (readySentRef.current) return;
    readySentRef.current = true;
    emit("ready");
  }, [emit]);

  useEffect(() => {
    if (joined) emit("participants-changed", { count: peers.length + 1 });
  }, [peers.length, joined, emit]);

  useEffect(() => {
    if (joined && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [joined]);

  useEffect(() => {
    if (sharingScreen && localScreenRef.current && screenStreamRef.current) {
      localScreenRef.current.srcObject = screenStreamRef.current;
    }
  }, [sharingScreen]);

  // ---------------- signaling helpers ----------------

  function send(msg) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }

  /** Sends a message and resolves with the reply carrying the same rid. */
  function request(msg, { timeoutMs = 10000 } = {}) {
    const rid = `r${++ridRef.current}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(rid);
        reject(new Error(`${msg.type} timed out`));
      }, timeoutMs);

      pendingRef.current.set(rid, {
        resolve: (value) => {
          clearTimeout(timer);
          pendingRef.current.delete(rid);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          pendingRef.current.delete(rid);
          reject(err);
        },
      });
      send({ ...msg, rid });
    });
  }

  function syncTiles() {
    setVideoTiles(
      Array.from(remoteVideosRef.current.entries()).map(([producerId, v]) => ({
        producerId,
        peerId: v.peerId,
        source: v.source,
        stream: v.stream,
        consumerId: v.consumerId,
      }))
    );
    setAudioTiles(
      Array.from(remoteAudiosRef.current.entries()).map(([producerId, a]) => ({
        producerId,
        stream: a.stream,
      }))
    );
  }

  function syncPeers() {
    setPeers(Array.from(peersRef.current.values()));
  }

  // Each remote track gets its own MediaStream that is never mutated, so the
  // <video> element never reloads mid-call (the source of black 0x0 tiles).
  function addRemoteConsumer({ producerId, peerId, source, consumer }) {
    const stream = new MediaStream([consumer.track]);
    const entry = { peerId, source, stream, consumerId: consumer.id, consumer };
    if (consumer.kind === "video") remoteVideosRef.current.set(producerId, entry);
    else remoteAudiosRef.current.set(producerId, entry);
    syncTiles();
  }

  function removeRemoteProducer(producerId) {
    for (const map of [remoteVideosRef.current, remoteAudiosRef.current]) {
      const entry = map.get(producerId);
      if (!entry) continue;
      try {
        entry.consumer.close();
      } catch {}
      map.delete(producerId);
    }
    syncTiles();
  }

  function removePeerTiles(peerId) {
    for (const map of [remoteVideosRef.current, remoteAudiosRef.current]) {
      for (const [producerId, entry] of map) {
        if (entry.peerId !== peerId) continue;
        try {
          entry.consumer.close();
        } catch {}
        map.delete(producerId);
      }
    }
    peersRef.current.delete(peerId);
    syncPeers();
    syncTiles();
  }

  function consumeProducer(producerId, peerId, source) {
    const run = () => doConsumeProducer(producerId, peerId, source);
    consumeQueueRef.current = consumeQueueRef.current.then(run, run);
    return consumeQueueRef.current;
  }

  async function doConsumeProducer(producerId, peerId, source) {
    if (!recvTransportRef.current || !deviceRef.current) return;

    let reply;
    try {
      reply = await request({
        type: "meet-consume",
        transportId: recvTransportRef.current.id,
        producerId,
        rtpCapabilities: deviceRef.current.rtpCapabilities,
      });
    } catch (err) {
      console.error(`[consume] producer ${producerId} failed:`, err.message);
      return;
    }

    const consumer = await recvTransportRef.current.consume({
      id: reply.consumerId,
      producerId,
      kind: reply.kind,
      rtpParameters: reply.rtpParameters,
    });
    send({ type: "meet-resume-consumer", consumerId: reply.consumerId });

    addRemoteConsumer({
      producerId,
      peerId: peerId || reply.peerId,
      source: source || reply.source || (reply.kind === "audio" ? "mic" : "camera"),
      consumer,
    });
  }

  // ---------------- join ----------------

  async function join() {
    setStatus("connecting");
    setError(null);

    // Camera and mic are requested separately so a busy or missing webcam
    // cannot block the join outright.
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
        "Camera and microphone are blocked. If this meeting is embedded, the " +
        'iframe needs allow="camera; microphone; display-capture; autoplay".';
      setError(message);
      emit("error", { message });
      setStatus("idle");
      return;
    }
    if (!videoTrack) setCameraOn(false);
    if (!audioTrack) setMicOn(false);

    localStreamRef.current = new MediaStream([audioTrack, videoTrack].filter(Boolean));
    iceServersRef.current = await getIceServers();

    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => send({ type: "meet-join", roomId, token });

    ws.onerror = () => {
      setError("Could not reach the realtime server");
      emit("error", { message: "Could not reach the realtime server" });
    };

    ws.onclose = () => {
      for (const [, p] of pendingRef.current) p.reject(new Error("socket closed"));
      pendingRef.current.clear();
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      // Any reply carrying a rid belongs to an in-flight request().
      if (msg.rid && pendingRef.current.has(msg.rid)) {
        const pending = pendingRef.current.get(msg.rid);
        if (msg.type === "error") pending.reject(new Error(msg.message));
        else pending.resolve(msg);
        return;
      }

      switch (msg.type) {
        case "meet-joined": {
          try {
            const device = new Device();
            await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
            deviceRef.current = device;

            setSelf({ identity: msg.identity, name: msg.displayName || "You" });
            for (const p of msg.existingPeers || []) peersRef.current.set(p.peerId, p);
            syncPeers();

            await createSendTransport();
            await createRecvTransport();

            if (audioTrack) {
              micProducerRef.current = await sendTransportRef.current.produce({
                track: audioTrack,
                stopTracks: false,
                appData: { source: "mic" },
              });
            }
            if (videoTrack) {
              cameraProducerRef.current = await sendTransportRef.current.produce({
                track: videoTrack,
                stopTracks: false,
                appData: { source: "camera" },
              });
            }

            for (const p of msg.existingProducers) {
              consumeProducer(p.producerId, p.peerId, p.source);
            }

            setJoined(true);
            setStatus("live");
            emit("joined", { peerId: msg.peerId, identity: msg.identity });
          } catch (err) {
            setError(err.message || "Failed to join the call");
            emit("error", { message: err.message || "Failed to join the call" });
            setStatus("idle");
          }
          break;
        }

        case "meet-peer-joined": {
          peersRef.current.set(msg.peerId, {
            peerId: msg.peerId,
            identity: msg.identity,
            name: msg.name,
          });
          syncPeers();
          break;
        }

        case "meet-new-producer":
          consumeProducer(msg.producerId, msg.peerId, msg.source);
          break;

        case "meet-producer-closed":
          removeRemoteProducer(msg.producerId);
          break;

        case "meet-peer-left":
          removePeerTiles(msg.peerId);
          break;

        case "error": {
          console.error("Server error:", msg.message);
          setError(msg.message);
          emit("error", { message: msg.message });
          break;
        }

        default:
          break;
      }
    };
  }

  async function createSendTransport() {
    const info = await request({ type: "meet-create-transport", direction: "send" });

    const transport = deviceRef.current.createSendTransport({
      id: info.transportId,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
      iceServers: iceServersRef.current,
    });
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      request({ type: "meet-connect-transport", transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });
    // appData.source travels to the server so other peers can tell a screen
    // producer apart from a camera producer and lay tiles out accordingly.
    transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      request({
        type: "meet-produce",
        transportId: transport.id,
        kind,
        rtpParameters,
        source: appData?.source,
      })
        .then((reply) => callback({ id: reply.producerId }))
        .catch(errback);
    });

    sendTransportRef.current = transport;
  }

  async function createRecvTransport() {
    const info = await request({ type: "meet-create-transport", direction: "recv" });

    const transport = deviceRef.current.createRecvTransport({
      id: info.transportId,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
      iceServers: iceServersRef.current,
    });
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      request({ type: "meet-connect-transport", transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });

    recvTransportRef.current = transport;
  }

  // ---------------- controls ----------------

  const stopScreenShare = useCallback(() => {
    const producer = screenProducerRef.current;
    if (producer) {
      send({ type: "meet-close-producer", producerId: producer.id });
      producer.close(); // stopTracks defaults true, so the track stops too
      screenProducerRef.current = null;
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setSharingScreen(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    if (screenProducerRef.current) return;
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
      });
    } catch {
      return; // user dismissed the picker
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) return;

    // Tells the encoder this is text/UI, not motion video — keeps text legible
    // and stops aggressive downscaling of a mostly-static screen.
    if ("contentHint" in screenTrack) screenTrack.contentHint = "detail";
    screenStreamRef.current = screenStream;

    try {
      screenProducerRef.current = await sendTransportRef.current.produce({
        track: screenTrack,
        encodings: [{ maxBitrate: 3_000_000 }],
        codecOptions: { videoGoogleStartBitrate: 1000 },
        appData: { source: "screen" },
      });
    } catch (err) {
      setError(`Could not start screen share: ${err.message}`);
      screenStream.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      return;
    }

    setSharingScreen(true);
    screenTrack.onended = stopScreenShare; // the browser's own "Stop sharing" bar
  }, [stopScreenShare]);

  const toggleMic = useCallback(() => {
    const track = micProducerRef.current?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const track = cameraProducerRef.current?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }, []);

  // Releases sockets, transports, and camera/mic. Touches no React state, so
  // it is safe to call from an unmount cleanup — including React StrictMode's
  // extra mount/unmount cycle in development, which would otherwise flip the
  // UI to "ended" the instant the page loaded.
  const teardown = useCallback(() => {
    send({ type: "meet-leave" });
    wsRef.current?.close();
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    screenProducerRef.current = null;
    cameraProducerRef.current = null;
    micProducerRef.current = null;
    screenStreamRef.current = null;
    remoteVideosRef.current.clear();
    remoteAudiosRef.current.clear();
    peersRef.current.clear();
  }, []);

  // The deliberate "user hung up" path: tear down, then reflect it in the UI.
  const leave = useCallback(() => {
    teardown();
    setVideoTiles([]);
    setAudioTiles([]);
    setPeers([]);
    setJoined(false);
    setStatus("ended");
    setSharingScreen(false);
    emit("left");
  }, [teardown, emit]);

  useEffect(() => teardown, [teardown]);

  // Parent-page control channel: lets the host app drive the call without an SDK.
  useEffect(() => {
    function onMessage(event) {
      if (event.data?.source !== PARENT_CHANNEL) return;
      switch (event.data.type) {
        case "toggle-mic":
          toggleMic();
          break;
        case "toggle-camera":
          toggleCamera();
          break;
        case "toggle-screen-share":
          sharingScreen ? stopScreenShare() : startScreenShare();
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
  }, [toggleMic, toggleCamera, leave, sharingScreen, startScreenShare, stopScreenShare]);

  // useCallback, not useRef().current — it is equally stable across renders but
  // does not read a ref during render, which React flags as unsafe.
  const requestKeyFrame = useCallback((consumerId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "meet-request-keyframe", consumerId }));
    }
  }, []);

  // Derived from peers STATE, not peersRef: a ref read during render would not
  // re-render when a name arrives, leaving tiles labelled "Participant".
  const peerNames = useMemo(
    () => new Map(peers.map((p) => [p.peerId, p.name])),
    [peers]
  );
  const nameFor = (peerId) => peerNames.get(peerId) || "Participant";

  // ---------------- render ----------------

  if (status === "ended") {
    return (
      <div className="h-dvh w-full bg-zinc-950 text-zinc-300 flex items-center justify-center">
        <p className="text-sm">You have left the meeting.</p>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="h-dvh w-full bg-zinc-950 text-white flex items-center justify-center p-6">
        <div className="w-full max-w-sm flex flex-col gap-4">
          <h1 className="text-lg font-semibold">Ready to join?</h1>
          {!token && (
            <p className="text-amber-400 text-sm">
              No room token in the URL. This meeting must be opened with a
              <code className="mx-1 text-xs">?token=</code>
              minted by your backend.
            </p>
          )}
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            onClick={join}
            disabled={status === "connecting" || !token}
            className="bg-white text-black rounded px-4 py-2 font-medium disabled:opacity-40"
          >
            {status === "connecting" ? "Joining…" : "Join meeting"}
          </button>
        </div>
      </div>
    );
  }

  const screenTiles = videoTiles.filter((t) => t.source === "screen");
  const cameraTiles = videoTiles.filter((t) => t.source !== "screen");
  // A shared screen is the thing people are looking at — give it the stage and
  // demote every camera, including the local one, to a filmstrip.
  const hasStage = screenTiles.length > 0 || sharingScreen;

  return (
    <div className="h-dvh w-full bg-zinc-950 text-white flex flex-col">
      <div className="flex-1 min-h-0 p-3 flex flex-col gap-3">
        {error && <p className="text-red-400 text-xs shrink-0">{error}</p>}

        {hasStage && (
          <div className="flex-1 min-h-0 grid gap-3 grid-cols-1">
            {sharingScreen && (
              <Tile label="Your screen" accent>
                <video ref={localScreenRef} autoPlay muted playsInline className="h-full w-full object-contain" />
              </Tile>
            )}
            {screenTiles.map((tile) => (
              <RemoteVideo
                key={tile.producerId}
                stream={tile.stream}
                consumerId={tile.consumerId}
                label={`${nameFor(tile.peerId)} — screen`}
                accent
                contain
                requestKeyFrame={requestKeyFrame}
              />
            ))}
          </div>
        )}

        <div
          className={
            hasStage
              ? "shrink-0 h-28 flex gap-3 overflow-x-auto"
              : "flex-1 min-h-0 grid gap-3 grid-cols-2 lg:grid-cols-3 auto-rows-fr"
          }
        >
          <Tile label={`${self.name} (you)`} muted={!micOn} compact={hasStage}>
            <video ref={localVideoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
            {!cameraOn && (
              <div className="absolute inset-0 grid place-items-center bg-zinc-900 text-xs text-zinc-400">
                Camera off
              </div>
            )}
          </Tile>

          {cameraTiles.map((tile) => (
            <RemoteVideo
              key={tile.producerId}
              stream={tile.stream}
              consumerId={tile.consumerId}
              label={nameFor(tile.peerId)}
              compact={hasStage}
              requestKeyFrame={requestKeyFrame}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 flex items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
        <span className="text-xs text-zinc-500">
          {peers.length + 1} participant{peers.length === 0 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          <ControlButton onClick={toggleMic} danger={!micOn}>
            {micOn ? "Mute" : "Unmute"}
          </ControlButton>
          <ControlButton onClick={toggleCamera} danger={!cameraOn}>
            {cameraOn ? "Stop video" : "Start video"}
          </ControlButton>
          <ControlButton onClick={sharingScreen ? stopScreenShare : startScreenShare} active={sharingScreen}>
            {sharingScreen ? "Stop sharing" : "Share screen"}
          </ControlButton>
          <button
            onClick={leave}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
          >
            Leave
          </button>
        </div>
      </div>

      {audioTiles.map((tile) => (
        <RemoteAudio key={tile.producerId} stream={tile.stream} />
      ))}
    </div>
  );
}

function ControlButton({ onClick, children, danger, active }) {
  const tone = danger
    ? "bg-red-600 text-white hover:bg-red-500"
    : active
      ? "bg-lime-600 text-white hover:bg-lime-500"
      : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700";
  return (
    <button onClick={onClick} className={`rounded px-4 py-2 text-sm font-medium ${tone}`}>
      {children}
    </button>
  );
}

function Tile({ children, label, accent, muted, compact }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-black ${
        accent ? "border border-lime-500" : "border border-zinc-800"
      } ${compact ? "h-full aspect-video shrink-0" : "h-full w-full"}`}
    >
      {children}
      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
        {label}
      </span>
      {muted && (
        <span className="absolute top-1 right-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] text-white">
          Muted
        </span>
      )}
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

function RemoteVideo({ stream, consumerId, label, accent, compact, contain, requestKeyFrame }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // Remote audio plays through separate <RemoteAudio> elements, so these
    // elements are video-only and safe to mute — and muting is what keeps
    // Chrome's autoplay policy from rejecting play() outright.
    video.muted = true;
    video.srcObject = stream;
    video.play().catch(() => setBlocked(true));

    // A consumer created paused only receives delta frames once resumed, and a
    // static screen share may not emit a keyframe on its own for minutes. Poll
    // videoWidth (the only reliable proof frames decoded — play() can stay
    // pending forever) and nudge the SFU for a keyframe until something lands.
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
      requestKeyFrame(consumerId);
      v.play().catch(() => {});
    }, 1500);

    return () => clearInterval(timer);
  }, [stream, consumerId, requestKeyFrame]);

  function forcePlay() {
    ref.current?.play().then(() => setBlocked(false)).catch(() => {});
  }

  useEffect(() => {
    if (!blocked) return;
    window.addEventListener("click", forcePlay, { once: true });
    return () => window.removeEventListener("click", forcePlay);
  }, [blocked]);

  return (
    <Tile label={label} accent={accent} compact={compact}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={`h-full w-full ${contain ? "object-contain" : "object-cover"}`}
      />
      {blocked && (
        <button
          onClick={forcePlay}
          className="absolute inset-0 grid place-items-center bg-black/70 text-sm text-white"
        >
          Click to play
        </button>
      )}
    </Tile>
  );
}
