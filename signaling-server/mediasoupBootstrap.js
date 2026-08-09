// Must be imported FIRST, before any file imports "mediasoup" itself.
// mediasoup reads MEDIASOUP_WORKER_BIN at its own module-evaluation time,
// so setting this env var inside mediasoupConfig.js (which gets imported
// after mediasoup.js in meetRooms.js) is too late — mediasoup has already
// resolved its default compiled-in-place worker path by then.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The checked-in prebuilt worker is a Linux x86-64 ELF binary produced by
// .github/workflows/build-mediasoup-worker.yml so Render can boot without a
// C++ toolchain. Windows and macOS cannot execute it — forcing this path there
// gives "spawn ...\prebuilt\mediasoup-worker ENOENT". On those platforms leave
// the env var unset and let mediasoup use the worker it compiled locally
// during npm install.
const PREBUILT_WORKER = path.join(__dirname, "prebuilt", "mediasoup-worker");

if (process.env.MEDIASOUP_WORKER_BIN) {
    console.log(`[mediasoup] using worker from env: ${process.env.MEDIASOUP_WORKER_BIN}`);
} else if (process.platform === "linux" && os.arch() === "x64" && fs.existsSync(PREBUILT_WORKER)) {
    process.env.MEDIASOUP_WORKER_BIN = PREBUILT_WORKER;
    console.log(`[mediasoup] using prebuilt Linux worker: ${PREBUILT_WORKER}`);
} else {
    console.warn(
        `[mediasoup] prebuilt worker unusable on ${process.platform}/${os.arch()} — ` +
        `falling back to the locally compiled worker in node_modules`
    );
}

// ---- announced address ----------------------------------------------------
// mediasoup MUST announce a routable address in its ICE candidates. If it
// announces 0.0.0.0, Chrome silently discards every candidate, ICE never
// leaves the "new" state, and no RTP ever flows — with perfectly clean
// signalling logs. Order of preference:
//   1. MEDIASOUP_ANNOUNCED_IP  (set this to your domain in production)
//   2. the host's public IPv4, detected at boot
//   3. 127.0.0.1               (local dev only)
if (!process.env.MEDIASOUP_ANNOUNCED_IP) {
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
    const ip = (await res.text()).trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      process.env.MEDIASOUP_ANNOUNCED_IP = ip;
      console.log(`[mediasoup] auto-detected public IP: ${ip}`);
    }
  } catch {
    console.warn("[mediasoup] public IP detection failed — falling back to 127.0.0.1");
  }
}
