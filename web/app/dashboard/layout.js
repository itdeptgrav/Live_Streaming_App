"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { me, logout, setSessionToken } from "@/lib/platformApi";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/keys", label: "API keys" },
  { href: "/dashboard/rooms", label: "Rooms" },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/docs", label: "Docs" },
];

export default function DashboardLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [account, setAccount] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    me()
      .then((res) => {
        if (!cancelled) setAccount(res.user || {});
      })
      .catch(() => {
        if (!cancelled) router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await logout();
    } catch {
      // The session is being discarded either way.
    }
    setSessionToken(null);
    router.push("/login");
  }

  if (!account) {
    return (
      <main className="flex-1 max-w-5xl mx-auto w-full p-8">
        <p className="text-zinc-500">Loading…</p>
      </main>
    );
  }

  return (
    <div className="flex-1 flex flex-col">
      <header className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-5xl mx-auto w-full px-8 py-4 flex items-center justify-between gap-4">
          {/* Wraps rather than overflowing: five links no longer fit on a
              phone in one row. */}
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            {NAV.map((item) => {
              const active =
                item.href === "/dashboard"
                  ? pathname === "/dashboard"
                  : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    active
                      ? "font-semibold underline underline-offset-4"
                      : "text-zinc-500"
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="flex items-center gap-3">
            {account.email && (
              <span className="text-sm text-zinc-500 hidden sm:inline">
                {account.email}
              </span>
            )}
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="text-sm border border-zinc-300 dark:border-zinc-700 rounded px-3 py-1.5 disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>

      {children}
    </div>
  );
}
