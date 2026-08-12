import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { isKnownRoom, MAX_VIEWERS_PER_ROOM, ROOMS } from "./rooms.js";
import {
  getMeetRoom,
  createMeetRoomRecord,
  ensureRouter,
  roomIsFull,
  createWebRtcTransport,
  removePeer,
} from "./meetRooms.js";
import { reconcileOpenSessions, pruneMediaSamples } from "./db.js";
import { verifyRoomToken } from "./auth.js";
import {
  openUsageSession,
  closeUsageSession,
  getRoomOwner,
  recordMediaSample,
} from "./platformStore.js";
import { handleApiRequest } from "./httpApi.js";

const PORT = process.env.PORT || 4000;
// Comma-separated list, e.g. "https://live.grav.in,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((o) => o.trim());
// Advertised back to API clients so their frontends know where to connect.
const PUBLIC_URL = process.env.PUBLIC_URL || `ws://localhost:${PORT}`;

reconcileOpenSessions();
pruneMediaSamples();
// Samples arrive continuously, so prune on a slow timer rather than only at
// boot — a server that stays up for months would otherwise never clean up.
setInterval(() => pruneMediaSamples(), 6 * 60 * 60 * 1000).unref();
 
// ---- office-monitor rooms (unchanged mesh mode) ----
// roomId -> { broadcaster: ws|null, viewers: Map<viewerId, ws> }
const monitorRooms = new Map();

function getMonitorRoom(roomId) {
  if (!monitorRooms.has(roomId)) {
    monitorRooms.set(roomId, { broadcaster: null, viewers: new Map() });
  }
  return monitorRooms.get(roomId);
}

function monitorRoomStatus(roomId) {
  const room = monitorRooms.get(roomId);
  return {
    roomId,
    live: Boolean(room && room.broadcaster),
    viewerCount: room ? room.viewers.size : 0,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function corsOrigin(req) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// ---- plain HTTP: dashboard + public v1 API ----
const httpServer = http.createServer(async (req, res) => {
  const origin = corsOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (origin !== "*") res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const handled = await handleApiRequest(req, res, { publicUrl: PUBLIC_URL });
    if (handled) return;
  } catch (err) {
    console.error(`[http] ${req.method} ${req.url}:`, err);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || "Bad request" }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const wss = new WebSocketServer({ server: httpServer });

// Once media is flowing the signaling socket can sit silent for hours — media
// travels over UDP, not through here. Nginx closes an idle proxied connection
// after proxy_read_timeout, so a long screen share was being cut off with no
// error to explain it. A periodic ping keeps the connection accounted for and
// also detects peers that vanished without a close frame.
const HEARTBEAT_MS = 25_000;

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // Terminating here would mutate the set mid-iteration; the next sweep
      // catches it via isAlive.
    }
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  // Browsers answer protocol-level pings automatically, so nothing is needed
  // on the client for this to work.
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  // Kept from the upgrade request: the only place the browser identifies
  // itself, and the fastest way to explain a codec difference between machines.
  ws.userAgent = req?.headers?.["user-agent"] || null;

  ws.meta = { mode: null, role: null, roomId: null, viewerId: null, peerId: null, usageId: null };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    try {
      if (msg.type?.startsWith("meet-")) {
        await handleMeetMessage(ws, msg);
      } else {
        handleMonitorMessage(ws, msg);
      }
   } catch (err) {
      console.error(`[error] handling "${msg.type}":`, err);
      send(ws, {
        type: "error",
        rid: msg.rid,
        producerId: msg.producerId,
        consumerId: msg.consumerId,
        message: `Server error handling ${msg.type}: ${err.message}`,
      });
    }
  });

  ws.on("close", async () => {
    if (ws.meta.mode === "meet") {
      const room = getMeetRoom(ws.meta.roomId);
      const leaving = room?.peers.get(ws.meta.peerId);
      // Read the counters while the transports still exist — removePeer closes
      // them, and a closed transport reports nothing.
      const bytes = leaving ? await measureTransportBytes(leaving) : {};
      closeUsageSession(ws.meta.usageId, bytes);
      ws.meta.usageId = null;
      if (room && ws.meta.peerId) {
        removePeer(room, ws.meta.peerId);
        for (const peer of room.peers.values()) {
          send(peer.ws, { type: "meet-peer-left", peerId: ws.meta.peerId });
        }
        // Their consumers went with them, so someone may now have no audience.
        notifyDemand(room);
      }
      return;
    }

    const { role, roomId, viewerId } = ws.meta;
    const room = monitorRooms.get(roomId);
    if (!room) return;

    if (role === "broadcaster" && room.broadcaster === ws) {
      room.broadcaster = null;
      for (const viewerWs of room.viewers.values()) {
        send(viewerWs, { type: "broadcaster-left" });
      }
    } else if (role === "viewer") {
      room.viewers.delete(viewerId);
      send(room.broadcaster, { type: "viewer-left", viewerId });
    }
  });
});

// ---------------- office-monitor (mesh) message handling ----------------

function handleMonitorMessage(ws, msg) {
  switch (msg.type) {
    case "list-rooms": {
      send(ws, {
        type: "room-list",
        rooms: ROOMS.map((r) => ({ ...r, ...monitorRoomStatus(r.id) })),
      });
      break;
    }

    case "register-broadcaster": {
      if (!isKnownRoom(msg.roomId)) {
        send(ws, { type: "error", message: "Unknown room" });
        return;
      }
      const room = getMonitorRoom(msg.roomId);
      room.broadcaster = ws;
      ws.meta.mode = "monitor";
      ws.meta.role = "broadcaster";
      ws.meta.roomId = msg.roomId;
      for (const viewerId of room.viewers.keys()) {
        send(ws, { type: "viewer-joined", viewerId });
      }
      break;
    }

    case "register-viewer": {
      if (!isKnownRoom(msg.roomId)) {
        send(ws, { type: "error", message: "Unknown room" });
        return;
      }
      const room = getMonitorRoom(msg.roomId);
      if (room.viewers.size >= MAX_VIEWERS_PER_ROOM) {
        send(ws, { type: "error", message: "Room full" });
        return;
      }
      const viewerId = randomUUID();
      room.viewers.set(viewerId, ws);
      ws.meta.mode = "monitor";
      ws.meta.role = "viewer";
      ws.meta.roomId = msg.roomId;
      ws.meta.viewerId = viewerId;
      send(ws, { type: "registered", viewerId, live: Boolean(room.broadcaster) });
      send(room.broadcaster, { type: "viewer-joined", viewerId });
      break;
    }

    case "offer":
    case "answer":
    case "ice-candidate": {
      const room = monitorRooms.get(ws.meta.roomId);
      if (!room) return;

      if (ws.meta.role === "broadcaster") {
        const viewerWs = room.viewers.get(msg.targetId);
        send(viewerWs, { type: msg.type, from: "broadcaster", payload: msg.payload });
      } else if (ws.meta.role === "viewer") {
        send(room.broadcaster, {
          type: msg.type,
          from: "viewer",
          targetId: ws.meta.viewerId,
          payload: msg.payload,
        });
      }
      break;
    }

    default:
      break;
  }
}

// ---------------- Meet (mediasoup SFU) message handling ----------------

async function handleMeetMessage(ws, msg) {
  switch (msg.type) {
    case "meet-join": {
      const room = getMeetRoom(msg.roomId) || rehydrateRoom(msg.roomId);
      if (!room) {
        send(ws, { type: "error", rid: msg.rid, message: "Room does not exist" });
        return;
      }
      if (roomIsFull(room)) {
        send(ws, { type: "error", rid: msg.rid, message: "Room is full" });
        return;
      }

      // Rooms created through the v1 API belong to an account and require a
      // signed room token. Legacy demo rooms (no owner) stay open so the
      // original /meet pages keep working without credentials.
      let claims = null;
      if (room.ownerUserId) {
        claims = verifyRoomToken(msg.token);
        if (!claims) {
          send(ws, { type: "error", rid: msg.rid, message: "A valid room token is required to join this room" });
          return;
        }
        if (claims.room !== msg.roomId) {
          send(ws, { type: "error", rid: msg.rid, message: "Room token is not valid for this room" });
          return;
        }
      }

      const router = await ensureRouter(room);
      const peerId = randomUUID();
      const identity = claims?.sub || msg.identity || peerId;
      const displayName = claims?.name || msg.displayName || "Guest";

      room.peers.set(peerId, {
        ws,
        identity,
        displayName,
        canPublish: claims ? claims.canPublish !== false : true,
        joinedAt: Date.now(),
        mediaState: { mic: false, camera: false, screen: false },
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      });

      ws.meta.mode = "meet";
      ws.meta.roomId = msg.roomId;
      ws.meta.peerId = peerId;
      if (room.ownerUserId) {
        ws.meta.usageId = openUsageSession({
          userId: room.ownerUserId,
          roomId: msg.roomId,
          peerId,
          identity,
          displayName,
          // Self-reported, so it says which integration path was taken rather
          // than merely which browser made the request.
          client: typeof msg.client === "string" ? msg.client.slice(0, 32) : null,
          clientVersion: typeof msg.clientVersion === "string" ? msg.clientVersion.slice(0, 32) : null,
          userAgent: ws.userAgent,
        });
      }

      const existingProducers = [];
      const existingPeers = [];
      for (const [otherId, peer] of room.peers) {
        if (otherId === peerId) continue;
        existingPeers.push({
          peerId: otherId,
          identity: peer.identity,
          name: peer.displayName,
          role: peer.canPublish === false ? "viewer" : "publisher",
          media: peer.mediaState,
        });
        for (const producer of peer.producers.values()) {
          existingProducers.push({
            producerId: producer.id,
            peerId: otherId,
            kind: producer.kind,
            source: producer.appData?.source || (producer.kind === "audio" ? "mic" : "camera"),
            displaySurface: producer.appData?.displaySurface || null,
            width: producer.appData?.width || null,
            height: producer.appData?.height || null,
          });
        }
      }

      send(ws, {
        type: "meet-joined",
        peerId,
        identity,
        displayName,
        // Echoed back so the client renders from server truth rather than from
        // a token it decoded itself.
        role: claims?.role || (claims?.canPublish === false ? "viewer" : "publisher"),
        canPublish: claims ? claims.canPublish !== false : true,
        mode: room.mode || "meeting",
        requireEntireScreen: Boolean(room.requireEntireScreen),
        rtpCapabilities: router.rtpCapabilities,
        existingProducers,
        existingPeers,
      });

      // Announce the arrival so clients can render a participant tile before
      // any track is published (a peer may join muted and camera-off).
      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === peerId) continue;
        send(otherPeer.ws, { type: "meet-peer-joined", peerId, identity, name: displayName });
      }
      break;
    }

    case "meet-create-transport": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;

      const transport = await createWebRtcTransport(room.router);
      peer.transports.set(transport.id, transport);

      send(ws, {
        type: "meet-transport-created",
        rid: msg.rid,
        direction: msg.direction,
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      });
      break;
    }

    case "meet-connect-transport": {
      const { peer } = currentMeetPeer(ws);
      if (!peer) return;
      const transport = peer.transports.get(msg.transportId);
      if (!transport) return;
      await transport.connect({ dtlsParameters: msg.dtlsParameters });
      send(ws, { type: "meet-transport-connected", rid: msg.rid, transportId: msg.transportId });
      break;
    }

    case "meet-produce": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;
      if (peer.canPublish === false) {
        send(ws, { type: "error", rid: msg.rid, message: "This token does not grant publish permission" });
        return;
      }
      const source = msg.source || (msg.kind === "audio" ? "mic" : "camera");

      // Policy is checked before anything is created. A tampered client that
      // claims "monitor" while sharing one tab is the whole threat model for a
      // monitoring product, so the claim is validated here rather than trusted
      // because the browser was asked nicely.
      if (source === "screen" && room.requireEntireScreen && msg.displaySurface !== "monitor") {
        send(ws, {
          type: "error",
          rid: msg.rid,
          code: "ENTIRE_SCREEN_REQUIRED",
          message:
            "This room requires sharing your entire screen. " +
            `You selected "${msg.displaySurface || "an unreported surface"}".`,
        });
        return;
      }

      const transport = peer.transports.get(msg.transportId);
      if (!transport) {
        // Returning silently here used to leave the client waiting on a reply
        // that never came, until its request timed out with no explanation.
        send(ws, {
          type: "error",
          rid: msg.rid,
          code: "UNKNOWN_TRANSPORT",
          message: "No such send transport — reconnect and try again.",
        });
        return;
      }

      const producer = await transport.produce({
        kind: msg.kind,
        rtpParameters: msg.rtpParameters,
        appData: {
          source,
          displaySurface: msg.displaySurface || null,
          width: msg.width || null,
          height: msg.height || null,
          startedAt: Date.now(),
        },
      });
      peer.producers.set(producer.id, producer);
      console.log(
        `[meet] peer ${ws.meta.peerId} produced ${producer.kind}/${source}` +
          (source === "screen" ? ` surface=${msg.displaySurface} ${msg.width}x${msg.height}` : "")
      );

      send(ws, { type: "meet-produced", rid: msg.rid, producerId: producer.id });
      notifyDemand(room);

      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === ws.meta.peerId) continue;
        send(otherPeer.ws, {
          type: "meet-new-producer",
          producerId: producer.id,
          peerId: ws.meta.peerId,
          kind: producer.kind,
          source: producer.appData.source,
          displaySurface: producer.appData.displaySurface,
          width: producer.appData.width,
          height: producer.appData.height,
        });
      }
      break;
    }

    // Encoder telemetry from the browser. None of this is visible server-side:
    // the negotiated codec, whether the encoder is hardware, and whether the
    // machine or the network is the limiting factor all live in the client.
    case "meet-stats": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer || !room.ownerUserId) return;
      try {
        recordMediaSample({
          userId: room.ownerUserId,
          roomId: room.id,
          peerId: ws.meta.peerId,
          identity: peer.identity,
          role: peer.canPublish === false ? "viewer" : "publisher",
          source: msg.source,
          codec: msg.codec,
          encoder: msg.encoder,
          hardware: msg.hardware,
          width: msg.width,
          height: msg.height,
          fps: msg.fps,
          kbps: msg.kbps,
          limitedBy: msg.limitedBy,
          framesSent: msg.framesSent,
          framesDropped: msg.framesDropped,
          packetsLost: msg.packetsLost,
          rttMs: msg.rttMs,
          paused: msg.paused,
          watchers: peer.demand ? [...peer.demand.values()].reduce((a, b) => a + b, 0) : 0,
        });
      } catch (err) {
        console.error("[stats] could not record sample:", err.message);
      }
      break;
    }

    // Mic/camera on-off state. A muted mic keeps its producer, so this is the
    // only way a watcher learns the difference between "no device" and "muted".
    case "meet-media-state": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;
      peer.mediaState = {
        mic: Boolean(msg.mic),
        camera: Boolean(msg.camera),
        screen: Boolean(msg.screen),
      };
      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === ws.meta.peerId) continue;
        send(otherPeer.ws, {
          type: "meet-media-state",
          peerId: ws.meta.peerId,
          ...peer.mediaState,
        });
      }
      break;
    }

    case "meet-close-producer": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;
      const producer = peer.producers.get(msg.producerId);
      if (!producer) return;

      producer.close();
      peer.producers.delete(msg.producerId);
      console.log(`[meet] peer ${ws.meta.peerId} closed producer ${msg.producerId}`);

      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === ws.meta.peerId) continue;
        send(otherPeer.ws, {
          type: "meet-producer-closed",
          producerId: msg.producerId,
          peerId: ws.meta.peerId,
        });
      }
      break;
    }

  case "meet-consume": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) {
        send(ws, { type: "error", rid: msg.rid, producerId: msg.producerId, message: "Not in a room" });
        return;
      }

      const canConsume = room.router.canConsume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
      });
      console.log(
        `[meet] peer ${ws.meta.peerId} consume request for producer ${msg.producerId} — canConsume=${canConsume}`
      );
      if (!canConsume) {
        send(ws, { type: "error", rid: msg.rid, producerId: msg.producerId, message: "Cannot consume this producer" });
        return;
      }

      const transport = peer.transports.get(msg.transportId);
      if (!transport) {
        console.log(`[meet] peer ${ws.meta.peerId} consume: no transport ${msg.transportId}`);
        send(ws, { type: "error", rid: msg.rid, producerId: msg.producerId, message: "No such recv transport" });
        return;
      }

      const consumer = await transport.consume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);
      notifyDemand(room);
      console.log(
        `[meet] peer ${ws.meta.peerId} created ${consumer.kind} consumer ${consumer.id} for producer ${msg.producerId}`
      );

       send(ws, {
        type: "meet-consumed",
        rid: msg.rid,
        consumerId: consumer.id,
        producerId: msg.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        source: consumer.producerAppData?.source,
        peerId: producerPeerId(room, msg.producerId),
      });
      break;
    }

    case "meet-resume-consumer": {
      const { peer } = currentMeetPeer(ws);
      if (!peer) return;
      const consumer = peer.consumers.get(msg.consumerId);
      if (consumer) {
        await consumer.resume();
        console.log(`[meet] peer ${ws.meta.peerId} resumed consumer ${msg.consumerId}, paused=${consumer.paused}`);
         if (consumer.kind === "video") {
          // A single PLI is not enough: at resume time the producer's
          // RtpStreamRecv may not exist yet, in which case requestKeyFrame() is
          // a silent no-op. Camera video hides this (motion forces frequent
          // keyframes); a static screen share does not, and stays black
          // forever.
          //
          // Two attempts, not four. Every keyframe is a full intra frame that
          // the sharer's encoder has to produce and that eats the bitrate
          // budget detail would otherwise get — with several watchers the
          // duplicates were costing real CPU and sharpness. The client still
          // asks via meet-request-keyframe if its <video> is genuinely blank.
          for (const delay of [0, 1200]) {
            setTimeout(() => {
              if (!consumer.closed) consumer.requestKeyFrame().catch(() => {});
            }, delay);
          }
        }
      } else {
        console.log(`[meet] peer ${ws.meta.peerId} resume: no consumer ${msg.consumerId}`);
      }
      break;
    }

     case "meet-request-keyframe": {
      const { peer } = currentMeetPeer(ws);
      const consumer = peer?.consumers.get(msg.consumerId);
      if (consumer && consumer.kind === "video" && !consumer.closed) {
        await consumer.requestKeyFrame();
      }
      break;
    }

    case "meet-leave": {
      const room = getMeetRoom(ws.meta.roomId);
      const leaving = room?.peers.get(ws.meta.peerId);
      const bytes = leaving ? await measureTransportBytes(leaving) : {};
      closeUsageSession(ws.meta.usageId, bytes);
      ws.meta.usageId = null;
      if (room && ws.meta.peerId) {
        removePeer(room, ws.meta.peerId);
        for (const peer of room.peers.values()) {
          send(peer.ws, { type: "meet-peer-left", peerId: ws.meta.peerId });
        }
        // Their consumers went with them, so someone may now have no audience.
        notifyDemand(room);
      }
      break;
    }

    default:
      break;
  }
}

function currentMeetPeer(ws) {
  const room = getMeetRoom(ws.meta.roomId);
  const peer = room?.peers.get(ws.meta.peerId);
  return { room, peer };
}

/**
 * Rebuilds the in-memory room for an API-created room that has no live peers.
 *
 * Live rooms are dropped as soon as the last peer leaves (and all of them are
 * lost on restart), which is fine for a one-off call but wrong for a durable
 * room: a watcher who opens the page before anyone joins, or anyone who
 * reconnects, would be told the room does not exist while the API happily
 * reports it. Rooms the customer explicitly ended stay gone.
 */
function rehydrateRoom(roomId) {
  const record = getRoomOwner(roomId);
  if (!record || record.ended_at) return null;
  console.log(`[meet] rehydrating room ${roomId} from the database`);
  return createMeetRoomRecord(roomId, {
    maxParticipants: record.max_participants,
    ownerUserId: record.user_id,
    mode: record.mode || "meeting",
    requireEntireScreen: Boolean(record.require_entire_screen),
  });
}

/**
 * Bytes actually moved by a peer, read from its transports before they close.
 *
 * This is the figure that maps to the hosting bill, and it cannot be inferred
 * from session length: a publisher whose screen nobody watched is paused and
 * costs almost nothing despite being "connected" all day.
 */
async function measureTransportBytes(peer) {
  let bytesSent = 0;
  let bytesReceived = 0;
  for (const transport of peer.transports.values()) {
    try {
      for (const stat of await transport.getStats()) {
        bytesSent += stat.bytesSent || 0;
        bytesReceived += stat.bytesReceived || 0;
      }
    } catch {
      // A transport already closing cannot report; its bytes are simply lost
      // from the total rather than failing the disconnect.
    }
  }
  return { bytesSent, bytesReceived };
}

/**
 * Tells each publisher how many people are actually watching each of its
 * tracks, so it can stop encoding when nobody is.
 *
 * This is the difference between an employee's machine working all day and
 * working only while a manager is looking. A monitoring session is watched for
 * a few minutes out of every hour, but the browser was encoding and uploading
 * continuously regardless — burning CPU on their machine and bandwidth on ours
 * to produce frames nobody received.
 */
function notifyDemand(room) {
  for (const [peerId, peer] of room.peers) {
    for (const producerId of peer.producers.keys()) {
      let watchers = 0;
      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === peerId) continue;
        for (const consumer of otherPeer.consumers.values()) {
          if (consumer.producerId === producerId && !consumer.closed) watchers++;
        }
      }
      if (peer.demand?.get(producerId) === watchers) continue;
      (peer.demand ||= new Map()).set(producerId, watchers);
      send(peer.ws, { type: "meet-producer-demand", producerId, watchers });
    }
  }
}

/** Which peer owns a producer — lets clients attribute a track to a participant. */
function producerPeerId(room, producerId) {
  for (const [peerId, peer] of room.peers) {
    if (peer.producers.has(producerId)) return peerId;
  }
  return null;
}

httpServer.listen(PORT, () => {
  console.log(`Realtime server (signaling + REST) listening on http://localhost:${PORT}`);
  console.log(`Advertising client connect URL: ${PUBLIC_URL}`);
});
