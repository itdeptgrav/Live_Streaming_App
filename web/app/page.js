"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createMeetRoom } from "@/lib/realtime";

export default function Home() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState(null);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      const { roomId } = await createMeetRoom();
      router.push(`/meet/${roomId}`);
    } catch {
      setError("Could not reach the realtime server. Check NEXT_PUBLIC_SIGNALING_URL.");
      setCreating(false);
    }
  }

  function handleJoin() {
    const code = joinCode.trim().replace(/.*\/meet\//, "");
    if (code) router.push(`/meet/${code}`);
  }

  return (
    <main className="flex-1 max-w-xl mx-auto w-full p-8 flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold">KUMKUM</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Group video calls with screen sharing. Create a room, share the link, and
          anyone with it can join — no account needed.
        </p>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      <button
        onClick={handleCreate}
        disabled={creating}
        className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-3 disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create a meeting"}
      </button>

      <div className="flex gap-2">
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          placeholder="Paste a link or room code"
          className="flex-1 border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
        />
        <button
          onClick={handleJoin}
          className="border border-zinc-300 dark:border-zinc-700 rounded px-4 py-2"
        >
          Join
        </button>
      </div>

      <p className="text-xs text-zinc-500 border-t border-zinc-200 dark:border-zinc-800 pt-4">
        Anyone with a room link can join — there is no password or waiting room.
        Treat every link as public.{" "}
        <Link href="/monitor" className="underline">
          Office monitor mode
        </Link>{" "}
        is a separate, unrelated feature.
      </p>
    </main>
  );
}
