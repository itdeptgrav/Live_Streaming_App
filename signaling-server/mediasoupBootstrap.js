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