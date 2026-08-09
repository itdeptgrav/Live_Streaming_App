"use client";

import { use, useEffect, useRef, useState } from "react";
import { getIceServers } from "@/lib/webrtcConfig";
import { SIGNALING_URL } from "@/lib/realtime";

export default function BroadcastPage({ params }) {
  const { roomId } = use(params);
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const iceServersRef = useRef(null);
  const peersRef = useRef(new Map()); // viewerId -> RTCPeerConnection
  const [status, setStatus] = useState("idle");
  const [viewerCount, setViewerCount] = useState(0);

  async function startSharing() {
    setStatus("connecting");
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch {
      setStatus("idle");
      return;
    }
    streamRef.current = stream;
    if (videoRef.current) videoRef.current.srcObject = stream;

    stream.getVideoTracks()[0].onended = stopSharing;

    iceServersRef.current = await getIceServers();

    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "register-broadcaster", roomId }));
      setStatus("live");
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "viewer-joined") {
        await createPeerForViewer(msg.viewerId);
      } else if (msg.type === "answer" && msg.from === "viewer") {
        const pc = peersRef.current.get(msg.targetId);
        if (pc) await pc.setRemoteDescription(msg.payload);
      } else if (msg.type === "ice-candidate" && msg.from === "viewer") {
        const pc = peersRef.current.get(msg.targetId);
        if (pc && msg.payload) await pc.addIceCandidate(msg.payload);
      } else if (msg.type === "viewer-left") {
        const pc = peersRef.current.get(msg.viewerId);
        if (pc) pc.close();
        peersRef.current.delete(msg.viewerId);
        setViewerCount(peersRef.current.size);
      }
    };

    ws.onclose = () => setStatus("idle");
  }

  async function createPeerForViewer(viewerId) {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current });
    peersRef.current.set(viewerId, pc);
    setViewerCount(peersRef.current.size);

    streamRef.current.getTracks().forEach((track) => {
      pc.addTrack(track, streamRef.current);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsRef.current.send(
          JSON.stringify({
            type: "ice-candidate",
            targetId: viewerId,
            payload: event.candidate,
          })
        );
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsRef.current.send(
      JSON.stringify({ type: "offer", targetId: viewerId, payload: offer })
    );
  }

  function stopSharing() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    wsRef.current?.close();
    setStatus("idle");
    setViewerCount(0);
  }

  useEffect(() => stopSharing, []);

  return (
    <main className="flex-1 max-w-3xl mx-auto w-full p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Broadcasting: {roomId}</h1>
      <p className="text-sm text-zinc-500">
        Status: {status} · {viewerCount} viewer{viewerCount === 1 ? "" : "s"} connected
      </p>

      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-black aspect-video"
      />

      {status === "idle" ? (
        <button
          onClick={startSharing}
          className="self-start bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2"
        >
          Start sharing screen
        </button>
      ) : (
        <button
          onClick={stopSharing}
          className="self-start bg-red-600 text-white rounded px-4 py-2"
        >
          Stop sharing
        </button>
      )}
    </main>
  );
}
