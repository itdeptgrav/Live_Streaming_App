// Read LAZILY, never snapshotted at module-evaluation time. mediasoupBootstrap
// sets MEDIASOUP_ANNOUNCED_IP from an async public-IP lookup, and ES module
// siblings evaluate before that top-level await resolves — a const here would
// capture the fallback and silently announce 127.0.0.1 in production.
//
// The value MUST be routable: announcing 0.0.0.0 makes Chrome discard every
// ICE candidate, ICE parks at "new", and no media ever flows despite clean
// signalling logs. mediasoup accepts an IPv4, IPv6 or hostname here.
export function getAnnouncedAddress() {
  return process.env.MEDIASOUP_ANNOUNCED_IP || "127.0.0.1";
}


// One UDP port per WebRTC transport, two transports per participant. The
// default 100-port window covers ~50 concurrent participants and keeps the
// cloud firewall rule small. These EXACT ports must be open in BOTH the cloud
// firewall (e.g. an OCI Security List) and the instance's own iptables.
export function getWorkerSettings() {
  return {
    rtcMinPort: Number(process.env.MEDIASOUP_MIN_PORT || 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_MAX_PORT || 40100),
    logLevel: process.env.MEDIASOUP_LOG_LEVEL || "warn",
  };
}

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

export function getWebRtcTransportOptions() {
  const announcedAddress = getAnnouncedAddress();
  return {
    listenInfos: [
      { protocol: "udp", ip: "0.0.0.0", announcedAddress },
      { protocol: "tcp", ip: "0.0.0.0", announcedAddress },
    ],
    initialAvailableOutgoingBitrate: 800000,
  };
}

// Practical ceiling for a mesh-free SFU room before you'd want to consider
// simulcast/selective forwarding tuning. Not a hard technical limit — but on a
// 2-core box expect frames to start dropping somewhere past 10-15 cameras.
export const MAX_MEET_PARTICIPANTS = Number(process.env.MAX_MEET_PARTICIPANTS || 30);