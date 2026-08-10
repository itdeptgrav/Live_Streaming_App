"use client";

// Export controls for the docs.
//
// Three ways out, because different destinations want different things: a
// Markdown file for a repository or wiki, a plain-text file for an AI
// assistant, and a clipboard copy for when you just want to paste it into a
// chat window without a file touching disk at all.

import { useEffect, useRef, useState } from "react";

const LINK =
  "block w-full px-3 py-2 text-left text-sm hover:bg-zinc-950/5 dark:hover:bg-white/5";

export default function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onAway(event) {
      if (!boxRef.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onAway);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onAway);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Tracks which item is copying, so the feedback lands on the button that
  // was actually pressed rather than on whichever one renders it.
  async function copy(path) {
    setCopied({ path, state: "working" });
    try {
      const text = await fetch(path).then((r) => r.text());
      await navigator.clipboard.writeText(text);
      setCopied({ path, state: "done" });
    } catch {
      setCopied({ path, state: "failed" });
    }
    setTimeout(() => {
      setCopied(null);
      setOpen(false);
    }, 1600);
  }

  return (
    <span ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1.5 text-zinc-600 hover:underline dark:text-zinc-400"
      >
        <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5" fill="currentColor">
          <path d="M8 1.5a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.25A.75.75 0 0 1 8 1.5Z" />
          <path d="M2.5 10a.75.75 0 0 1 .75.75v1.75h9.5V10.75a.75.75 0 0 1 1.5 0v2.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-2.5A.75.75 0 0 1 2.5 10Z" />
        </svg>
        Export
      </button>

      {open && (
        <span
          role="menu"
          className="absolute right-0 top-full z-20 mt-2 w-60 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:ring-white/10"
        >
          <a role="menuitem" className={LINK} href="/docs/grav-stream-docs.md">
            <span className="font-medium">Markdown (.md)</span>
            <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
              For a repo, wiki or README
            </span>
          </a>
          <a role="menuitem" className={LINK} href="/docs/llms.txt">
            <span className="font-medium">Plain text (.txt)</span>
            <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
              For pasting into an AI assistant
            </span>
          </a>
          <CopyItem
            label="Copy setup prompt"
            hint="Hand to an AI to wire up screen sharing"
            path="/docs/publisher-prompt.txt"
            copied={copied}
            onCopy={copy}
          />
          <CopyItem
            label="Copy to clipboard"
            hint="The full reference, no file to download"
            path="/docs/llms.txt"
            copied={copied}
            onCopy={copy}
          />
        </span>
      )}
    </span>
  );
}

function CopyItem({ label, hint, path, copied, onCopy }) {
  const mine = copied?.path === path ? copied.state : null;
  return (
    <button role="menuitem" type="button" onClick={() => onCopy(path)} className={LINK}>
      <span className="font-medium">
        {mine === "done"
          ? "Copied"
          : mine === "failed"
            ? "Copy failed"
            : mine === "working"
              ? "Copying…"
              : label}
      </span>
      <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
    </button>
  );
}
