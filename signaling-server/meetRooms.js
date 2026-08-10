import "./mediasoupBootstrap.js";
import { randomUUID } from "crypto";
import * as mediasoup from "mediasoup";
import {
  workerSettings,
  routerMediaCodecs,
  webRtcTransportOptions,
  MAX_MEET_PARTICIPANTS,
} from "./mediasoupConfig.js";

let worker;

async function getWorker() {
  if (!worker) {
    worker = await mediasoup.createWorker(workerSettings);
    worker.on("died", () => {
      console.error("mediasoup worker died, exiting so the process manager restarts us");
      process.exit(1);
    });
  }
  return worker;
}

// roomId -> { id, createdAt, router, peers: Map<peerId, Peer>, maxParticipants, ownerUserId }
// Peer: { ws, identity, displayName, transports: Map<transportId, Transport>, producers: Map<producerId, Producer>, consumers: Map<consumerId, Consumer> }
//
// ownerUserId is null for legacy/demo rooms created without an API key. Rooms
// with an owner require a signed room token to join and accrue usage against
// that account; ownerless rooms keep the original open behaviour.
const meetRooms = new Map();

export function generateRoomId() {
  return randomUUID().slice(0, 8);
}

export function createMeetRoomRecord(
  roomId,
  { maxParticipants, ownerUserId = null, mode = "meeting", requireEntireScreen = false } = {}
) {
  meetRooms.set(roomId, {
    id: roomId,
    createdAt: Date.now(),
    router: null,
    peers: new Map(),
    maxParticipants: maxParticipants || MAX_MEET_PARTICIPANTS,
    ownerUserId,
    mode,
    requireEntireScreen,
  });
  return meetRooms.get(roomId);
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
  return room.peers.size >= (room.maxParticipants || MAX_MEET_PARTICIPANTS);
}

export async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport(webRtcTransportOptions);

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
    room.router?.close();
    meetRooms.delete(room.id);
  }
}

/**
 * Force-ends a room: closes every peer's transports and drops the router.
 * Callers are responsible for notifying peers over the socket first — this
 * only tears down the media side.
 */
export function closeMeetRoom(roomId) {
  const room = meetRooms.get(roomId);
  if (!room) return false;
  for (const peer of room.peers.values()) {
    peer.transports.forEach((t) => t.close());
    peer.consumers.forEach((c) => c.close());
    peer.producers.forEach((p) => p.close());
  }
  room.peers.clear();
  room.router?.close();
  meetRooms.delete(roomId);
  return true;
}
