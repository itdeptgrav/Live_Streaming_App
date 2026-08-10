"use client";

import { useEffect, useState } from "react";
import { listKeys, createKey, revokeKey } from "@/lib/platformApi";

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function KeysPage() {
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(null);

  // Initial load. Kept as a promise chain rather than `await refresh()` so no
  // state is set synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    listKeys()
      .then((res) => {
        if (!cancelled) setKeys(res.keys || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load API keys");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reload after a create or revoke.
  async function refresh() {
    try {
      const res = await listKeys();
      setKeys(res.keys || []);
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load API keys");
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const res = await createKey(name.trim());
      setNewKey(res.key || null);
      setCopied(false);
      setName("");
      await refresh();
    } catch (err) {
      setError(err.message || "Could not create the key");
    }
    setCreating(false);
  }

  async function handleRevoke(id) {
    setError(null);
    setRevoking(id);
    try {
      await revokeKey(id);
      await refresh();
    } catch (err) {
      setError(err.message || "Could not revoke the key");
    }
    setRevoking(null);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="flex-1 max-w-5xl mx-auto w-full p-8 flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">API keys</h1>
      <p className="text-sm text-zinc-500">
        Use an API key from your backend to create rooms and mint participant
        tokens. Never ship a key to the browser.
      </p>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {newKey && (
        <div className="border border-zinc-900 dark:border-zinc-100 rounded-lg p-4 flex flex-col gap-3">
          <p className="font-medium">Copy your new API key now</p>
          <p className="text-sm text-red-600">
            This is the only time the full key will be shown. Once you leave this
            page it cannot be retrieved again — store it in your backend secrets.
          </p>
          <code className="block bg-zinc-100 dark:bg-zinc-900 rounded p-3 text-xs break-all font-mono">
            {newKey}
          </code>
          <div className="flex items-center gap-3">
            <button
              onClick={handleCopy}
              className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2 text-sm"
            >
              {copied ? "Copied" : "Copy key"}
            </button>
            <button
              onClick={() => setNewKey(null)}
              className="text-sm text-zinc-500 underline"
            >
              I have stored it — hide
            </button>
          </div>
        </div>
      )}

      <form
        onSubmit={handleCreate}
        className="flex flex-col sm:flex-row gap-3 sm:items-end"
      >
        <label className="flex flex-col gap-1 flex-1">
          <span className="text-sm">Key name</span>
          <input
            type="text"
            required
            placeholder="Production backend"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
          />
        </label>
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>

      {!keys && !error && <p className="text-zinc-500">Loading keys…</p>}

      {keys && keys.length === 0 && (
        <p className="text-sm text-zinc-500">
          No API keys yet — create one above to start calling the API.
        </p>
      )}

      {keys && keys.length > 0 && (
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left text-zinc-500">
                <th className="font-normal px-4 py-3">Name</th>
                <th className="font-normal px-4 py-3">Key</th>
                <th className="font-normal px-4 py-3">Created</th>
                <th className="font-normal px-4 py-3">Last used</th>
                <th className="font-normal px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr
                  key={key.id}
                  className={`border-b border-zinc-100 dark:border-zinc-900 last:border-0 ${
                    key.revoked ? "text-zinc-400 dark:text-zinc-600" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      {key.name}
                      {key.revoked && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
                          Revoked
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {key.keyPrefix}…
                  </td>
                  <td className="px-4 py-3">{formatDate(key.createdAt)}</td>
                  <td className="px-4 py-3">
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!key.revoked && (
                      <button
                        onClick={() => handleRevoke(key.id)}
                        disabled={revoking === key.id}
                        className="text-sm border border-zinc-300 dark:border-zinc-700 rounded px-3 py-1.5 disabled:opacity-50"
                      >
                        {revoking === key.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
