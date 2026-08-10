"use client";

import { useEffect, useState } from "react";
import { getUsage } from "@/lib/platformApi";

function StatCard({ label, value }) {
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-1">
      <span className="text-sm text-zinc-500">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function formatDay(day) {
  if (!day) return "";
  const parts = String(day).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : String(day);
}

export default function OverviewPage() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getUsage()
      .then((res) => {
        if (!cancelled) setUsage(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load usage");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = usage?.summary || {};
  const daily = usage?.daily || [];
  const peak = daily.reduce(
    (max, d) => Math.max(max, Number(d.participantMinutes) || 0),
    0
  );
  const hasUsage =
    daily.length > 0 ||
    Number(summary.sessions) > 0 ||
    Number(summary.participantMinutes) > 0;

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full p-8 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {!usage && !error && <p className="text-zinc-500">Loading usage…</p>}

      {usage && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Participant minutes"
              value={Number(summary.participantMinutes || 0).toLocaleString()}
            />
            <StatCard
              label="Sessions"
              value={Number(summary.sessions || 0).toLocaleString()}
            />
            <StatCard
              label="Rooms"
              value={Number(summary.rooms || 0).toLocaleString()}
            />
            <StatCard
              label="Live participants"
              value={Number(summary.liveParticipants || 0).toLocaleString()}
            />
          </div>

          <section className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-4">
            <div className="flex items-baseline justify-between">
              <h2 className="font-medium">Participant minutes per day</h2>
              {daily.length > 0 && (
                <span className="text-xs text-zinc-500">
                  Peak {peak.toLocaleString()} min
                </span>
              )}
            </div>

            {!hasUsage || daily.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No usage yet — create your first room via the API.
              </p>
            ) : (
              <div className="flex items-end gap-1 h-48">
                {daily.map((d) => {
                  const minutes = Number(d.participantMinutes) || 0;
                  const height = peak > 0 ? (minutes / peak) * 100 : 0;
                  return (
                    <div
                      key={d.day}
                      className="flex-1 flex flex-col items-center justify-end gap-1 h-full group"
                      title={`${d.day}: ${minutes} participant minutes, ${
                        Number(d.sessions) || 0
                      } sessions`}
                    >
                      <div className="w-full flex-1 flex items-end">
                        <div
                          className="w-full bg-zinc-900 dark:bg-zinc-100 rounded-t min-h-px"
                          style={{ height: `${height}%` }}
                        />
                      </div>
                      <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                        {formatDay(d.day)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
