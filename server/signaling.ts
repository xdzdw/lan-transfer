/**
 * WebSocket Relay + Signaling Server for Quick Transfer
 * 
 * Hybrid approach:
 * 1. WebSocket always used for signaling (register, join, connected)
 * 2. After connection, peers attempt WebRTC P2P via SDP/ICE exchange
 * 3. If WebRTC succeeds → data flows P2P (fast, local network)
 * 4. If WebRTC fails → data flows through WebSocket relay (fallback)
 * 
 * Message types:
 * - register/join/connected/peer-disconnected: room management
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
}

const rooms = new Map<string, Room>();

// Clean up stale rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, room] of Array.from(rooms.entries())) {
    if (now - room.createdAt > 30 * 60 * 1000) {
      if (room.host?.readyState === WebSocket.OPEN) room.host.close();
      if (room.client?.readyState === WebSocket.OPEN) room.client.close();
      rooms.delete(token);
    }
  }
}, 5 * 60 * 1000);

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

            // Clean up existing room with same token
            if (rooms.has(token)) {
              const existing = rooms.get(token)!;
              if (existing.host?.readyState === WebSocket.OPEN) existing.host.close();
              if (existing.client?.readyState === WebSocket.OPEN) existing.client.close();
              rooms.delete(token);
            }

            rooms.set(token, { token, host: ws, client: null, createdAt: Date.now() });
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
            currentToken = token;
            currentRole = "client";

            // Notify both sides that connection is established
            room.host.send(JSON.stringify({ type: "connected" }));
            ws.send(JSON.stringify({ type: "connected" }));
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
          case "file-complete": {
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
            if (room.client?.readyState === WebSocket.OPEN) {
              room.client.send(JSON.stringify({ type: "peer-disconnected" }));
              room.client.close();
            }
            rooms.delete(currentToken);
          } else if (currentRole === "client") {
            if (room.host?.readyState === WebSocket.OPEN) {
              room.host.send(JSON.stringify({ type: "peer-disconnected" }));
            }
            room.client = null;
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
