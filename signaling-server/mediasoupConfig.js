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
  listenInfos: [
    { protocol: "udp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP },
    { protocol: "tcp", ip: "0.0.0.0", announcedAddress: ANNOUNCED_IP },
  ],
  initialAvailableOutgoingBitrate: 800000,
};

// Practical ceiling for a mesh-free SFU room before you'd want to consider
// simulcast/selective forwarding tuning. Not a hard technical limit.
export const MAX_MEET_PARTICIPANTS = 30;