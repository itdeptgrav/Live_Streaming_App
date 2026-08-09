"use client";

import { use, useEffect, useRef, useState } from "react";
import { getIceServers } from "@/lib/webrtcConfig";

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL;

export default function WatchPage({ params }) {
  const { roomId } = use(params);
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const [status, setStatus] = useState("connecting");

  useEffect(() => {
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "register-viewer", roomId }));
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "registered") {
        setStatus(msg.live ? "waiting-for-stream" : "broadcaster-offline");
      } else if (msg.type === "offer" && msg.from === "broadcaster") {
        const iceServers = await getIceServers();
        const pc = new RTCPeerConnection({ iceServers });
        pcRef.current = pc;

        pc.ontrack = (event) => {
          if (videoRef.current) videoRef.current.srcObject = event.streams[0];
          setStatus("live");
        };
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            ws.send(
              JSON.stringify({ type: "ice-candidate", payload: event.candidate })
            );
          }
        };

        await pc.setRemoteDescription(msg.payload);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", payload: answer }));
      } else if (msg.type === "ice-candidate" && msg.from === "broadcaster") {
        if (pcRef.current && msg.payload) {
          await pcRef.current.addIceCandidate(msg.payload);
        }
      } else if (msg.type === "broadcaster-left") {
        pcRef.current?.close();
        setStatus("broadcaster-offline");
      } else if (msg.type === "error") {
        setStatus(`error: ${msg.message}`);
      }
    };

    return () => {
      pcRef.current?.close();
      ws.close();
    };
  }, [roomId]);

  return (
    <main className="flex-1 max-w-3xl mx-auto w-full p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Watching: {roomId}</h1>
      <p className="text-sm text-zinc-500">Status: {status}</p>

      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-black aspect-video"
      />
    </main>
  );
}
