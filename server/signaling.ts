/**
 * WebSocket Signaling Server for WebRTC peer connection
 * 
 * Manages token-based rooms where a host (PC) registers with a 4-digit token,
 * and a client (mobile) joins by providing the same token.
 * Once both are connected, they exchange WebRTC signaling messages (offer/answer/ICE candidates).
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
    // Remove rooms older than 30 minutes
    if (now - room.createdAt > 30 * 60 * 1000) {
      if (room.host?.readyState === WebSocket.OPEN) room.host.close();
      if (room.client?.readyState === WebSocket.OPEN) room.client.close();
      rooms.delete(token);
    }
  }
}, 5 * 60 * 1000);

export function setupSignalingServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests for /api/ws-signaling path
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/ws-signaling") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
    // Don't destroy socket for other paths (Vite HMR uses WebSocket too)
  });

  wss.on("connection", (ws: WebSocket) => {
    let currentToken: string | null = null;
    let currentRole: "host" | "client" | null = null;

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "register": {
            // Host registers with a token
            const token = msg.token;
            if (!token || token.length !== 4) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
              return;
            }

            // Clean up existing room with same token
            if (rooms.has(token)) {
              const existing = rooms.get(token)!;
              if (existing.host?.readyState === WebSocket.OPEN) {
                existing.host.close();
              }
              if (existing.client?.readyState === WebSocket.OPEN) {
                existing.client.close();
              }
              rooms.delete(token);
            }

            const room: Room = {
              token,
              host: ws,
              client: null,
              createdAt: Date.now(),
            };
            rooms.set(token, room);
            currentToken = token;
            currentRole = "host";

            ws.send(JSON.stringify({ type: "registered", token }));
            break;
          }

          case "join": {
            // Client joins with a token
            const token = msg.token;
            const room = rooms.get(token);

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

            // Notify host that client has joined
            room.host.send(JSON.stringify({ type: "client-joined" }));
            ws.send(JSON.stringify({ type: "joined", token }));
            break;
          }

          case "offer":
          case "answer":
          case "ice-candidate": {
            // Relay signaling messages between host and client
            if (!currentToken || !currentRole) {
              ws.send(JSON.stringify({ type: "error", message: "Not in a room" }));
              return;
            }

            const room = rooms.get(currentToken);
            if (!room) return;

            const target = currentRole === "host" ? room.client : room.host;
            if (target && target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify(msg));
            }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
        }
      } catch (err) {
        console.error("[Signaling] Error processing message:", err);
        ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
      }
    });

    ws.on("close", () => {
      if (currentToken) {
        const room = rooms.get(currentToken);
        if (room) {
          if (currentRole === "host") {
            // Notify client that host disconnected
            if (room.client?.readyState === WebSocket.OPEN) {
              room.client.send(JSON.stringify({ type: "host-disconnected" }));
              room.client.close();
            }
            rooms.delete(currentToken);
          } else if (currentRole === "client") {
            // Notify host that client disconnected
            if (room.host?.readyState === WebSocket.OPEN) {
              room.host.send(JSON.stringify({ type: "client-disconnected" }));
            }
            room.client = null;
          }
        }
      }
    });

    ws.on("error", (err) => {
      console.error("[Signaling] WebSocket error:", err);
    });
  });

  console.log("[Signaling] WebSocket signaling server ready on /api/ws-signaling");
}
