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

// roomId -> { id, createdAt, router, peers: Map<peerId, Peer> }
// Peer: { ws, displayName, transports: Map<transportId, Transport>, producers: Map<producerId, Producer>, consumers: Map<consumerId, Consumer> }
const meetRooms = new Map();

export function generateRoomId() {
  return randomUUID().slice(0, 8);
}

export function createMeetRoomRecord(roomId) {
  meetRooms.set(roomId, {
    id: roomId,
    createdAt: Date.now(),
    router: null,
    peers: new Map(),
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
  return room.peers.size >= MAX_MEET_PARTICIPANTS;
}

export async function createWebRtcTransport(router) {
  const transport = await router.createWebRtcTransport(webRtcTransportOptions);
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
