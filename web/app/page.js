"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL;

export default function Dashboard() {
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setError(null);
      ws.send(JSON.stringify({ type: "list-rooms" }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "room-list") {
        setError(null);
        setRooms(msg.rooms);
      }
    };
    ws.onerror = () => {
      // In dev, React Strict Mode mounts effects twice, closing this socket
      // before it opens and firing a spurious error — only surface it if the
      // second (real) connection never comes through.
      if (ws === wsRef.current) setError("Could not reach signaling server");
    };

    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "list-rooms" }));
      }
    }, 4000);

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, []);

  return (
    <main className="flex-1 max-w-4xl mx-auto w-full p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Device Rooms</h1>
        <Link
          href="/meet"
          className="text-sm bg-black text-white dark:bg-white dark:text-black rounded px-3 py-1.5"
        >
          Start a Meet call
        </Link>
      </div>

      {error && <p className="text-red-600 mb-4">{error}</p>}
      {!rooms && !error && <p className="text-zinc-500">Loading rooms…</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {rooms?.map((room) => (
          <div
            key={room.id}
            className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-2"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{room.label}</span>
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  room.live
                    ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                }`}
              >
                {room.live ? "Live" : "Offline"}
              </span>
            </div>
            <p className="text-sm text-zinc-500">
              {room.viewerCount} viewer{room.viewerCount === 1 ? "" : "s"}
            </p>
            <Link
              href={`/watch/${room.id}`}
              className={`text-sm mt-2 text-center rounded px-3 py-1.5 ${
                room.live
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 pointer-events-none"
              }`}
            >
              View screen
            </Link>
          </div>
        ))}
      </div>
    </main>
  );
}
