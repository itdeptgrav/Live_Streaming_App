"use client";

import { use, useEffect, useRef, useState } from "react";
import { Device } from "mediasoup-client";
import { SIGNALING_URL } from "@/lib/realtime";
import { getIceServers } from "@/lib/webrtcConfig";

export default function MeetRoomPage({ params }) {
  const { roomId } = use(params);

  const [joined, setJoined] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  // One tile per remote VIDEO producer (camera and screen are separate
  // producers now, so a peer sharing their screen shows two tiles).
  const [videoTiles, setVideoTiles] = useState([]); // [{producerId, peerId, source, stream, consumerId}]
  const [audioTiles, setAudioTiles] = useState([]); // [{producerId, stream}]

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

  const localStreamRef = useRef(null); // camera + mic
  const screenStreamRef = useRef(null); // screen only

  const micProducerRef = useRef(null);
  const cameraProducerRef = useRef(null);
  const screenProducerRef = useRef(null);

  // producerId -> {peerId, source, stream, consumerId, consumer}
  const remoteVideosRef = useRef(new Map());
  const remoteAudiosRef = useRef(new Map());

  const consumeQueueRef = useRef(Promise.resolve());
  const pendingRef = useRef({
    transportCreate: new Map(), // direction -> {resolve}
    transportConnect: new Map(), // transportId -> {resolve}
    consume: new Map(), // producerId -> {resolve, reject}
    produce: [], // FIFO of {resolve} — one entry per in-flight produce()
  });

  // Stable identity so the <RemoteVideo> keyframe-nudge effect isn't torn down
  // and rebuilt on every parent render.
  const requestKeyFrame = useRef((consumerId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "meet-request-keyframe", consumerId }));
    }
  }).current;

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

  function send(msg) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
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

  // Each remote video track gets its OWN MediaStream that is never mutated.
  // Tracks are never added to or removed from a live stream, so the <video>
  // element never has to reload — which is what produced the 0x0 / black tile
  // and the "play() interrupted by a new load request" aborts.
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
        entry.consumer.close(); // was never closed before → leaked transceivers
      } catch { }
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
        } catch { }
        map.delete(producerId);
      }
    }
    syncTiles();
  }

  function consumeProducer(producerId, peerId, source) {
    const run = () => doConsumeProducer(producerId, peerId, source);
    consumeQueueRef.current = consumeQueueRef.current.then(run, run);
    return consumeQueueRef.current;
  }

  async function doConsumeProducer(producerId, peerId, source) {
    if (!recvTransportRef.current || !deviceRef.current) return;

    const { consume } = pendingRef.current;
    const promise = new Promise((resolve, reject) => consume.set(producerId, { resolve, reject }));

    // Hard timeout: without it, one unanswered consume response wedges the
    // serialized queue forever and NOTHING new ever renders again — including
    // a screen share started later in the call.
    const timeout = setTimeout(() => {
      consume.get(producerId)?.reject(new Error("consume timed out"));
    }, 10000);

    send({
      type: "meet-consume",
      transportId: recvTransportRef.current.id,
      producerId,
      rtpCapabilities: deviceRef.current.rtpCapabilities,
    });

    let consumerId, kind, rtpParameters, serverSource;
    try {
      ({ consumerId, kind, rtpParameters, source: serverSource } = await promise);
    } catch (err) {
      console.error(`[consume] producer ${producerId} (peer ${peerId}) failed:`, err.message);
      return;
    } finally {
      clearTimeout(timeout);
      consume.delete(producerId);
    }

    const consumer = await recvTransportRef.current.consume({
      id: consumerId,
      producerId,
      kind,
      rtpParameters,
    });
    send({ type: "meet-resume-consumer", consumerId });

    addRemoteConsumer({
      producerId,
      peerId,
      source: source || serverSource || (kind === "audio" ? "mic" : "camera"),
      consumer,
    });
  }

  async function join() {
    setStatus("connecting");
    setError(null);

    // Camera and mic are requested separately so a dead/busy webcam no longer
    // blocks the whole join (the old single getUserMedia call failed both).
    let audioTrack = null;
    let videoTrack = null;
    try {
      const a = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTrack = a.getAudioTracks()[0] || null;
    } catch { }
    try {
      const v = await navigator.mediaDevices.getUserMedia({ video: true });
      videoTrack = v.getVideoTracks()[0] || null;
    } catch { }

    if (!audioTrack && !videoTrack) {
      setError("Camera/microphone permission denied — allow access in the address-bar icon, then retry");
      setStatus("idle");
      return;
    }
    if (!videoTrack) setCameraOn(false);
    if (!audioTrack) setMicOn(false);

    const localStream = new MediaStream([audioTrack, videoTrack].filter(Boolean));
    localStreamRef.current = localStream;

    iceServersRef.current = await getIceServers();

    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      send({ type: "meet-join", roomId, displayName: displayName || "Guest" });
    };

    ws.onerror = () => setError("Could not reach the realtime server");

    ws.onclose = () => {
      // Never leave the consume queue hanging on a dropped socket.
      for (const [, p] of pendingRef.current.consume) p.reject(new Error("socket closed"));
      pendingRef.current.consume.clear();
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      const pending = pendingRef.current;

      switch (msg.type) {
        case "meet-joined": {
          try {
            const device = new Device();
            await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
            deviceRef.current = device;

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
          } catch (err) {
            setError(err.message || "Failed to join the call");
            setStatus("idle");
          }
          break;
        }

        case "meet-transport-created": {
          pending.transportCreate.get(msg.direction)?.resolve(msg);
          break;
        }

        case "meet-transport-connected": {
          pending.transportConnect.get(msg.transportId)?.resolve();
          break;
        }

        case "meet-produced": {
          pending.produce.shift()?.resolve(msg.producerId);
          break;
        }

        case "meet-consumed": {
          pending.consume.get(msg.producerId)?.resolve(msg);
          break;
        }

        case "meet-new-producer": {
          consumeProducer(msg.producerId, msg.peerId, msg.source);
          break;
        }

        case "meet-producer-closed": {
          removeRemoteProducer(msg.producerId);
          break;
        }

        case "meet-peer-left": {
          removePeerTiles(msg.peerId);
          break;
        }

        case "error": {
          console.error("Server error:", msg.message);
          if (msg.producerId && pending.consume.has(msg.producerId)) {
            pending.consume.get(msg.producerId).reject(new Error(msg.message));
          } else {
            setError(msg.message);
          }
          break;
        }

        default:
          break;
      }
    };
  }

  async function createSendTransport() {
    const { transportCreate, transportConnect, produce } = pendingRef.current;
    const createdPromise = new Promise((resolve) => transportCreate.set("send", { resolve }));
    send({ type: "meet-create-transport", direction: "send" });
    const info = await createdPromise;

    const transport = deviceRef.current.createSendTransport({
      id: info.transportId,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
      iceServers: iceServersRef.current,
    });
    transport.on("connect", ({ dtlsParameters }, callback) => {
      const connectedPromise = new Promise((resolve) =>
        transportConnect.set(transport.id, { resolve })
      );
      send({ type: "meet-connect-transport", transportId: transport.id, dtlsParameters });
      connectedPromise.then(callback);
    });
    // appData.source travels to the server so other peers can tell a screen
    // producer apart from a camera producer and lay the tiles out correctly.
    transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      const producedPromise = new Promise((resolve) => produce.push({ resolve }));
      send({
        type: "meet-produce",
        transportId: transport.id,
        kind,
        rtpParameters,
        source: appData?.source,
      });
      producedPromise.then((id) => callback({ id })).catch(errback);
    });

    sendTransportRef.current = transport;
  }

  async function createRecvTransport() {
    const { transportCreate, transportConnect } = pendingRef.current;
    const createdPromise = new Promise((resolve) => transportCreate.set("recv", { resolve }));
    send({ type: "meet-create-transport", direction: "recv" });
    const info = await createdPromise;

    const transport = deviceRef.current.createRecvTransport({
      id: info.transportId,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
      iceServers: iceServersRef.current,
    });
    transport.on("connect", ({ dtlsParameters }, callback) => {
      const connectedPromise = new Promise((resolve) =>
        transportConnect.set(transport.id, { resolve })
      );
      send({ type: "meet-connect-transport", transportId: transport.id, dtlsParameters });
      connectedPromise.then(callback);
    });

    recvTransportRef.current = transport;
  }

  // Screen share is now a SECOND, independent video producer. The camera
  // producer is left completely alone — no close, no re-produce, no
  // renegotiation on the receiving side, so nothing can race.
  async function startScreenShare() {
    if (screenProducerRef.current) return;
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
      });
    } catch {
      return; // user cancelled the picker
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) return;

    // Tells the encoder this is text/UI, not motion video: keeps text legible
    // and stops Chrome from aggressively downscaling a static screen.
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
    screenTrack.onended = stopScreenShare; // browser's native "Stop sharing" bar
  }

  function stopScreenShare() {
    const producer = screenProducerRef.current;
    if (producer) {
      send({ type: "meet-close-producer", producerId: producer.id });
      producer.close(); // stopTracks defaults true → also stops the screen track
      screenProducerRef.current = null;
    }
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setSharingScreen(false);
  }

  function toggleMic() {
    const track = micProducerRef.current?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }

  function toggleCamera() {
    const track = cameraProducerRef.current?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }

  function leave() {
    send({ type: "meet-leave" });
    wsRef.current?.close();
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    screenProducerRef.current = null;
    cameraProducerRef.current = null;
    micProducerRef.current = null;
    remoteVideosRef.current.clear();
    remoteAudiosRef.current.clear();
    setVideoTiles([]);
    setAudioTiles([]);
    setJoined(false);
    setStatus("idle");
    setSharingScreen(false);
    setMicOn(true);
    setCameraOn(true);
  }

  useEffect(() => leave, []);

  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setShareLink(window.location.href), []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareLink || window.location.href);
    } catch {
      // Clipboard API needs a secure context; fall back to a manual selection.
      const el = document.createElement("textarea");
      el.value = shareLink || window.location.href;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      el.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  if (!joined) {
    return (
      <main className="flex-1 max-w-md mx-auto w-full p-8 flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Join meeting</h1>
        <p className="text-sm text-zinc-500 break-all">{shareLink}</p>
        <button
          onClick={copyLink}
          className="self-start text-xs border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1"
        >
          {copied ? "Link copied" : "Copy invite link"}
        </button>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Your name"
          className="border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
        />
        <button
          onClick={join}
          disabled={status === "connecting"}
          className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2 disabled:opacity-50"
        >
          {status === "connecting" ? "Joining…" : "Join now"}
        </button>
      </main>
    );
  }

  return (
    <main className="flex-1 w-full p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Room {roomId}</h1>
        <div className="flex gap-2">
          <button
            onClick={copyLink}
            className="rounded px-4 py-2 border border-zinc-300 dark:border-zinc-700"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <button
            onClick={toggleMic}
            className={`rounded px-4 py-2 ${micOn ? "bg-black text-white dark:bg-white dark:text-black" : "bg-red-600 text-white"
              }`}
          >
            {micOn ? "Mute" : "Unmute"}
          </button>
          <button
            onClick={toggleCamera}
            className={`rounded px-4 py-2 ${cameraOn ? "bg-black text-white dark:bg-white dark:text-black" : "bg-red-600 text-white"
              }`}
          >
            {cameraOn ? "Hide camera" : "Show camera"}
          </button>
          <button
            onClick={sharingScreen ? stopScreenShare : startScreenShare}
            className={`rounded px-4 py-2 ${sharingScreen
              ? "bg-zinc-700 text-white"
              : "bg-black text-white dark:bg-white dark:text-black"
              }`}
          >
            {sharingScreen ? "Stop sharing" : "Share screen"}
          </button>
          <button onClick={leave} className="bg-red-600 text-white rounded px-4 py-2">
            Leave
          </button>
        </div>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <div className="relative">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-black aspect-video"
          />
          <span className="absolute top-1 left-1 text-[10px] text-white bg-black/60 px-1.5 py-0.5 rounded">
            You
          </span>
          {!cameraOn && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-sm rounded-lg">
              Camera off
            </div>
          )}
          {!micOn && (
            <span className="absolute bottom-1 left-1 text-[10px] text-white bg-red-600 px-1.5 py-0.5 rounded">
              Muted
            </span>
          )}
        </div>

        {sharingScreen && (
          <div className="relative">
            <video
              ref={localScreenRef}
              autoPlay
              muted
              playsInline
              className="w-full rounded-lg border border-lime-500 bg-black aspect-video"
            />
            <span className="absolute top-1 left-1 text-[10px] text-white bg-lime-600 px-1.5 py-0.5 rounded">
              Your screen
            </span>
          </div>
        )}

        {videoTiles.map((tile) => (
          <RemoteVideo
            key={tile.producerId}
            stream={tile.stream}
            consumerId={tile.consumerId}
            peerId={tile.peerId}
            source={tile.source}
            requestKeyFrame={requestKeyFrame}
          />
        ))}
      </div>

      {audioTiles.map((tile) => (
        <RemoteAudio key={tile.producerId} stream={tile.stream} />
      ))}
    </main>
  );
}

function RemoteAudio({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.srcObject = stream;
    ref.current.play().catch(() => { });
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline className="hidden" />;
}

function RemoteVideo({ stream, consumerId, peerId, source, requestKeyFrame }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);
  const [debug, setDebug] = useState("");

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const label = `[remote:${peerId}:${source}]`;

    // Remote audio is rendered by separate <RemoteAudio> elements, so these
    // video elements are always video-only and can safely be muted. Without
    // muted, Chrome's autoplay policy rejects play() with NotAllowedError
    // even though there is no audio track — that was the "Click to play"
    // overlay. Set it as a property too; the JSX attribute alone is unreliable
    // across hydration.
    video.muted = true;
    video.srcObject = stream;
    video.onresize = () => setDebug(`${video.videoWidth}x${video.videoHeight}`);
    video.onerror = () => console.log(`${label} element error:`, video.error);

    video.play().catch((err) => {
      console.log(`${label} play() rejected:`, err.name, err.message);
      setBlocked(true);
    });

    // A consumer created paused only starts getting delta frames on resume.
    // A static screen share can go minutes without emitting a keyframe on its
    // own, so if nothing has decoded yet we nudge the SFU to pull a fresh one
    // from the producer. This is the fix for the permanently-black 0x0 tile.
    // Chrome leaves play() PENDING forever (neither resolve nor reject) when a
    // MediaStream has no decodable frames, so the promise is useless as a
    // readiness signal. Poll videoWidth instead — that is the only thing that
    // proves frames actually decoded.
    let tries = 0;
    const timer = setInterval(() => {
      const v = ref.current;
      if (!v) return;

      if (v.videoWidth > 0) {
        setDebug(`${v.videoWidth}x${v.videoHeight}`);
        setBlocked(false);
        clearInterval(timer);
        return;
      }

      if (++tries > 10) {
        console.log(`${label} gave up — still 0x0 after ${tries} tries`);
        clearInterval(timer);
        return;
      }

      console.log(
        `${label} still 0x0 (try ${tries}) — readyState=${v.readyState} paused=${v.paused} ` +
        `tracks=${stream.getVideoTracks().map((t) => `${t.readyState}/muted:${t.muted}`).join(",")}`
      );
      requestKeyFrame(consumerId);
      v.play().catch(() => { });
    }, 1500);


    return () => {
      clearInterval(timer);
      video.onplaying = null;
      video.onresize = null;
      video.onerror = null;
    };
  }, [stream, consumerId, peerId, source, requestKeyFrame]);

  function forcePlay() {
    ref.current
      ?.play()
      .then(() => setBlocked(false))
      .catch(() => { });
  }

  useEffect(() => {
    if (!blocked) return;
    window.addEventListener("click", forcePlay, { once: true });
    return () => window.removeEventListener("click", forcePlay);
  }, [blocked]);

  return (
    <div className="relative">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={`w-full rounded-lg border bg-black aspect-video ${source === "screen" ? "border-lime-500" : "border-zinc-200 dark:border-zinc-800"
          }`}
      />
      <span className="absolute top-1 left-1 text-[10px] text-white bg-black/60 px-1.5 py-0.5 rounded">
        {source === "screen" ? "Screen" : "Camera"}
      </span>
      <p className="absolute bottom-1 left-1 text-[10px] text-lime-400 bg-black/60 px-1 rounded">
        {debug || "no frame yet"}
      </p>
      {blocked && (
        <button
          onClick={forcePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/70 text-white text-sm rounded-lg"
        >
          Click to play
        </button>
      )}
    </div>
  );
}