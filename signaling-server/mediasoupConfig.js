import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tune ANNOUNCED_IP for production: it must be the realtime server's public IP
// (or public hostname resolved to IP) so remote participants' ICE negotiation
// can reach it. Leave unset for local dev (mediasoup falls back to listenIp).
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || "192.168.1.55";


export const workerSettings = {
  rtcMinPort: 40000,
  rtcMaxPort: 49999,
  logLevel: "warn",
};

const VIDEO_FEEDBACK = [
  { type: "nack" },
  { type: "nack", parameter: "pli" },
  { type: "ccm", parameter: "fir" },
  { type: "goog-remb" },
  // Lets the sender's congestion control see per-packet arrival times instead
  // of only REMB's coarse estimate, so the bitrate settles faster and dips
  // less on a busy connection.
  { type: "transport-cc" },
];

// Order is preference order. H.264 is first deliberately: virtually every
// machine has a hardware H.264 encoder, while VP8 is software-only in most
// browsers. Encoding a full desktop in software is what pins a CPU at 100%
// and makes the sharer's machine stop responding. VP8 stays as a fallback for
// anything that cannot do H.264.
export const routerMediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      // Constrained Baseline 3.1 — the profile hardware encoders universally
      // support.
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 1500,
    },
    rtcpFeedback: VIDEO_FEEDBACK,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1500 },
    rtcpFeedback: VIDEO_FEEDBACK,
  },
];

export const webRtcTransportOptions = {
  listenInfos: [
    { protocol: "udp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP },
    { protocol: "tcp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP },
  ],
  // Screen text needs bitrate immediately. Starting at 800 kbps meant the
  // first seconds of a share were heavily compressed, and congestion control
  // then had to climb from there — which is what made small text unreadable
  // right when someone started watching.
  initialAvailableOutgoingBitrate: 3_000_000,
};

// Practical ceiling for a mesh-free SFU room before you'd want to consider
// simulcast/selective forwarding tuning. Not a hard technical limit.
export const MAX_MEET_PARTICIPANTS = 30;