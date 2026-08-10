import Link from "next/link";

// Public landing page for Grav Stream.
//
// The legacy device-rooms view that used to live here is unchanged and still
// served from /monitor — nothing in this file is imported anywhere else, so
// replacing it does not touch the /monitor, /watch, /broadcast or /embed flows.

export const metadata = {
  title: "Grav Stream — self-hosted screen monitoring you embed in one iframe",
  description:
    "Employees share their entire screen, managers watch it live. Two server-side API calls and one iframe. Self-hosted on your own VPS, built on a mediasoup SFU.",
};

const SHELL = "mx-auto w-full max-w-6xl px-6";
const CARD =
  "rounded-xl bg-white/60 p-5 ring-1 ring-zinc-950/10 dark:bg-white/[0.02] dark:ring-white/10";
const PRE =
  "overflow-x-auto rounded-lg bg-zinc-900 p-4 text-xs leading-relaxed text-zinc-200 ring-1 ring-white/10";
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950";
const PRIMARY_BTN =
  `inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 ${FOCUS}`;
const SECONDARY_BTN =
  `inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-zinc-700 ring-1 ring-zinc-950/15 transition-colors hover:bg-zinc-950/5 dark:text-zinc-200 dark:ring-white/15 dark:hover:bg-white/5 ${FOCUS}`;

function Icon({ path, className = "h-5 w-5" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const FEATURES = [
  {
    title: "Entire-screen policy, enforced",
    body: "A screen room can demand a full display. Pick a window or a browser tab and the SFU refuses the producer — it is not a checkbox in the UI.",
    icon: (
      <>
        <rect x="2.5" y="4" width="19" height="13" rx="2" />
        <path d="M8 20.5h8M12 17.5v3" />
      </>
    ),
  },
  {
    title: "Viewers are never prompted",
    body: "A viewer token joins silently — no camera or microphone permission dialog — and any publish attempt from it is rejected server-side.",
    icon: (
      <>
        <path d="M2.5 12S5.5 5.5 12 5.5 21.5 12 21.5 12 18.5 18.5 12 18.5 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="2.75" />
      </>
    ),
  },
  {
    title: "You learn what they picked",
    body: "Room status and the embed both report displaySurface — monitor, window or browser — plus the live resolution of the share.",
    icon: (
      <>
        <path d="M4 19V9m5 10V5m5 14v-7m5 7V8" />
      </>
    ),
  },
  {
    title: "No SDK, no WebRTC code",
    body: "Two REST calls from your backend and one iframe in your frontend. Nothing to install, nothing to keep on a version treadmill.",
    icon: (
      <>
        <path d="M8.5 8.5 4 12l4.5 3.5M15.5 8.5 20 12l-4.5 3.5M13.5 5l-3 14" />
      </>
    ),
  },
  {
    title: "Runs on one small VPS",
    body: "The whole stack — signalling, SFU, dashboard and SQLite — is self-hosted. Media never leaves infrastructure you control.",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="2" />
        <rect x="3" y="13" width="18" height="7" rx="2" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </>
    ),
  },
  {
    title: "Usage you can actually read",
    body: "Participant-minutes, sessions and live participant counts are metered per account, so you can bill or budget against real numbers.",
    icon: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
  },
];

const STEPS = [
  {
    n: "01",
    title: "Create a room",
    body: "One call from your backend, authenticated with an API key that never reaches the browser. A screen room defaults to requiring an entire display.",
    code: `POST /api/v1/rooms
Authorization: Bearer gsk_live_…
Content-Type: application/json

{ "name": "Alice - workstation", "mode": "screen", "requireEntireScreen": true }

→ { "roomId": "c42ce8ff", "mode": "screen", "url": "wss://stream.grav.in" }`,
  },
  {
    n: "02",
    title: "Mint a token per person",
    body: "One token per participant. The employee gets a publisher token, the manager a viewer token — the role is baked into the token, not chosen in the UI.",
    code: `POST /api/v1/rooms/c42ce8ff/tokens
Authorization: Bearer gsk_live_…

{ "identity": "employee-42", "name": "Alice", "role": "publisher" }

→ { "token": "eyJhbGciOiJIUzI1NiIs…", "role": "publisher", "mode": "screen" }`,
  },
  {
    n: "03",
    title: "Embed the iframe",
    body: "Hand the room id and token to your frontend and render one iframe. The allow attribute is mandatory — without it the browser blocks screen capture outright.",
    code: `<iframe
  src="https://live.grav.in/embed/c42ce8ff?token=ROOM_TOKEN"
  allow="camera; microphone; display-capture; autoplay"
  style="width:100%;height:100%;border:0"
></iframe>`,
  },
];

const COMPARISON = [
  {
    label: "Where it runs",
    grav: "Your own VPS. Media terminates on a host you own.",
    hosted: "The vendor's cloud, in whichever regions they offer.",
  },
  {
    label: "What it costs",
    grav: "The price of the server. Participant-minutes are metered for your own reporting.",
    hosted: "Metered per participant-minute, billed by the vendor.",
  },
  {
    label: "Client integration",
    grav: "One iframe. No npm package, no WebRTC code.",
    hosted: "A client SDK plus component library you install and upgrade.",
  },
  {
    label: "Screen-share policy",
    grav: "requireEntireScreen is enforced by the SFU; window and tab shares are refused.",
    hosted: "Typically left to your own UI to police.",
  },
  {
    label: "Viewer permissions",
    grav: "Viewer tokens cannot publish and trigger no device prompt.",
    hosted: "Usually expressed as token grants you wire up yourself.",
  },
  {
    label: "Topology",
    grav: "mediasoup SFU — one upstream per publisher, not a full mesh.",
    hosted: "Varies; mesh for small rooms is common.",
  },
];

export default function HomePage() {
  return (
    <div className="flex-1 w-full font-sans text-zinc-900 dark:text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-zinc-950/5 bg-white/80 backdrop-blur dark:border-white/5 dark:bg-zinc-950/70">
        <div className={`${SHELL} flex h-14 items-center justify-between gap-4`}>
          <Link
            href="/"
            className={`flex items-center gap-2 rounded ${FOCUS}`}
            aria-label="Grav Stream home"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white">
              <Icon
                className="h-3.5 w-3.5"
                path={
                  <>
                    <rect x="2.5" y="4.5" width="19" height="12" rx="2" />
                    <path d="M8 20h8" />
                  </>
                }
              />
            </span>
            <span className="text-sm font-semibold tracking-tight">
              Grav Stream
            </span>
          </Link>

          <nav className="flex items-center gap-1 sm:gap-2">
            <Link
              href="/dashboard/docs"
              className={`hidden rounded-lg px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 sm:inline-flex dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}
            >
              Docs
            </Link>
            <Link
              href="/login"
              className={`rounded-lg px-3 py-1.5 text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className={`inline-flex items-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 ${FOCUS}`}
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      <main>
        {/* ---------------------------------------------------------- hero */}
        <section className="relative overflow-hidden border-b border-zinc-950/5 dark:border-white/5">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-40 h-80 bg-[radial-gradient(45rem_20rem_at_50%_100%,rgba(16,185,129,0.16),transparent)]"
          />
          <div
            className={`${SHELL} relative flex flex-col items-start gap-8 py-20 sm:py-28`}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20 dark:text-emerald-400 dark:ring-emerald-400/20">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Self-hosted screen monitoring
            </span>

            <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              See the screen, not a status update.
            </h1>

            <p className="max-w-2xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
              Grav Stream lets an employee share their{" "}
              <span className="text-zinc-900 dark:text-zinc-100">
                entire screen
              </span>{" "}
              while a manager watches it live, inside your own product. Two
              server-side API calls and one iframe — no SDK, no WebRTC code, and
              nothing running on someone else&apos;s cloud.
            </p>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className={PRIMARY_BTN}>
                Get started
              </Link>
              <Link href="/login" className={SECONDARY_BTN}>
                Sign in
              </Link>
            </div>

            <dl className="mt-4 grid w-full grid-cols-1 gap-px overflow-hidden rounded-xl bg-zinc-950/10 ring-1 ring-zinc-950/10 sm:grid-cols-3 dark:bg-white/10 dark:ring-white/10">
              {[
                {
                  term: "2 API calls + 1 iframe",
                  desc: "The whole client-side integration.",
                },
                {
                  term: "Window shares refused",
                  desc: "Entire-screen policy enforced at the SFU.",
                },
                {
                  term: "Viewers publish nothing",
                  desc: "Enforced by the token, not the interface.",
                },
              ].map((item) => (
                <div
                  key={item.term}
                  className="bg-white p-5 dark:bg-zinc-950"
                >
                  <dt className="text-sm font-medium">{item.term}</dt>
                  <dd className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {item.desc}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* -------------------------------------------------- how it works */}
        <section
          aria-labelledby="how-it-works"
          className="border-b border-zinc-950/5 dark:border-white/5"
        >
          <div className={`${SHELL} py-20 sm:py-24`}>
            <h2
              id="how-it-works"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Three steps, then you are done
            </h2>
            <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
              Your backend talks to the REST API with a bearer key. Your
              frontend never sees that key — only a short-lived room token.
            </p>

            <ol className="mt-10 flex flex-col gap-10">
              {STEPS.map((step) => (
                <li
                  key={step.n}
                  className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-10"
                >
                  <div>
                    <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                      {step.n}
                    </span>
                    <h3 className="mt-2 text-lg font-medium">{step.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                      {step.body}
                    </p>
                  </div>
                  <pre className={PRE}>
                    <code>{step.code}</code>
                  </pre>
                </li>
              ))}
            </ol>

            <p className="mt-10 text-sm text-zinc-600 dark:text-zinc-400">
              The full reference — every endpoint, the postMessage event table
              and the error codes — is in the{" "}
              <Link
                href="/dashboard/docs"
                className={`rounded font-medium text-emerald-700 underline underline-offset-4 hover:text-emerald-600 dark:text-emerald-400 ${FOCUS}`}
              >
                integration docs
              </Link>
              .
            </p>
          </div>
        </section>

        {/* ------------------------------------------------ roles / modes */}
        <section
          aria-labelledby="roles"
          className="border-b border-zinc-950/5 dark:border-white/5"
        >
          <div className={`${SHELL} py-20 sm:py-24`}>
            <h2
              id="roles"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              One room, two sides
            </h2>
            <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
              Roles are set per token, so the person sharing and the person
              watching join the same room with different capabilities.
            </p>

            <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className={CARD}>
                <h3 className="text-base font-medium">
                  <code className="font-mono text-sm text-emerald-700 dark:text-emerald-400">
                    publisher
                  </code>{" "}
                  — the employee
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Gets a screen picker. In a screen room the camera and
                  microphone are never requested at all; in a meeting room they
                  are, and a screen can be shared on top.
                </p>
              </div>
              <div className={CARD}>
                <h3 className="text-base font-medium">
                  <code className="font-mono text-sm text-emerald-700 dark:text-emerald-400">
                    viewer
                  </code>{" "}
                  — the manager
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                  Joins automatically with no permission prompt of any kind, and
                  cannot publish. The SFU rejects a publish attempt from a viewer
                  token, so this is an access-control boundary.
                </p>
              </div>
            </div>

            <div className="mt-8 overflow-x-auto rounded-xl ring-1 ring-zinc-950/10 dark:ring-white/10">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <caption className="sr-only">Room modes</caption>
                <thead className="text-zinc-500 dark:text-zinc-400">
                  <tr className="border-b border-zinc-950/10 dark:border-white/10">
                    <th scope="col" className="px-5 py-3 font-normal">
                      Mode
                    </th>
                    <th scope="col" className="px-5 py-3 font-normal">
                      Use it for
                    </th>
                    <th scope="col" className="px-5 py-3 font-normal">
                      What the embed does
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-zinc-950/10 dark:border-white/10">
                    <th scope="row" className="px-5 py-4 font-mono text-xs font-normal align-top">
                      screen
                    </th>
                    <td className="px-5 py-4 align-top">
                      Screen monitoring: one person shares, others watch
                    </td>
                    <td className="px-5 py-4 align-top text-zinc-600 dark:text-zinc-400">
                      Publisher gets a screen picker; camera and mic are never
                      requested
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" className="px-5 py-4 font-mono text-xs font-normal align-top">
                      meeting
                    </th>
                    <td className="px-5 py-4 align-top">Round-table calls</td>
                    <td className="px-5 py-4 align-top text-zinc-600 dark:text-zinc-400">
                      Publisher gets camera + mic, and can also share a screen
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ features */}
        <section
          aria-labelledby="features"
          className="border-b border-zinc-950/5 dark:border-white/5"
        >
          <div className={`${SHELL} py-20 sm:py-24`}>
            <h2
              id="features"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              What you get
            </h2>

            <ul className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <li key={feature.title} className={CARD}>
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                    <Icon path={feature.icon} />
                  </span>
                  <h3 className="mt-4 text-base font-medium">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
                    {feature.body}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------- comparison */}
        <section
          aria-labelledby="comparison"
          className="border-b border-zinc-950/5 dark:border-white/5"
        >
          <div className={`${SHELL} py-20 sm:py-24`}>
            <h2
              id="comparison"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Coming from a hosted SDK
            </h2>
            <p className="mt-3 max-w-2xl text-zinc-600 dark:text-zinc-400">
              The server-side surface maps almost one-to-one, so a LiveKit
              backend converts by replacing SDK calls with{" "}
              <code className="font-mono text-sm">fetch</code>. The difference is
              where it runs and how much client code you keep.
            </p>

            <div className="mt-10 overflow-x-auto rounded-xl ring-1 ring-zinc-950/10 dark:ring-white/10">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">
                  Grav Stream compared with a typical hosted video SDK
                </caption>
                <thead className="text-zinc-500 dark:text-zinc-400">
                  <tr className="border-b border-zinc-950/10 dark:border-white/10">
                    <th scope="col" className="px-5 py-3 font-normal">
                      &nbsp;
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 font-medium text-emerald-700 dark:text-emerald-400"
                    >
                      Grav Stream
                    </th>
                    <th scope="col" className="px-5 py-3 font-normal">
                      Typical hosted SDK
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARISON.map((row) => (
                    <tr
                      key={row.label}
                      className="border-b border-zinc-950/10 last:border-0 dark:border-white/10"
                    >
                      <th
                        scope="row"
                        className="px-5 py-4 align-top font-medium whitespace-nowrap"
                      >
                        {row.label}
                      </th>
                      <td className="px-5 py-4 align-top">{row.grav}</td>
                      <td className="px-5 py-4 align-top text-zinc-600 dark:text-zinc-400">
                        {row.hosted}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
              On the client,{" "}
              <code className="font-mono text-xs">&lt;LiveKitRoom&gt;</code> and{" "}
              <code className="font-mono text-xs">&lt;VideoConference /&gt;</code>{" "}
              are replaced by the iframe above, after which{" "}
              <code className="font-mono text-xs">livekit-client</code> and its
              component packages can be removed entirely.
            </p>
          </div>
        </section>

        {/* ----------------------------------------------------- final CTA */}
        <section className={`${SHELL} py-20 sm:py-24`}>
          <div className="flex flex-col items-start gap-6 rounded-2xl bg-zinc-950/[0.03] p-8 ring-1 ring-zinc-950/10 sm:p-12 dark:bg-white/[0.03] dark:ring-white/10">
            <h2 className="max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Create a key, create a room, embed the iframe.
            </h2>
            <p className="max-w-xl text-zinc-600 dark:text-zinc-400">
              Sign up, generate an API key from the dashboard, and you can have a
              live screen in front of a manager in a single afternoon.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/signup" className={PRIMARY_BTN}>
                Get started
              </Link>
              <Link href="/dashboard/docs" className={SECONDARY_BTN}>
                Read the docs
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-950/5 dark:border-white/5">
        <div
          className={`${SHELL} flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between`}
        >
          <div>
            <span className="text-sm font-semibold tracking-tight">
              Grav Stream
            </span>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Self-hosted screen sharing and video, built on mediasoup.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            {[
              { href: "/dashboard/docs", label: "Docs" },
              { href: "/dashboard", label: "Dashboard" },
              { href: "/login", label: "Sign in" },
              { href: "/signup", label: "Get started" },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${FOCUS}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
