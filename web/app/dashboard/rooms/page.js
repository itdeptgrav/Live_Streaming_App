"use client";

import { useCallback, useEffect, useState } from "react";
import { getRooms } from "@/lib/platformApi";

// GET /api/dashboard/rooms returns exactly:
//   roomId, name, mode, requireEntireScreen, createdAt, endedAt,
//   maxParticipants, totalParticipants, live, participantCount
// Per-participant sharing state (who is sharing what surface) is only on the
// API-key endpoint GET /api/v1/rooms/:roomId, so it is not shown here.

const RING = "ring-1 ring-zinc-950/10 dark:ring-white/10";
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950";

const REFRESH_MS = 10000;

function ModeBadge({ mode, requireEntireScreen }) {
  const screen = mode === "screen";
  return (
    <span
      title={
        screen
          ? requireEntireScreen
            ? "Screen monitoring — only whole-display shares are accepted"
            : "Screen sharing — any surface is accepted"
          : "Meeting room — camera and microphone"
      }
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${
        screen
          ? "bg-sky-500/10 text-sky-700 ring-sky-600/25 dark:text-sky-300 dark:ring-sky-400/25"
          : "bg-zinc-500/10 text-zinc-600 ring-zinc-500/25 dark:text-zinc-300 dark:ring-white/15"
      }`}
    >
      {screen ? "Screen" : "Meeting"}
      {screen && requireEntireScreen && <span aria-hidden>· full</span>}
    </span>
  );
}

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

function num(value) {
  return Number(value) || 0;
}

function StatusPill({ live, ended }) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/25 dark:text-emerald-400 dark:ring-emerald-400/25">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
        Live
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 ${RING}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-600" />
      {ended ? "Ended" : "Offline"}
    </span>
  );
}

function Capacity({ count, max }) {
  const ceiling = max > 0 ? max : 0;
  const pct = ceiling > 0 ? Math.min(100, (count / ceiling) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">In room</span>
      <span className="text-sm font-medium tabular-nums">
        {count}
        {ceiling > 0 && (
          <span className="text-zinc-500 dark:text-zinc-400"> / {ceiling}</span>
        )}
      </span>
      {ceiling > 0 && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-950/10 dark:bg-white/10">
          <div
            className={`h-full rounded-full ${
              count > 0 ? "bg-emerald-500" : "bg-transparent"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function RoomCard({ room }) {
  const count = num(room.participantCount);
  const live = Boolean(room.live);

  return (
    <li
      className={`flex flex-col gap-4 rounded-xl p-4 sm:p-5 ${RING} ${
        live ? "bg-emerald-500/[0.04]" : ""
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-medium">{room.name || room.roomId}</h2>
            <ModeBadge mode={room.mode} requireEntireScreen={room.requireEntireScreen} />
          </div>
          <code className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
            {room.roomId}
          </code>
        </div>
        <StatusPill live={live} ended={Boolean(room.endedAt)} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Capacity count={count} max={num(room.maxParticipants)} />
        <Field
          label="Total participants"
          value={num(room.totalParticipants).toLocaleString()}
        />
        <Field label="Created" value={formatDate(room.createdAt)} />
        <Field
          label="Ended"
          value={room.endedAt ? formatDate(room.endedAt) : "—"}
        />
      </div>
    </li>
  );
}

function Summary({ rooms }) {
  const liveRooms = rooms.filter((r) => r.live);
  const watching = liveRooms.reduce((n, r) => n + num(r.participantCount), 0);

  const stats = [
    { label: "Rooms", value: rooms.length },
    { label: "Live now", value: liveRooms.length },
    { label: "Participants connected", value: watching },
  ];

  return (
    <dl
      className={`grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-zinc-950/10 sm:grid-cols-3 dark:bg-white/10 ${RING}`}
    >
      {stats.map((stat) => (
        <div key={stat.label} className="bg-white p-4 dark:bg-zinc-950">
          <dt className="text-sm text-zinc-500 dark:text-zinc-400">
            {stat.label}
          </dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">
            {stat.value.toLocaleString()}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getRooms();
      setRooms(res.rooms || []);
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load rooms");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function tick() {
      if (cancelled) return;
      await load();
      if (!cancelled) timer = setTimeout(tick, REFRESH_MS);
    }
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  // Live rooms are what a monitoring dashboard is actually looking for, so they
  // float to the top; everything else keeps the server's newest-first order.
  const ordered = rooms
    ? [...rooms].sort((a, b) => {
        if (Boolean(a.live) !== Boolean(b.live)) return a.live ? -1 : 1;
        return num(b.createdAt) - num(a.createdAt);
      })
    : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8 font-sans sm:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rooms</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Every room created with your API keys. Live rooms first, then newest.
            Refreshes automatically.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors hover:bg-zinc-950/5 disabled:opacity-50 dark:hover:bg-white/5 ${RING} ${FOCUS}`}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p className="rounded-xl bg-rose-500/10 p-4 text-sm text-rose-700 ring-1 ring-rose-600/25 dark:text-rose-300">
          {error}
        </p>
      )}

      {!ordered && !error && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading rooms…
        </p>
      )}

      {ordered && ordered.length > 0 && <Summary rooms={ordered} />}

      {ordered && ordered.length === 0 && (
        <div
          className={`flex flex-col items-start gap-2 rounded-xl p-8 ${RING}`}
        >
          <p className="font-medium">No rooms yet</p>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Create one from your backend with{" "}
            <code className="rounded bg-zinc-950/5 px-1 py-0.5 font-mono text-xs dark:bg-white/10">
              POST /api/v1/rooms
            </code>{" "}
            and it will show up here.
          </p>
        </div>
      )}

      {ordered && ordered.length > 0 && (
        <ul className="flex flex-col gap-3">
          {ordered.map((room) => (
            <RoomCard key={room.roomId} room={room} />
          ))}
        </ul>
      )}
    </main>
  );
}
