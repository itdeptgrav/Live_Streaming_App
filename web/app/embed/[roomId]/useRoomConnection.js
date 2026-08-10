"use client";

// The transport layer of the embed: WebSocket signaling + mediasoup.
//
// Split out from the UI because the two have very different reasons to change
// — the media plumbing is protocol-driven and hard-won (the keyframe nudging
// below took real debugging), while the interface above it is product-driven
// and now differs per role.

import { useCallback, useEffect, useRef, useState } from "react";
import { Device } from "mediasoup-client";
import { SIGNALING_URL } from "@/lib/realtime";
import { getIceServers } from "@/lib/webrtcConfig";

export function useRoomConnection({ roomId, token, onEvent }) {
  const [phase, setPhase] = useState("idle"); // idle | connecting | live | ended
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null); // server-confirmed role/mode
  const [peers, setPeers] = useState([]);
  const [videoTracks, setVideoTracks] = useState([]);
  const [audioTracks, setAudioTracks] = useState([]);

  const wsRef = useRef(null);
  const deviceRef = useRef(null);
  const iceServersRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);

  const remoteVideosRef = useRef(new Map());
  const remoteAudiosRef = useRef(new Map());
  const peersRef = useRef(new Map());

  const consumeQueueRef = useRef(Promise.resolve());
  const pendingRef = useRef(new Map());
  const ridRef = useRef(0);

  const emit = useRef(onEvent);
  useEffect(() => {
    emit.current = onEvent;
  }, [onEvent]);

  // ---------------- signaling primitives ----------------

  const send = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  /** Sends a message and resolves with the reply carrying the same rid. */
  const request = useCallback(
    (msg, { timeoutMs = 15000 } = {}) => {
      const rid = `r${++ridRef.current}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(rid);
          reject(new Error(`${msg.type} timed out`));
        }, timeoutMs);

        const settle = (fn) => (value) => {
          clearTimeout(timer);
          pendingRef.current.delete(rid);
          fn(value);
        };
        pendingRef.current.set(rid, { resolve: settle(resolve), reject: settle(reject) });
        send({ ...msg, rid });
      });
    },
    [send]
  );

  // ---------------- remote track bookkeeping ----------------

  const syncTracks = useCallback(() => {
    setVideoTracks(
      [...remoteVideosRef.current.entries()].map(([producerId, v]) => ({ producerId, ...v }))
    );
    setAudioTracks(
      [...remoteAudiosRef.current.entries()].map(([producerId, a]) => ({ producerId, ...a }))
    );
  }, []);

  const syncPeers = useCallback(() => setPeers([...peersRef.current.values()]), []);

  const removeProducer = useCallback(
    (producerId) => {
      for (const map of [remoteVideosRef.current, remoteAudiosRef.current]) {
        const entry = map.get(producerId);
        if (!entry) continue;
        try {
          entry.consumer.close();
        } catch {}
        map.delete(producerId);
      }
      syncTracks();
    },
    [syncTracks]
  );

  const removePeer = useCallback(
    (peerId) => {
      for (const map of [remoteVideosRef.current, remoteAudiosRef.current]) {
        for (const [producerId, entry] of map) {
          if (entry.peerId !== peerId) continue;
          try {
            entry.consumer.close();
          } catch {}
          map.delete(producerId);
        }
      }
      peersRef.current.delete(peerId);
      syncPeers();
      syncTracks();
    },
    [syncPeers, syncTracks]
  );

  // Consumes are serialized: two overlapping consumes on one transport can
  // race during renegotiation and leave a track that never decodes.
  const consumeProducer = useCallback(
    (info) => {
      const run = async () => {
        if (!recvTransportRef.current || !deviceRef.current) return;
        let reply;
        try {
          reply = await request({
            type: "meet-consume",
            transportId: recvTransportRef.current.id,
            producerId: info.producerId,
            rtpCapabilities: deviceRef.current.rtpCapabilities,
          });
        } catch (err) {
          console.error(`[consume] ${info.producerId} failed:`, err.message);
          return;
        }

        const consumer = await recvTransportRef.current.consume({
          id: reply.consumerId,
          producerId: info.producerId,
          kind: reply.kind,
          rtpParameters: reply.rtpParameters,
        });
        send({ type: "meet-resume-consumer", consumerId: reply.consumerId });

        // One MediaStream per track, never mutated — mutating a live stream is
        // what produced permanently black 0x0 tiles.
        const entry = {
          peerId: info.peerId || reply.peerId,
          source: info.source || reply.source || (reply.kind === "audio" ? "mic" : "camera"),
          displaySurface: info.displaySurface || null,
          width: info.width || null,
          height: info.height || null,
          stream: new MediaStream([consumer.track]),
          consumerId: consumer.id,
          consumer,
        };
        if (consumer.kind === "video") remoteVideosRef.current.set(info.producerId, entry);
        else remoteAudiosRef.current.set(info.producerId, entry);
        syncTracks();
      };
      consumeQueueRef.current = consumeQueueRef.current.then(run, run);
      return consumeQueueRef.current;
    },
    [request, send, syncTracks]
  );

  // ---------------- transports ----------------

  const createTransport = useCallback(
    async (direction) => {
      const info = await request({ type: "meet-create-transport", direction });
      const factory =
        direction === "send"
          ? deviceRef.current.createSendTransport
          : deviceRef.current.createRecvTransport;

      const transport = factory.call(deviceRef.current, {
        id: info.transportId,
        iceParameters: info.iceParameters,
        iceCandidates: info.iceCandidates,
        dtlsParameters: info.dtlsParameters,
        iceServers: iceServersRef.current,
      });

      transport.on("connect", ({ dtlsParameters }, callback, errback) => {
        request({ type: "meet-connect-transport", transportId: transport.id, dtlsParameters })
          .then(() => callback())
          .catch(errback);
      });

      if (direction === "send") {
        // appData rides along to the server so it can enforce the screen-surface
        // policy and expose what each participant is sharing over the REST API.
        transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
          request({
            type: "meet-produce",
            transportId: transport.id,
            kind,
            rtpParameters,
            source: appData?.source,
            displaySurface: appData?.displaySurface,
            width: appData?.width,
            height: appData?.height,
          })
            .then((reply) => callback({ id: reply.producerId }))
            .catch(errback);
        });
      }
      return transport;
    },
    [request]
  );

  // ---------------- connect ----------------

  const connect = useCallback(
    ({ needsSendTransport }) =>
      new Promise((resolve, reject) => {
        setPhase("connecting");
        setError(null);

        getIceServers()
          .then((ice) => {
            iceServersRef.current = ice;
            const ws = new WebSocket(SIGNALING_URL);
            wsRef.current = ws;

            ws.onopen = () => send({ type: "meet-join", roomId, token });
            ws.onerror = () => {
              const message = "Could not reach the streaming server.";
              setError(message);
              emit.current?.("error", { message, code: "SERVER_UNREACHABLE" });
              reject(new Error(message));
            };
            ws.onclose = () => {
              for (const [, p] of pendingRef.current) p.reject(new Error("connection closed"));
              pendingRef.current.clear();
            };

            ws.onmessage = async (event) => {
              const msg = JSON.parse(event.data);

              if (msg.rid && pendingRef.current.has(msg.rid)) {
                const pending = pendingRef.current.get(msg.rid);
                if (msg.type === "error") {
                  const err = new Error(msg.message);
                  err.code = msg.code;
                  pending.reject(err);
                } else pending.resolve(msg);
                return;
              }

              switch (msg.type) {
                case "meet-joined": {
                  try {
                    const device = new Device();
                    await device.load({ routerRtpCapabilities: msg.rtpCapabilities });
                    deviceRef.current = device;

                    for (const p of msg.existingPeers || []) peersRef.current.set(p.peerId, p);
                    syncPeers();

                    recvTransportRef.current = await createTransport("recv");
                    // A viewer never publishes, so it never pays for a send
                    // transport — that is also why it needs no camera or mic.
                    if (needsSendTransport) {
                      sendTransportRef.current = await createTransport("send");
                    }

                    for (const p of msg.existingProducers || []) consumeProducer(p);

                    setSession({
                      peerId: msg.peerId,
                      identity: msg.identity,
                      name: msg.displayName,
                      role: msg.role,
                      canPublish: msg.canPublish,
                      mode: msg.mode,
                      requireEntireScreen: msg.requireEntireScreen,
                    });
                    setPhase("live");
                    emit.current?.("joined", {
                      peerId: msg.peerId,
                      identity: msg.identity,
                      role: msg.role,
                      mode: msg.mode,
                    });
                    resolve(msg);
                  } catch (err) {
                    setError(err.message);
                    emit.current?.("error", { message: err.message });
                    setPhase("idle");
                    reject(err);
                  }
                  break;
                }

                case "meet-peer-joined":
                  peersRef.current.set(msg.peerId, {
                    peerId: msg.peerId,
                    identity: msg.identity,
                    name: msg.name,
                    role: msg.role,
                    media: { mic: false, camera: false, screen: false },
                  });
                  syncPeers();
                  emit.current?.("participant-joined", { identity: msg.identity, name: msg.name });
                  break;

                case "meet-media-state": {
                  const peer = peersRef.current.get(msg.peerId);
                  if (peer) {
                    peer.media = { mic: msg.mic, camera: msg.camera, screen: msg.screen };
                    syncPeers();
                  }
                  break;
                }

                case "meet-new-producer":
                  consumeProducer(msg);
                  if (msg.source === "screen") {
                    emit.current?.("remote-screen-started", {
                      peerId: msg.peerId,
                      displaySurface: msg.displaySurface,
                      width: msg.width,
                      height: msg.height,
                    });
                  }
                  break;

                case "meet-producer-closed":
                  removeProducer(msg.producerId);
                  break;

                case "meet-peer-left":
                  removePeer(msg.peerId);
                  emit.current?.("participant-left", { peerId: msg.peerId });
                  break;

                case "error":
                  setError(msg.message);
                  emit.current?.("error", { message: msg.message, code: msg.code });
                  break;

                default:
                  break;
              }
            };
          })
          .catch(reject);
      }),
    [roomId, token, send, createTransport, consumeProducer, removeProducer, removePeer, syncPeers]
  );

  const publish = useCallback(async ({ track, source, displaySurface, width, height, encodings, codecOptions }) => {
    if (!sendTransportRef.current) throw new Error("This session cannot publish");
    return sendTransportRef.current.produce({
      track,
      stopTracks: source !== "screen",
      encodings,
      codecOptions,
      appData: { source, displaySurface, width, height },
    });
  }, []);

  const unpublish = useCallback(
    (producer) => {
      if (!producer) return;
      send({ type: "meet-close-producer", producerId: producer.id });
      try {
        producer.close();
      } catch {}
    },
    [send]
  );

  const reportMediaState = useCallback(
    (state) => send({ type: "meet-media-state", ...state }),
    [send]
  );

  const requestKeyFrame = useCallback((consumerId) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "meet-request-keyframe", consumerId }));
    }
  }, []);

  const disconnect = useCallback(() => {
    // No socket means there is nothing to tear down, and moving to "ended"
    // would be wrong. StrictMode runs this cleanup once before the real mount,
    // which otherwise left publishers stranded on "Session ended" before they
    // had connected at all.
    if (!wsRef.current) return;

    send({ type: "meet-leave" });
    wsRef.current.close();
    wsRef.current = null;
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();
    sendTransportRef.current = null;
    recvTransportRef.current = null;
    remoteVideosRef.current.clear();
    remoteAudiosRef.current.clear();
    peersRef.current.clear();
    setVideoTracks([]);
    setAudioTracks([]);
    setPeers([]);
    setPhase("ended");
  }, [send]);

  // Teardown on unmount only — never on a dependency change, which would hang
  // up a live session.
  const disconnectRef = useRef(disconnect);
  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);
  useEffect(() => () => disconnectRef.current(), []);

  return {
    phase,
    error,
    setError,
    session,
    peers,
    videoTracks,
    audioTracks,
    connect,
    publish,
    unpublish,
    reportMediaState,
    requestKeyFrame,
    disconnect,
  };
}
