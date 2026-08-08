import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tune ANNOUNCED_IP for production: it must be the realtime server's public IP
// (or public hostname resolved to IP) so remote participants' ICE negotiation
// can reach it. Leave unset for local dev (mediasoup falls back to listenIp).
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || undefined;

// Prebuilt worker binary (compiled in CI, committed to repo) so Render's
// free-tier build never has to compile mediasoup's C++ worker itself.
// Set this env var to point mediasoup at it before createWorker() runs.
const PREBUILT_WORKER = path.join(__dirname, "prebuilt", "mediasoup-worker");
process.env.MEDIASOUP_WORKER_BIN = PREBUILT_WORKER;

export const workerSettings = {
  rtcMinPort: 40000,
  rtcMaxPort: 49999,
  logLevel: "warn",
};

export const routerMediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
    rtcpFeedback: [
      { type: "nack" },
      { type: "nack", parameter: "pli" },
      { type: "ccm", parameter: "fir" },
      { type: "goog-remb" },
    ],
  },
];

export const webRtcTransportOptions = {
  listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 800000,
};

// Practical ceiling for a mesh-free SFU room before you'd want to consider
// simulcast/selective forwarding tuning. Not a hard technical limit.
export const MAX_MEET_PARTICIPANTS = 30;