"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { login, setSessionToken } from "@/lib/platformApi";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await login({ email, password });
      setSessionToken(res.token);
      router.push("/dashboard");
    } catch (err) {
      setError(err.message || "Could not sign in");
      setPending(false);
    }
  }

  return (
    <main className="flex-1 max-w-md mx-auto w-full p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="text-sm text-zinc-500">
        Sign in to manage your Grav Stream API keys, rooms and usage.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
          />
        </label>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2 disabled:opacity-50"
        >
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p className="text-sm text-zinc-500">
        No account yet?{" "}
        <Link href="/signup" className="underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
