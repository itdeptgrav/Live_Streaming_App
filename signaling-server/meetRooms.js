import "./mediasoupBootstrap.js";
import { randomUUID } from "crypto";
import * as mediasoup from "mediasoup";
import {
  getWorkerSettings,
  routerMediaCodecs,
  getWebRtcTransportOptions,
  MAX_MEET_PARTICIPANTS,
} from "./mediasoupConfig.js";

let worker;

async function getWorker() {
  if (!worker) {
    worker = await mediasoup.createWorker(getWorkerSettings());
    worker.on("died", () => {
      console.error("mediasoup worker died, exiting so the process manager restarts us");
      process.exit(1);
    });
  }
  return worker;
}

// roomId -> { id, createdAt, router, peers: Map<peerId, Peer> }
// Peer: { ws, displayName, transports: Map<transportId, Transport>, producers: Map<producerId, Producer>, consumers: Map<consumerId, Consumer> }
const meetRooms = new Map();

export function generateRoomId() {
  return randomUUID().slice(0, 8);
}

// How long an empty room survives before its router is torn down. Without a
// grace period, creating a room and sharing the link then closing your own tab
// destroys the room before your invitees can arrive.
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS || 30 * 60 * 1000);

export function createMeetRoomRecord(roomId) {
  meetRooms.set(roomId, {
    id: roomId,
    createdAt: Date.now(),
    router: null,
    peers: new Map(),
    reapTimer: null,
  });
  return meetRooms.get(roomId);
}

// Call whenever someone joins, so a pending teardown is aborted.
export function cancelReap(room) {
  if (room?.reapTimer) {
    clearTimeout(room.reapTimer);
    room.reapTimer = null;
  }
}

export function getMeetRoom(roomId) {
  return meetRooms.get(roomId);
}

export function meetRoomInfo(roomId) {
  const room = meetRooms.get(roomId);
  if (!room) return null;
  return { id: room.id, participantCount: room.peers.size };
}

export async function ensureRouter(room) {
  if (!room.router) {
    const w = await getWorker();
    room.router = await w.createRouter({ mediaCodecs: routerMediaCodecs });
  }
  return room.router;
}

export function roomIsFull(room) {
  return room.peers.size >= MAX_MEET_PARTICIPANTS;
}

export async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport(getWebRtcTransportOptions());

  console.log(
    `[transport ${transport.id}] candidates:`,
    transport.iceCandidates.map((c) => `${c.protocol}://${c.address ?? c.ip}:${c.port}`).join(", ")
  );
  transport.on("icestatechange", (state) =>
    console.log(`[transport ${transport.id}] ICE -> ${state}`)
  );
  transport.on("dtlsstatechange", (state) =>
    console.log(`[transport ${transport.id}] DTLS -> ${state}`)
  );

  return transport;
}
export function removePeer(room, peerId) {
  const peer = room.peers.get(peerId);
  if (!peer) return;
  peer.transports.forEach((t) => t.close());
  peer.consumers.forEach((c) => c.close());
  peer.producers.forEach((p) => p.close());
  room.peers.delete(peerId);

  if (room.peers.size === 0) {
    clearTimeout(room.reapTimer);
    room.reapTimer = setTimeout(() => {
      if (room.peers.size > 0) return;
      room.router?.close();
      meetRooms.delete(room.id);
      console.log(`[meet] room ${room.id} reaped after being empty for ${EMPTY_ROOM_TTL_MS}ms`);
    }, EMPTY_ROOM_TTL_MS);
  }
}

export function roomCount() {
  return meetRooms.size;
}
