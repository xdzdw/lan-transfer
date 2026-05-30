/**
 * WebSocket Relay + Signaling Server for Quick Transfer
 * 
 * Hybrid approach:
 * 1. WebSocket always used for signaling (register, join, connected)
 * 2. After connection, peers attempt WebRTC P2P via SDP/ICE exchange
 * 3. If WebRTC succeeds → data flows P2P (fast, local network)
 * 4. If WebRTC fails → data flows through WebSocket relay (fallback)
 * 
 * Reconnection support:
 * - When a peer disconnects, room is preserved for 30 seconds
 * - Peer can rejoin with same token and role to resume session
 * - Other peer is notified of disconnect/reconnect events
 * 
 * Message types:
 * - register/join/rejoin/connected/peer-disconnected/peer-reconnected: room management
 * - rtc-offer/rtc-answer/rtc-ice: WebRTC signaling (relayed to peer)
 * - text/file-meta/file-complete/binary: data transfer (relay fallback)
 * - ping/pong: keep-alive
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

interface Room {
  token: string;
  host: WebSocket | null;
  client: WebSocket | null;
  createdAt: number;
  /** Set when a peer disconnects — room is kept alive for reconnection */
  hostDisconnectedAt: number | null;
  clientDisconnectedAt: number | null;
  /** Track if both peers were previously connected (for reconnection logic) */
  wasConnected: boolean;
}

const rooms = new Map<string, Room>();

// Grace period for reconnection (30 seconds)
const RECONNECT_GRACE_MS = 30_000;

// Clean up stale rooms every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, room] of Array.from(rooms.entries())) {
    // Remove rooms older than 30 minutes
    if (now - room.createdAt > 30 * 60 * 1000) {
      if (room.host?.readyState === WebSocket.OPEN) room.host.close();
      if (room.client?.readyState === WebSocket.OPEN) room.client.close();
      rooms.delete(token);
      continue;
    }

    // Remove rooms where both peers disconnected and grace period expired
    const hostGone = !room.host && room.hostDisconnectedAt && (now - room.hostDisconnectedAt > RECONNECT_GRACE_MS);
    const clientGone = !room.client && room.clientDisconnectedAt && (now - room.clientDisconnectedAt > RECONNECT_GRACE_MS);

    if (hostGone && !room.client) {
      rooms.delete(token);
      continue;
    }
    if (clientGone && !room.host) {
      rooms.delete(token);
      continue;
    }

    // If host disconnected and grace period expired, notify client and clean up
    if (hostGone && room.client?.readyState === WebSocket.OPEN) {
      room.client.send(JSON.stringify({ type: "peer-disconnected", permanent: true }));
      room.client.close();
      rooms.delete(token);
      continue;
    }

    // If client disconnected and grace period expired, just clear client slot
    if (clientGone && room.host?.readyState === WebSocket.OPEN) {
      room.clientDisconnectedAt = null;
      room.wasConnected = false;
      // Host goes back to waiting state
      room.host.send(JSON.stringify({ type: "peer-disconnected", permanent: true }));
    }
  }
}, 30_000);

export function setupSignalingServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/ws-signaling") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (ws: WebSocket) => {
    let currentToken: string | null = null;
    let currentRole: "host" | "client" | null = null;
    console.log(`[Relay] New WebSocket connection, total rooms=${rooms.size}`);

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        // Binary data — relay file chunks directly to the peer (fallback mode)
        if (isBinary) {
          if (!currentToken || !currentRole) return;
          const room = rooms.get(currentToken);
          if (!room) return;
          const target = currentRole === "host" ? room.client : room.host;
          if (target && target.readyState === WebSocket.OPEN) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            target.send(buf, { binary: true });
          }
          return;
        }

        // Text data — parse JSON commands
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "register": {
            const token = msg.token;
            if (!token || token.length !== 4) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
              return;
            }

            // Clean up existing room with same token (only if not a reconnection)
            if (rooms.has(token)) {
              const existing = rooms.get(token)!;
              // If the host slot is empty (disconnected) and this is a re-register, allow it
              if (existing.hostDisconnectedAt && !existing.host) {
                existing.host = ws;
                existing.hostDisconnectedAt = null;
                currentToken = token;
                currentRole = "host";
                console.log(`[Relay] Host reconnected token=${token}`);
                ws.send(JSON.stringify({ type: "registered", token }));

                // If client is still connected, notify both sides
                if (existing.client?.readyState === WebSocket.OPEN) {
                  existing.client.send(JSON.stringify({ type: "peer-reconnected", role: "host" }));
                  ws.send(JSON.stringify({ type: "connected", reconnected: true }));
                  existing.wasConnected = true;
                }
                return;
              }

              // Otherwise, close existing room
              if (existing.host?.readyState === WebSocket.OPEN) existing.host.close();
              if (existing.client?.readyState === WebSocket.OPEN) existing.client.close();
              rooms.delete(token);
            }

            rooms.set(token, {
              token,
              host: ws,
              client: null,
              createdAt: Date.now(),
              hostDisconnectedAt: null,
              clientDisconnectedAt: null,
              wasConnected: false,
            });
            currentToken = token;
            currentRole = "host";
            console.log(`[Relay] Host registered token=${token}, total rooms=${rooms.size}`);
            ws.send(JSON.stringify({ type: "registered", token }));
            break;
          }

          case "join": {
            const token = msg.token;
            const room = rooms.get(token);
            console.log(`[Relay] Client join request token=${token}, room exists=${!!room}`);

            if (!room || !room.host || room.host.readyState !== WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: "No host found with this token" }));
              return;
            }

            if (room.client && room.client.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: "Room is already full" }));
              return;
            }

            room.client = ws;
            room.clientDisconnectedAt = null;
            currentToken = token;
            currentRole = "client";
            room.wasConnected = true;

            // Notify both sides that connection is established
            room.host.send(JSON.stringify({ type: "connected" }));
            ws.send(JSON.stringify({ type: "connected" }));
            break;
          }

          case "rejoin": {
            // Client reconnection — rejoin existing room with same token
            const token = msg.token;
            const role = msg.role as "host" | "client";
            const room = rooms.get(token);
            console.log(`[Relay] Rejoin request token=${token}, role=${role}, room exists=${!!room}`);

            if (!room) {
              ws.send(JSON.stringify({ type: "error", message: "Room expired. Please reconnect." }));
              return;
            }

            if (role === "client") {
              if (room.client && room.client.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "error", message: "Room is already full" }));
                return;
              }

              room.client = ws;
              room.clientDisconnectedAt = null;
              currentToken = token;
              currentRole = "client";

              ws.send(JSON.stringify({ type: "rejoined", token }));

              // Notify host that client reconnected
              if (room.host?.readyState === WebSocket.OPEN) {
                room.host.send(JSON.stringify({ type: "peer-reconnected", role: "client" }));
                ws.send(JSON.stringify({ type: "connected", reconnected: true }));
              }
            } else if (role === "host") {
              if (room.host && room.host.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "error", message: "Host slot is occupied" }));
                return;
              }

              room.host = ws;
              room.hostDisconnectedAt = null;
              currentToken = token;
              currentRole = "host";

              ws.send(JSON.stringify({ type: "rejoined", token }));

              // Notify client that host reconnected
              if (room.client?.readyState === WebSocket.OPEN) {
                room.client.send(JSON.stringify({ type: "peer-reconnected", role: "host" }));
                ws.send(JSON.stringify({ type: "connected", reconnected: true }));
              }
            }
            break;
          }

          // WebRTC signaling — relay SDP and ICE candidates between peers
          case "rtc-offer":
          case "rtc-answer":
          case "rtc-ice": {
            if (!currentToken || !currentRole) return;
            const room = rooms.get(currentToken);
            if (!room) return;
            const target = currentRole === "host" ? room.client : room.host;
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify(msg));
            }
            break;
          }

          // Data relay (fallback when WebRTC not available)
          case "text":
          case "file-meta":
          case "file-complete":
          case "chunk-request": {
            if (!currentToken || !currentRole) return;
            const room = rooms.get(currentToken);
            if (!room) return;
            const target = currentRole === "host" ? room.client : room.host;
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify(msg));
            }
            break;
          }

          case "ping": {
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          }

          default:
            ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
        }
      } catch (err) {
        console.error("[Relay] Error processing message:", err);
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      console.log(`[Relay] WebSocket closed, role=${currentRole}, token=${currentToken}`);
      if (currentToken) {
        const room = rooms.get(currentToken);
        if (room) {
          if (currentRole === "host") {
            room.host = null;
            room.hostDisconnectedAt = Date.now();

            // Notify client that host temporarily disconnected (not permanent yet)
            if (room.client?.readyState === WebSocket.OPEN && room.wasConnected) {
              room.client.send(JSON.stringify({ type: "peer-disconnected", permanent: false }));
            }

            // If room was never connected (no client ever joined), delete immediately
            if (!room.wasConnected && !room.client) {
              rooms.delete(currentToken);
            }
          } else if (currentRole === "client") {
            room.client = null;
            room.clientDisconnectedAt = Date.now();

            // Notify host that client temporarily disconnected
            if (room.host?.readyState === WebSocket.OPEN) {
              room.host.send(JSON.stringify({ type: "peer-disconnected", permanent: false }));
            }
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[Relay] WebSocket error:", err);
    });
  });

  console.log("[Relay] Hybrid WebSocket relay + WebRTC signaling server ready on /api/ws-signaling");
}
