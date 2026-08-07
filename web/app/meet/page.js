"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createMeetRoom } from "@/lib/realtime";

export default function MeetHome() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const { roomId } = await createMeetRoom();
      router.push(`/meet/${roomId}`);
    } catch {
      setError("Could not reach the realtime server");
      setCreating(false);
    }
  }

  return (
    <main className="flex-1 max-w-xl mx-auto w-full p-8 flex flex-col gap-4 items-start">
      <h1 className="text-2xl font-semibold">Meet</h1>
      <p className="text-sm text-zinc-500">
        Create a room and share its link — anyone with the link can join, up to 30
        people per room.
      </p>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <button
        onClick={handleCreate}
        disabled={creating}
        className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2 disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create meeting"}
      </button>
    </main>
  );
}
