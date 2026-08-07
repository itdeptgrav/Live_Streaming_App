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
  const [remoteTiles, setRemoteTiles] = useState([]); // [{peerId, stream}]
  const [sharingScreen, setSharingScreen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const localVideoRef = useRef(null);

  const wsRef = useRef(null);
  const iceServersRef = useRef(null);
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const localStreamRef = useRef(null);
  const audioProducerRef = useRef(null);
  const videoProducerRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const remoteStreamsRef = useRef(new Map()); // peerId -> MediaStream
  const consumeQueueRef = useRef(Promise.resolve()); // serializes consumeProducer calls
  const pendingRef = useRef({
    transportCreate: new Map(), // direction -> {resolve}
    transportConnect: new Map(), // transportId -> {resolve}
    consume: new Map(), // producerId -> {resolve}
    produce: null, // {resolve}
  });

  // The local <video> element only exists once `joined` is true, so re-attach
  // the stream here rather than relying on the one-off assignment in join()
  // (that runs while the pre-join screen — with no video element — is still showing).
  useEffect(() => {
    if (joined && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [joined]);

  function send(msg) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }

  // One persistent MediaStream per peer, mutated in place as tracks arrive.
  // A MediaStream is a live object — a video element already showing it picks
  // up added tracks automatically. Replacing srcObject with a brand-new
  // MediaStream on every track (an earlier, wrong fix) forces the element to
  // reload, aborting any in-flight play() — that was the actual cause of the
  // black tiles, confirmed via console: "AbortError: play() request was
  // interrupted by a new load request."
  function addRemoteTrack(peerId, track) {
    let stream = remoteStreamsRef.current.get(peerId);
    if (!stream) {
      stream = new MediaStream();
      remoteStreamsRef.current.set(peerId, stream);
    }
    stream.addTrack(track);
    setRemoteTiles(
      Array.from(remoteStreamsRef.current.entries()).map(([id, s]) => ({
        peerId: id,
        stream: s,
      }))
    );
  }

  function removeRemoteTile(peerId) {
    remoteStreamsRef.current.delete(peerId);
    setRemoteTiles(
      Array.from(remoteStreamsRef.current.entries()).map(([id, s]) => ({
        peerId: id,
        stream: s,
      }))
    );
  }

  // Queued so overlapping calls (e.g. a peer's audio and video producers
  // arriving close together) never race on reading+writing remoteStreamsRef —
  // each call's full read-modify-write of the peer's MediaStream completes
  // before the next one starts.
  function consumeProducer(producerId, peerId) {
    const run = () => doConsumeProducer(producerId, peerId);
    consumeQueueRef.current = consumeQueueRef.current.then(run, run);
    return consumeQueueRef.current;
  }

  async function doConsumeProducer(producerId, peerId) {
    const { consume } = pendingRef.current;
    const promise = new Promise((resolve, reject) => consume.set(producerId, { resolve, reject }));
    send({
      type: "meet-consume",
      transportId: recvTransportRef.current.id,
      producerId,
      rtpCapabilities: deviceRef.current.rtpCapabilities,
    });
    let consumerId, kind, rtpParameters;
    try {
      ({ consumerId, kind, rtpParameters } = await promise);
    } catch (err) {
      console.error(`Failed to consume producer ${producerId} (peer ${peerId}):`, err.message);
      return;
    } finally {
      consume.delete(producerId);
    }

    const consumer = await recvTransportRef.current.consume({
      id: consumerId,
      producerId,
      kind,
      rtpParameters,
    });
    send({ type: "meet-resume-consumer", consumerId });

    addRemoteTrack(peerId, consumer.track);

    if (kind === "video") {
      // Real WebRTC stats — tells us definitively whether video RTP packets
      // are even arriving over the network, vs. arriving but failing to decode.
      setTimeout(async () => {
        const stats = await consumer.getStats();
        stats.forEach((report) => {
          if (report.type === "inbound-rtp") {
            console.log(`[stats:${peerId}] video inbound-rtp:`, {
              packetsReceived: report.packetsReceived,
              bytesReceived: report.bytesReceived,
              framesReceived: report.framesReceived,
              framesDecoded: report.framesDecoded,
              packetsLost: report.packetsLost,
              codec: report.codecId,
            });
          }
        });
      }, 3000);
    }
  }

  async function join() {
    setStatus("connecting");
    setError(null);

    let localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      setError("Camera/microphone permission denied");
      setStatus("idle");
      return;
    }
    localStreamRef.current = localStream;
    cameraTrackRef.current = localStream.getVideoTracks()[0] || null;

    iceServersRef.current = await getIceServers();

    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      send({ type: "meet-join", roomId, displayName: displayName || "Guest" });
    };

    ws.onerror = () => setError("Could not reach the realtime server");

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

            for (const track of localStream.getTracks()) {
              const producer = await sendTransportRef.current.produce({ track });
              if (track.kind === "video") videoProducerRef.current = producer;
              if (track.kind === "audio") audioProducerRef.current = producer;
            }

            for (const p of msg.existingProducers) {
              await consumeProducer(p.producerId, p.peerId);
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
          pending.produce?.resolve(msg.producerId);
          break;
        }

        case "meet-consumed": {
          pending.consume.get(msg.producerId)?.resolve(msg);
          break;
        }

        case "meet-new-producer": {
          await consumeProducer(msg.producerId, msg.peerId);
          break;
        }

        case "meet-peer-left": {
          removeRemoteTile(msg.peerId);
          break;
        }

        case "error": {
          console.error("Server error:", msg.message);
          if (msg.producerId) {
            pending.consume.get(msg.producerId)?.reject(new Error(msg.message));
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
    transport.on("produce", ({ kind, rtpParameters }, callback) => {
      const producedPromise = new Promise((resolve) => {
        pendingRef.current.produce = { resolve };
      });
      send({ type: "meet-produce", transportId: transport.id, kind, rtpParameters });
      producedPromise.then((id) => callback({ id }));
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

  async function startScreenShare() {
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch {
      return; // user cancelled the picker
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    screenTrackRef.current = screenTrack;

    await videoProducerRef.current.replaceTrack({ track: screenTrack });

    // Show the screen in your own preview too, keeping your mic audio track.
    const previewStream = new MediaStream([
      screenTrack,
      ...localStreamRef.current.getAudioTracks(),
    ]);
    if (localVideoRef.current) localVideoRef.current.srcObject = previewStream;

    setSharingScreen(true);
    screenTrack.onended = stopScreenShare; // user clicked the browser's native "Stop sharing"
  }

  async function stopScreenShare() {
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;

    if (cameraTrackRef.current && videoProducerRef.current) {
      await videoProducerRef.current.replaceTrack({ track: cameraTrackRef.current });
    }
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;

    setSharingScreen(false);
  }

  function toggleMic() {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }

  function toggleCamera() {
    // Targets whichever track the video producer currently carries (camera or
    // screen) — disabling it locally is enough; the encoder just stops
    // sending meaningful frames, no renegotiation needed.
    const track = videoProducerRef.current?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }

  function leave() {
    send({ type: "meet-leave" });
    wsRef.current?.close();
    screenTrackRef.current?.stop();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    setJoined(false);
    setStatus("idle");
    setSharingScreen(false);
    setMicOn(true);
    setCameraOn(true);
    setRemoteTiles([]);
    remoteStreamsRef.current.clear();
  }

  useEffect(() => leave, []);

  const [shareLink, setShareLink] = useState("");
  useEffect(() => setShareLink(window.location.href), []);

  if (!joined) {
    return (
      <main className="flex-1 max-w-md mx-auto w-full p-8 flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">Join meeting</h1>
        <p className="text-sm text-zinc-500 break-all">Link: {shareLink}</p>
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
            onClick={toggleMic}
            className={`rounded px-4 py-2 ${
              micOn
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-red-600 text-white"
            }`}
          >
            {micOn ? "Mute" : "Unmute"}
          </button>
          <button
            onClick={toggleCamera}
            disabled={sharingScreen}
            className={`rounded px-4 py-2 disabled:opacity-40 ${
              cameraOn
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "bg-red-600 text-white"
            }`}
          >
            {cameraOn ? "Hide camera" : "Show camera"}
          </button>
          <button
            onClick={sharingScreen ? stopScreenShare : startScreenShare}
            className={`rounded px-4 py-2 ${
              sharingScreen
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

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        <div className="relative">
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-black aspect-video"
          />
          {!cameraOn && !sharingScreen && (
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
        {remoteTiles.map((tile) => (
          <RemoteVideo key={tile.peerId} stream={tile.stream} peerId={tile.peerId} />
        ))}
      </div>
    </main>
  );
}

function RemoteVideo({ stream, peerId }) {
  const ref = useRef(null);
  const [blocked, setBlocked] = useState(false);
  const [debug, setDebug] = useState("");

  useEffect(() => {
    const label = `[remote:${peerId}]`;
    // Fires for tracks added to this same stream *after* this effect already
    // ran (e.g. video arriving after audio) — no need to touch srcObject or
    // play() again for those, the live stream just keeps working.
    stream.onaddtrack = (e) =>
      console.log(`${label} track added post-mount: ${e.track.kind}`);

    if (!ref.current) return;
    const video = ref.current;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.onloadedmetadata = () =>
      console.log(`${label} loadedmetadata — videoWidth=${video.videoWidth} videoHeight=${video.videoHeight}`);
    video.onplaying = () => {
      console.log(`${label} playing — videoWidth=${video.videoWidth} videoHeight=${video.videoHeight}`);
      setDebug(`playing ${video.videoWidth}x${video.videoHeight}`);
    };
    video.onerror = () => console.log(`${label} video element error:`, video.error);

    video.play()
      .then(() => console.log(`${label} play() resolved`))
      .catch((err) => {
        console.log(`${label} play() REJECTED:`, err.name, err.message);
        setBlocked(true);
      });
  }, [stream, peerId]);

  function forcePlay() {
    ref.current
      ?.play()
      .then(() => setBlocked(false))
      .catch((err) => console.log(`[remote:${peerId}] forcePlay REJECTED:`, err.name, err.message));
  }

  // Any click anywhere on the page is a valid user gesture — don't make the
  // user hunt for this exact tile's overlay when a click elsewhere works too.
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
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-black aspect-video"
      />
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
