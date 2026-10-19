/**
 * WebSocket relay + WebRTC signaling server.
 *
 * Direct WebRTC data channels are unrestricted. WebSocket fallback only relays
 * registered, validated file chunks; the server retains metadata/counters only,
 * never file payloads.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { RELAY_MAX_FILE_BYTES } from "../shared/relayLimits";
import {
  RelayFileGuard,
  parseRelayChunkFrame,
  type RelayGuardDecision,
  type RelayRejectCode,
} from "./relayFileGuard";

interface Room {
  token: string;
  host: WebSocket | null;
  client: WebSocket | null;
  createdAt: number;
  hostDisconnectedAt: number | null;
  clientDisconnectedAt: number | null;
  wasConnected: boolean;
  /** Per sending direction. These survive the 30-second reconnect window. */
  relayGuards: {
    host: RelayFileGuard;
    client: RelayFileGuard;
  };
}

type Role = "host" | "client";

const rooms = new Map<string, Room>();
const RECONNECT_GRACE_MS = 30_000;

function newRelayGuards(): Room["relayGuards"] {
  return { host: new RelayFileGuard(), client: new RelayFileGuard() };
}

function discardRoom(token: string, room: Room): void {
  room.relayGuards.host.clear();
  room.relayGuards.client.clear();
  rooms.delete(token);
}

function targetFor(room: Room, role: Role): WebSocket | null {
  return role === "host" ? room.client : room.host;
}

function guardFor(room: Room, role: Role): RelayFileGuard {
  return room.relayGuards[role];
}

function sendJson(ws: WebSocket | null, message: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function extractMessageFileId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as {
    fileId?: unknown;
    id?: unknown;
    meta?: { id?: unknown };
  };
  const id = value.fileId ?? value.id ?? value.meta?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function binaryToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

// Clean stale rooms and bounded, in-memory relay metadata every 30 seconds.
setInterval(() => {
  const now = Date.now();
  for (const [token, room] of Array.from(rooms.entries())) {
    room.relayGuards.host.cleanup(now);
    room.relayGuards.client.cleanup(now);

    if (now - room.createdAt > 30 * 60 * 1000) {
      if (room.host?.readyState === WebSocket.OPEN) room.host.close();
      if (room.client?.readyState === WebSocket.OPEN) room.client.close();
      discardRoom(token, room);
      continue;
    }

    const hostGone =
      !room.host &&
      room.hostDisconnectedAt &&
      now - room.hostDisconnectedAt > RECONNECT_GRACE_MS;
    const clientGone =
      !room.client &&
      room.clientDisconnectedAt &&
      now - room.clientDisconnectedAt > RECONNECT_GRACE_MS;

    if (hostGone && !room.client) {
      discardRoom(token, room);
      continue;
    }
    if (clientGone && !room.host) {
      discardRoom(token, room);
      continue;
    }

    if (hostGone && room.client?.readyState === WebSocket.OPEN) {
      room.client.send(
        JSON.stringify({ type: "peer-disconnected", permanent: true })
      );
      room.client.close();
      discardRoom(token, room);
      continue;
    }

    if (clientGone && room.host?.readyState === WebSocket.OPEN) {
      room.clientDisconnectedAt = null;
      room.wasConnected = false;
      room.host.send(
        JSON.stringify({ type: "peer-disconnected", permanent: true })
      );
    }
  }
}, 30_000);

export function setupSignalingServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/ws-signaling") {
      wss.handleUpgrade(request, socket, head, ws =>
        wss.emit("connection", ws, request)
      );
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let currentToken: string | null = null;
    let currentRole: Role | null = null;
    // Prevent a malicious stream of identical rejected chunks from producing a
    // corresponding stream of JSON errors. It contains IDs only, never bytes.
    const notifiedRejections = new Set<string>();

    const getCurrentRoom = (): Room | null =>
      currentToken ? (rooms.get(currentToken) ?? null) : null;

    const notifyRejection = (
      room: Room,
      role: Role,
      decision: RelayGuardDecision,
      fallbackId?: string
    ) => {
      const fileId = decision.fileId ?? fallbackId;
      if (!fileId || notifiedRejections.has(fileId)) return;
      notifiedRejections.add(fileId);
      if (notifiedRejections.size > 128) notifiedRejections.clear();
      const message = {
        type: "file-rejected",
        fileId,
        code: decision.code ?? "RELAY_FILE_INVALID",
        maxBytes: decision.maxBytes ?? RELAY_MAX_FILE_BYTES,
      };
      // Both sides remove partial state. The originating socket is included so
      // it stops its local fallback attempt without using a connection error.
      sendJson(ws, message);
      sendJson(targetFor(room, role), message);
    };

    const rejectIfNeeded = (
      room: Room,
      role: Role,
      decision: RelayGuardDecision,
      fallbackId?: string
    ): boolean => {
      if (decision.ok) return false;
      notifyRejection(room, role, decision, fallbackId);
      return true;
    };

    ws.on(
      "message",
      (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        try {
          if (isBinary) {
            if (!currentRole) return;
            const room = getCurrentRoom();
            if (!room) return;
            const buffer = binaryToBuffer(data);
            const chunk = parseRelayChunkFrame(buffer);
            if (!chunk) return;
            const decision = guardFor(room, currentRole).acceptChunk(
              chunk.fileId,
              chunk.index,
              chunk.payload
            );
            if (rejectIfNeeded(room, currentRole, decision, chunk.fileId))
              return;
            const target = targetFor(room, currentRole);
            if (target?.readyState === WebSocket.OPEN)
              target.send(buffer, { binary: true });
            return;
          }

          const msg = JSON.parse(data.toString()) as {
            type?: unknown;
            [key: string]: unknown;
          };
          if (typeof msg.type !== "string") {
            sendJson(ws, { type: "error", message: "Invalid message format" });
            return;
          }

          switch (msg.type) {
            case "register": {
              const token = msg.token;
              if (typeof token !== "string" || token.length !== 4) {
                sendJson(ws, { type: "error", message: "Invalid token" });
                return;
              }

              if (rooms.has(token)) {
                const existing = rooms.get(token)!;
                if (existing.hostDisconnectedAt && !existing.host) {
                  existing.host = ws;
                  existing.hostDisconnectedAt = null;
                  currentToken = token;
                  currentRole = "host";
                  sendJson(ws, { type: "registered", token });
                  if (existing.client?.readyState === WebSocket.OPEN) {
                    sendJson(existing.client, {
                      type: "peer-reconnected",
                      role: "host",
                    });
                    sendJson(ws, { type: "connected", reconnected: true });
                    existing.wasConnected = true;
                  }
                  return;
                }
                if (existing.host?.readyState === WebSocket.OPEN)
                  existing.host.close();
                if (existing.client?.readyState === WebSocket.OPEN)
                  existing.client.close();
                discardRoom(token, existing);
              }

              rooms.set(token, {
                token,
                host: ws,
                client: null,
                createdAt: Date.now(),
                hostDisconnectedAt: null,
                clientDisconnectedAt: null,
                wasConnected: false,
                relayGuards: newRelayGuards(),
              });
              currentToken = token;
              currentRole = "host";
              sendJson(ws, { type: "registered", token });
              break;
            }

            case "join": {
              const token = msg.token;
              if (typeof token !== "string") {
                sendJson(ws, {
                  type: "error",
                  message: "No host found with this token",
                });
                return;
              }
              const room = rooms.get(token);
              if (
                !room ||
                !room.host ||
                room.host.readyState !== WebSocket.OPEN
              ) {
                sendJson(ws, {
                  type: "error",
                  message: "No host found with this token",
                });
                return;
              }
              if (room.client && room.client.readyState === WebSocket.OPEN) {
                sendJson(ws, {
                  type: "error",
                  message: "Room is already full",
                });
                return;
              }
              room.client = ws;
              room.clientDisconnectedAt = null;
              currentToken = token;
              currentRole = "client";
              room.wasConnected = true;
              sendJson(room.host, { type: "connected" });
              sendJson(ws, { type: "connected" });
              break;
            }

            case "rejoin": {
              const token = msg.token;
              const role = msg.role;
              if (typeof token !== "string") {
                sendJson(ws, {
                  type: "error",
                  message: "Room expired. Please reconnect.",
                });
                return;
              }
              const room = rooms.get(token);
              if (!room) {
                sendJson(ws, {
                  type: "error",
                  message: "Room expired. Please reconnect.",
                });
                return;
              }
              if (role === "client") {
                if (room.client && room.client.readyState === WebSocket.OPEN) {
                  sendJson(ws, {
                    type: "error",
                    message: "Room is already full",
                  });
                  return;
                }
                room.client = ws;
                room.clientDisconnectedAt = null;
                currentToken = token;
                currentRole = "client";
                sendJson(ws, { type: "rejoined", token });
                if (room.host?.readyState === WebSocket.OPEN) {
                  sendJson(room.host, {
                    type: "peer-reconnected",
                    role: "client",
                  });
                  sendJson(ws, { type: "connected", reconnected: true });
                }
              } else if (role === "host") {
                if (room.host && room.host.readyState === WebSocket.OPEN) {
                  sendJson(ws, {
                    type: "error",
                    message: "Host slot is occupied",
                  });
                  return;
                }
                room.host = ws;
                room.hostDisconnectedAt = null;
                currentToken = token;
                currentRole = "host";
                sendJson(ws, { type: "rejoined", token });
                if (room.client?.readyState === WebSocket.OPEN) {
                  sendJson(room.client, {
                    type: "peer-reconnected",
                    role: "host",
                  });
                  sendJson(ws, { type: "connected", reconnected: true });
                }
              } else {
                sendJson(ws, { type: "error", message: "Invalid role" });
              }
              break;
            }

            case "rtc-offer":
            case "rtc-answer":
            case "rtc-ice": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              if (!room) return;
              sendJson(targetFor(room, currentRole), msg);
              break;
            }

            // Registering only records in-memory eligibility. Oversize ordinary
            // files receive no response here because they may still use direct P2P.
            case "relay-register": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              if (!room) return;
              // Deliberately silent even for invalid/oversize candidates: direct
              // P2P is unrestricted and this message is only an eligibility hint.
              guardFor(room, currentRole).register(msg.meta);
              break;
            }

            // Legacy fallback metadata is also registration, but only eligible
            // (ordinary <= limit or valid image) metadata reaches the peer.
            case "file-meta": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              if (!room) return;
              const decision = guardFor(room, currentRole).allowLegacyMeta(
                msg.meta
              );
              if (
                rejectIfNeeded(
                  room,
                  currentRole,
                  decision,
                  extractMessageFileId(msg)
                )
              )
                return;
              sendJson(targetFor(room, currentRole), msg);
              break;
            }

            // Text has no relay-file quota and does not depend on file metadata.
            case "text": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              if (room) sendJson(targetFor(room, currentRole), msg);
              break;
            }

            case "file-complete":
            case "file-ack":
            case "chunk-request": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              if (!room) return;
              const fileId =
                msg.type === "file-ack"
                  ? msg.fileId
                  : msg.type === "chunk-request"
                    ? msg.fileId
                    : msg.id;
              // Completion travels in the sender's direction, whereas acknowledgements
              // and retransmit requests travel back to the original sender.
              const fileDirection: Role =
                msg.type === "file-complete"
                  ? currentRole
                  : currentRole === "host"
                    ? "client"
                    : "host";
              const decision = guardFor(room, fileDirection).allowControl(
                fileId
              );
              if (
                rejectIfNeeded(
                  room,
                  currentRole,
                  decision,
                  extractMessageFileId(msg)
                )
              )
                return;
              sendJson(targetFor(room, currentRole), msg);
              break;
            }

            case "file-cancel": {
              if (!currentRole) return;
              const room = getCurrentRoom();
              const fileId = msg.fileId;
              if (!room || typeof fileId !== "string" || !fileId) return;
              // Either sender or receiver may cancel. UUIDs are scoped to the
              // room, so mark both direction maps to stop all future chunks.
              room.relayGuards.host.cancel(fileId);
              room.relayGuards.client.cancel(fileId);
              const code =
                msg.code === "RELAY_FILE_TOO_LARGE" ||
                msg.code === "RELAY_FILE_INVALID"
                  ? msg.code
                  : undefined;
              const maxBytes =
                typeof msg.maxBytes === "number" &&
                Number.isFinite(msg.maxBytes)
                  ? msg.maxBytes
                  : undefined;
              sendJson(targetFor(room, currentRole), {
                type: "file-cancel",
                fileId,
                ...(code ? { code } : {}),
                ...(maxBytes !== undefined ? { maxBytes } : {}),
              });
              break;
            }

            // Rejections are server-generated and are deliberately not relayed
            // again, preventing client/server error echo loops.
            case "file-rejected":
              break;

            case "ping":
              sendJson(ws, { type: "pong" });
              break;

            default:
              sendJson(ws, { type: "error", message: "Unknown message type" });
          }
        } catch (err) {
          console.error("[Relay] Error processing message:", err);
          sendJson(ws, { type: "error", message: "Invalid message format" });
        }
      }
    );

    ws.on("close", () => {
      if (!currentToken) return;
      const room = rooms.get(currentToken);
      if (!room) return;
      if (currentRole === "host") {
        room.host = null;
        room.hostDisconnectedAt = Date.now();
        if (room.client?.readyState === WebSocket.OPEN && room.wasConnected) {
          sendJson(room.client, {
            type: "peer-disconnected",
            permanent: false,
          });
        }
        if (!room.wasConnected && !room.client) discardRoom(currentToken, room);
      } else if (currentRole === "client") {
        room.client = null;
        room.clientDisconnectedAt = Date.now();
        if (room.host?.readyState === WebSocket.OPEN) {
          sendJson(room.host, { type: "peer-disconnected", permanent: false });
        }
      }
    });

    ws.on("error", err => console.error("[Relay] WebSocket error:", err));
  });

  console.log(
    "[Relay] Hybrid WebSocket relay + WebRTC signaling server ready on /api/ws-signaling"
  );
}
