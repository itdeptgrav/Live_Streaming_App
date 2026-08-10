"use client";

import { useEffect, useState } from "react";
import { getRooms } from "@/lib/platformApi";

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getRooms()
      .then((res) => {
        if (!cancelled) setRooms(res.rooms || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load rooms");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full p-8 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Rooms</h1>
      <p className="text-sm text-zinc-500">
        Every room created with your API keys, newest first.
      </p>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {!rooms && !error && <p className="text-zinc-500">Loading rooms…</p>}

      {rooms && rooms.length === 0 && (
        <p className="text-sm text-zinc-500">
          No rooms yet — create one with{" "}
          <code className="font-mono text-xs">POST /api/v1/rooms</code> to see it
          here.
        </p>
      )}

      {rooms && rooms.length > 0 && (
        <div className="flex flex-col gap-3">
          {rooms.map((room) => (
            <div
              key={room.roomId}
              className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{room.name || room.roomId}</span>
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

              <code className="font-mono text-xs text-zinc-500 break-all">
                {room.roomId}
              </code>

              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-500">
                <span>
                  {Number(room.participantCount) || 0} in room now
                </span>
                <span>
                  {Number(room.totalParticipants) || 0} total participant
                  {Number(room.totalParticipants) === 1 ? "" : "s"}
                </span>
                <span>Created {formatDate(room.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
