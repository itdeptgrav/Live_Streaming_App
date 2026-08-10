import Link from "next/link";

// Landing page for the platform. The legacy device-rooms view that used to
// live here is unchanged and still available at /monitor.
export default function HomePage() {
  return (
    <main className="flex-1 w-full">
      <header className="max-w-5xl mx-auto w-full flex items-center justify-between p-6">
        <span className="font-semibold">Grav Stream</span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login" className="text-zinc-500 hover:text-inherit">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2"
          >
            Get started
          </Link>
        </nav>
      </header>

      <section className="max-w-3xl mx-auto w-full px-6 py-16 flex flex-col gap-6">
        <h1 className="text-4xl font-semibold tracking-tight">
          Video meetings for your product, without the per-minute bill.
        </h1>
        <p className="text-zinc-500 text-lg">
          A self-hosted SFU with a REST API and a drop-in embed. Create a room,
          mint a token, add one iframe — no SDK to install and no WebRTC code to
          maintain.
        </p>
        <div className="flex gap-3">
          <Link
            href="/signup"
            className="bg-black text-white dark:bg-white dark:text-black rounded px-4 py-2"
          >
            Create an account
          </Link>
          <Link
            href="/dashboard/docs"
            className="border border-zinc-300 dark:border-zinc-700 rounded px-4 py-2"
          >
            Read the docs
          </Link>
        </div>
      </section>

      <section className="max-w-5xl mx-auto w-full px-6 pb-20 grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            title: "Two API calls",
            body: "Create a room, mint a per-user token. Your API key never touches the browser.",
          },
          {
            title: "One iframe",
            body: "Camera, mic, screen share, and multi-party layout are all handled for you.",
          },
          {
            title: "Usage you can see",
            body: "Participant-minutes and live session counts, tracked per account.",
          },
        ].map((card) => (
          <div
            key={card.title}
            className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex flex-col gap-2"
          >
            <span className="font-medium">{card.title}</span>
            <p className="text-sm text-zinc-500">{card.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
