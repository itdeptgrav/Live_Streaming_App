"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signup, setSessionToken } from "@/lib/platformApi";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await signup({ name, email, password });
      setSessionToken(res.token);
      router.push("/dashboard");
    } catch (err) {
      setError(err.message || "Could not create your account");
      setPending(false);
    }
  }

  return (
    <main className="flex-1 max-w-md mx-auto w-full p-8 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <p className="text-sm text-zinc-500">
        Get an API key and start embedding video meetings in your product.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 mt-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm">Name</span>
          <input
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="border border-zinc-300 dark:border-zinc-700 rounded px-3 py-2 bg-transparent"
          />
        </label>

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
            minLength={8}
            autoComplete="new-password"
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
          {pending ? "Creating account…" : "Create account"}
        </button>
      </form>

      <p className="text-sm text-zinc-500">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
