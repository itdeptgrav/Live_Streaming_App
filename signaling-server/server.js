import http from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import { isKnownRoom, MAX_VIEWERS_PER_ROOM, ROOMS } from "./rooms.js";
import {
  generateRoomId,
  createMeetRoomRecord,
  getMeetRoom,
  meetRoomInfo,
  ensureRouter,
  roomIsFull,
  createWebRtcTransport,
  removePeer,
} from "./meetRooms.js";

const PORT = process.env.PORT || 4000;
// Comma-separated list, e.g. "https://your-app.vercel.app,http://localhost:3000"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",");

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

// ---- plain HTTP: REST for Meet room creation/lookup ----
const httpServer = http.createServer(async (req, res) => {
  const origin = corsOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/meet-rooms") {
    const roomId = generateRoomId();
    createMeetRoomRecord(roomId);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ roomId }));
    return;
  }

  const infoMatch = req.method === "GET" && req.url.match(/^\/api\/meet-rooms\/([\w-]+)$/);
  if (infoMatch) {
    const info = meetRoomInfo(infoMatch[1]);
    res.writeHead(info ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(info || { error: "not found" }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  ws.meta = { mode: null, role: null, roomId: null, viewerId: null, peerId: null };

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
      send(ws, { type: "error", message: `Server error handling ${msg.type}: ${err.message}` });
    }
  });

  ws.on("close", () => {
    if (ws.meta.mode === "meet") {
      const room = getMeetRoom(ws.meta.roomId);
      if (room && ws.meta.peerId) {
        removePeer(room, ws.meta.peerId);
        for (const peer of room.peers.values()) {
          send(peer.ws, { type: "meet-peer-left", peerId: ws.meta.peerId });
        }
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
      const room = getMeetRoom(msg.roomId);
      if (!room) {
        send(ws, { type: "error", message: "Room does not exist" });
        return;
      }
      if (roomIsFull(room)) {
        send(ws, { type: "error", message: "Room is full" });
        return;
      }

      const router = await ensureRouter(room);
      const peerId = randomUUID();
      room.peers.set(peerId, {
        ws,
        displayName: msg.displayName || "Guest",
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      });

      ws.meta.mode = "meet";
      ws.meta.roomId = msg.roomId;
      ws.meta.peerId = peerId;

      const existingProducers = [];
      for (const [otherId, peer] of room.peers) {
        if (otherId === peerId) continue;
        for (const producer of peer.producers.values()) {
          existingProducers.push({ producerId: producer.id, peerId: otherId, kind: producer.kind });
        }
      }

      send(ws, {
        type: "meet-joined",
        peerId,
        rtpCapabilities: router.rtpCapabilities,
        existingProducers,
      });
      break;
    }

    case "meet-create-transport": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;

      const transport = await createWebRtcTransport(room.router);
      peer.transports.set(transport.id, transport);

      send(ws, {
        type: "meet-transport-created",
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
      send(ws, { type: "meet-transport-connected", transportId: msg.transportId });
      break;
    }

    case "meet-produce": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;
      const transport = peer.transports.get(msg.transportId);
      if (!transport) return;

      const producer = await transport.produce({
        kind: msg.kind,
        rtpParameters: msg.rtpParameters,
      });
      peer.producers.set(producer.id, producer);
      console.log(`[meet] peer ${ws.meta.peerId} produced ${producer.kind} producer ${producer.id}`);

      send(ws, { type: "meet-produced", producerId: producer.id });

      for (const [otherId, otherPeer] of room.peers) {
        if (otherId === ws.meta.peerId) continue;
        send(otherPeer.ws, {
          type: "meet-new-producer",
          producerId: producer.id,
          peerId: ws.meta.peerId,
          kind: producer.kind,
        });
      }
      break;
    }

    case "meet-consume": {
      const { room, peer } = currentMeetPeer(ws);
      if (!room || !peer) return;

      const canConsume = room.router.canConsume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
      });
      console.log(
        `[meet] peer ${ws.meta.peerId} consume request for producer ${msg.producerId} — canConsume=${canConsume}`
      );
      if (!canConsume) {
        send(ws, { type: "error", producerId: msg.producerId, message: "Cannot consume this producer" });
        return;
      }

      const transport = peer.transports.get(msg.transportId);
      if (!transport) {
        console.log(`[meet] peer ${ws.meta.peerId} consume: no transport ${msg.transportId}`);
        send(ws, { type: "error", producerId: msg.producerId, message: "No such recv transport" });
        return;
      }

      const consumer = await transport.consume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);
      console.log(
        `[meet] peer ${ws.meta.peerId} created ${consumer.kind} consumer ${consumer.id} for producer ${msg.producerId}`
      );

      send(ws, {
        type: "meet-consumed",
        consumerId: consumer.id,
        producerId: msg.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
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
          // A consumer created paused (as ours are) may only start receiving
          // delta frames once resumed, with no keyframe to decode from — VP8
          // can't decode without one. Explicitly request a fresh keyframe from
          // the producer so this viewer's decoder has somewhere to start.
          await consumer.requestKeyFrame();
          console.log(`[meet] peer ${ws.meta.peerId} requested keyframe for consumer ${msg.consumerId}`);
        }
      } else {
        console.log(`[meet] peer ${ws.meta.peerId} resume: no consumer ${msg.consumerId}`);
      }
      break;
    }

    case "meet-leave": {
      const room = getMeetRoom(ws.meta.roomId);
      if (room && ws.meta.peerId) {
        removePeer(room, ws.meta.peerId);
        for (const peer of room.peers.values()) {
          send(peer.ws, { type: "meet-peer-left", peerId: ws.meta.peerId });
        }
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

httpServer.listen(PORT, () => {
  console.log(`Realtime server (signaling + REST) listening on http://localhost:${PORT}`);
});
