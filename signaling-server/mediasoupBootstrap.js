// Must be imported FIRST, before any file imports "mediasoup" itself.
// mediasoup reads MEDIASOUP_WORKER_BIN at its own module-evaluation time,
// so setting this env var inside mediasoupConfig.js (which gets imported
// after mediasoup.js in meetRooms.js) is too late — mediasoup has already
// resolved its default compiled-in-place worker path by then.
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PREBUILT_WORKER = path.join(__dirname, "prebuilt", "mediasoup-worker");

process.env.MEDIASOUP_WORKER_BIN = PREBUILT_WORKER;