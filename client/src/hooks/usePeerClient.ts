/**
 * usePeerClient — 手机端（Client）混合传输
 * 
 * Hybrid approach:
 * 1. WebSocket connects to server, joins room via token
 * 2. Once connected, receives WebRTC offer from host
 * 3. Creates WebRTC answer → DataChannel opens → P2P mode
 * 4. If WebRTC fails/times out → automatic fallback to WebSocket relay
 * 
 * Reconnection:
 * - On WebSocket close (e.g. phone lock screen), auto-reconnect with exponential backoff
 * - Sends "rejoin" instead of "join" to resume existing session
 * - Pending file sends are resumed from the last sent chunk
 * 
 * File transfer protocol (same for both P2P and relay):
 * 1. Sender sends file-meta JSON with { id, name, size, mimeType, totalChunks }
 * 2. Sender sends binary chunks: [36-byte UUID][4-byte chunk index (big-endian)][chunk data]
 * 3. Sender sends file-complete JSON with { id }
 * 4. Receiver assembles chunks IN ORDER by chunk index, verifies total size matches
 */

import { useCallback, useRef, useState } from "react";
import type { TransferItem } from "./usePeerHost";
import {
  createClientRTC,
  handleRTCSignaling,
  sendViaTransport,
  getTransportBufferedAmount,
  type WebRTCTransport,
  type TransportMode,
} from "@/lib/webrtc";

interface FileChunkMeta {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
}

interface FileReceiveState {
  meta: FileChunkMeta;
  chunks: Map<number, ArrayBuffer>;
  received: number;
  pendingComplete: boolean;
}

/** Tracks a file send in progress for resume after reconnect */
interface FileSendState {
  id: string;
  file: File;
  totalChunks: number;
  lastSentChunk: number; // last successfully queued chunk index
  completed: boolean;
}

const CHUNK_SIZE = 64 * 1024;
const HEADER_SIZE = 40; // 36-byte UUID + 4-byte chunk index

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws-signaling`;
}

export function usePeerClient() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "error">("idle");
  const [items, setItems] = useState<TransferItem[]>([]);
  const [error, setError] = useState<string>("");
  const [transportMode, setTransportMode] = useState<TransportMode>("relay");

  const wsRef = useRef<WebSocket | null>(null);
  const rtcRef = useRef<WebRTCTransport | null>(null);
  const fileChunksRef = useRef<Map<string, FileReceiveState>>(new Map());
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const binaryQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Reconnection state
  const tokenRef = useRef<string>("");
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const intentionalCloseRef = useRef<boolean>(false);
  const wasConnectedRef = useRef<boolean>(false);

  // File send tracking for resume
  const pendingSendsRef = useRef<Map<string, FileSendState>>(new Map());
  const activeSendAbortRef = useRef<AbortController | null>(null);

  const addItem = useCallback((item: TransferItem) => {
    setItems(prev => [item, ...prev]);
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<TransferItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const assembleFile = useCallback((fileId: string) => {
    const entry = fileChunksRef.current.get(fileId);
    if (!entry) return;
    if (entry.received < entry.meta.size) return;

    const orderedChunks: ArrayBuffer[] = [];
    for (let i = 0; i < entry.meta.totalChunks; i++) {
      const chunk = entry.chunks.get(i);
      if (!chunk) {
        console.error(`[Client] Missing chunk ${i} for file ${fileId}`);
        updateItem(fileId, { status: "error", progress: 0 });
        fileChunksRef.current.delete(fileId);
        return;
      }
      orderedChunks.push(chunk);
    }

    const blob = new Blob(orderedChunks, { type: entry.meta.mimeType || "application/octet-stream" });
    if (blob.size !== entry.meta.size) {
      console.error(`[Client] File size mismatch: expected ${entry.meta.size}, got ${blob.size}`);
      updateItem(fileId, { status: "error", progress: 0 });
      fileChunksRef.current.delete(fileId);
      return;
    }

    updateItem(fileId, { progress: 100, status: "done", blob });
    fileChunksRef.current.delete(fileId);
  }, [updateItem]);

  const processBinaryChunk = useCallback((buffer: ArrayBuffer) => {
    if (buffer.byteLength < HEADER_SIZE) return;

    const decoder = new TextDecoder();
    const idBytes = new Uint8Array(buffer, 0, 36);
    const fileId = decoder.decode(idBytes);

    const indexView = new DataView(buffer, 36, 4);
    const chunkIndex = indexView.getUint32(0, false);
    const chunkData = buffer.slice(HEADER_SIZE);

    const entry = fileChunksRef.current.get(fileId);
    if (!entry) return;

    entry.chunks.set(chunkIndex, chunkData);
    entry.received += chunkData.byteLength;
    const progress = Math.min(99, Math.round((entry.received / entry.meta.size) * 100));
    updateItem(fileId, { progress, status: "transferring" });

    if (entry.pendingComplete && entry.received >= entry.meta.size) {
      assembleFile(fileId);
    }
  }, [updateItem, assembleFile]);

  /** Handle incoming data (from either DataChannel or WebSocket) */
  const handleDataMessage = useCallback((event: MessageEvent) => {
    try {
      // Binary data — file chunk
      if (event.data instanceof ArrayBuffer) {
        binaryQueueRef.current = binaryQueueRef.current.then(() => {
          processBinaryChunk(event.data as ArrayBuffer);
        });
        return;
      }

      if (event.data instanceof Blob) {
        binaryQueueRef.current = binaryQueueRef.current.then(() =>
          event.data.arrayBuffer().then((buffer: ArrayBuffer) => {
            processBinaryChunk(buffer);
          })
        );
        return;
      }

      // Text data — JSON messages
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "text":
          addItem({
            id: crypto.randomUUID(),
            type: "text",
            direction: "received",
            name: "Text Message",
            content: msg.content,
            timestamp: Date.now(),
            status: "done",
          });
          break;

        case "file-meta": {
          const meta: FileChunkMeta = msg.meta;
          fileChunksRef.current.set(meta.id, {
            meta,
            chunks: new Map(),
            received: 0,
            pendingComplete: false,
          });
          addItem({
            id: meta.id,
            type: "file",
            direction: "received",
            name: meta.name,
            size: meta.size,
            progress: 0,
            timestamp: Date.now(),
            status: "transferring",
          });
          break;
        }

        case "file-complete": {
          const entry = fileChunksRef.current.get(msg.id);
          if (entry) {
            entry.pendingComplete = true;
            binaryQueueRef.current = binaryQueueRef.current.then(() => {
              assembleFile(msg.id);
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error("[Client] Error handling data message:", err);
    }
  }, [addItem, processBinaryChunk, assembleFile]);

  /** Handle WebRTC offer from host — create answer and establish P2P */
  const handleRTCOffer = useCallback((ws: WebSocket, offer: RTCSessionDescriptionInit) => {
    console.log("[Client] Received WebRTC offer, creating answer...");
    setTransportMode("upgrading");

    const transport = createClientRTC(
      ws,
      offer,
      // onOpen — DataChannel is ready
      () => {
        rtcRef.current = transport;
        setTransportMode("p2p");
        console.log("[Client] WebRTC P2P established! Transfers will use direct connection.");
      },
      // onMessage — data from DataChannel
      handleDataMessage,
      // onClose — DataChannel closed, fall back to relay
      () => {
        console.log("[Client] DataChannel closed, falling back to relay");
        setTransportMode("relay");
      },
      // onFail — WebRTC failed, stay on relay
      () => {
        console.log("[Client] WebRTC failed, using relay mode");
        setTransportMode("relay");
      },
    );

    rtcRef.current = transport;
  }, [handleDataMessage]);

  /** Resume pending file sends after reconnection */
  const resumePendingSends = useCallback(() => {
    for (const [id, sendState] of Array.from(pendingSendsRef.current.entries())) {
      if (sendState.completed) continue;
      console.log(`[Client] Resuming file send ${sendState.file.name} from chunk ${sendState.lastSentChunk + 1}/${sendState.totalChunks}`);
      // Re-send from where we left off
      resumeFileSend(sendState);
    }
  }, []);

  const resumeFileSend = useCallback(async (sendState: FileSendState) => {
    const ws = wsRef.current;
    const { id, file, totalChunks, lastSentChunk } = sendState;
    const startChunk = lastSentChunk + 1;

    if (startChunk >= totalChunks) {
      // All chunks were sent, just send complete signal
      const completeStr = JSON.stringify({ type: "file-complete", id });
      sendViaTransport(rtcRef.current, ws, completeStr);
      updateItem(id, { progress: 100, status: "done" });
      sendState.completed = true;
      pendingSendsRef.current.delete(id);
      return;
    }

    // Re-send file-meta so receiver knows what's coming (in case they lost it)
    const metaStr = JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, mimeType: file.type, totalChunks },
    });
    sendViaTransport(rtcRef.current, ws, metaStr);

    const buffer = await file.arrayBuffer();
    const abortController = new AbortController();
    activeSendAbortRef.current = abortController;

    for (let i = startChunk; i < totalChunks; i++) {
      // Check if send was aborted (e.g. disconnected again)
      if (abortController.signal.aborted) {
        console.log(`[Client] File send aborted at chunk ${i}`);
        return;
      }

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = buffer.slice(start, end);

      const idBytes = new TextEncoder().encode(id);
      const combined = new ArrayBuffer(HEADER_SIZE + chunk.byteLength);
      const view = new Uint8Array(combined);
      view.set(idBytes, 0);
      const indexView = new DataView(combined, 36, 4);
      indexView.setUint32(0, i, false);
      view.set(new Uint8Array(chunk), HEADER_SIZE);

      // Back-pressure: wait if buffer is full
      let waitCount = 0;
      while (getTransportBufferedAmount(rtcRef.current, ws) > 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 50));
        waitCount++;
        if (waitCount > 200 || abortController.signal.aborted) {
          // If we waited too long or aborted, stop
          if (abortController.signal.aborted) return;
          break;
        }
      }

      sendViaTransport(rtcRef.current, ws, combined);
      sendState.lastSentChunk = i;

      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });
    }

    // Send completion signal
    const completeStr = JSON.stringify({ type: "file-complete", id });
    sendViaTransport(rtcRef.current, ws, completeStr);
    updateItem(id, { progress: 100, status: "done" });
    sendState.completed = true;
    pendingSendsRef.current.delete(id);
    activeSendAbortRef.current = null;
  }, [updateItem]);

  const handleWsMessage = useCallback((event: MessageEvent) => {
    try {
      // Binary data — file chunk via relay
      if (event.data instanceof Blob) {
        handleDataMessage(event);
        return;
      }

      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "connected":
          setStatus("connected");
          setError("");
          wasConnectedRef.current = true;
          reconnectAttemptRef.current = 0;
          // If this is a reconnection, resume pending sends
          if (msg.reconnected) {
            console.log("[Client] Reconnected to session, resuming...");
            resumePendingSends();
          }
          break;

        case "rejoined":
          console.log("[Client] Rejoined room successfully");
          break;

        // WebRTC signaling messages
        case "rtc-offer":
          if (wsRef.current && msg.sdp) {
            handleRTCOffer(wsRef.current, msg.sdp);
          }
          break;

        case "rtc-ice":
          handleRTCSignaling(rtcRef.current, msg);
          break;

        // Data relay messages (when in relay mode)
        case "text":
        case "file-meta":
        case "file-complete":
          handleDataMessage(event);
          break;

        case "peer-disconnected":
          if (msg.permanent) {
            // Host permanently gone
            setStatus("error");
            setError("Host disconnected");
            setTransportMode("relay");
            if (rtcRef.current) {
              rtcRef.current.close();
              rtcRef.current = null;
            }
          } else {
            // Host temporarily disconnected, wait for reconnection
            console.log("[Client] Host temporarily disconnected, waiting for reconnection...");
            setTransportMode("relay");
            if (rtcRef.current) {
              rtcRef.current.close();
              rtcRef.current = null;
            }
          }
          break;

        case "peer-reconnected":
          console.log("[Client] Host reconnected!");
          setStatus("connected");
          setError("");
          break;

        case "error":
          // If error during rejoin, the room may have expired
          if (msg.message?.includes("expired") || msg.message?.includes("Room")) {
            setError("Session expired. Please reconnect.");
            setStatus("error");
            intentionalCloseRef.current = true;
          } else {
            setError(msg.message || "Connection error");
            setStatus("error");
          }
          break;

        case "pong":
          break;
      }
    } catch (err) {
      console.error("[Client] Error handling message:", err);
    }
  }, [handleDataMessage, handleRTCOffer, resumePendingSends]);

  /** Attempt to reconnect WebSocket */
  const attemptReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;
    if (!tokenRef.current) return;

    const attempt = reconnectAttemptRef.current;
    // Exponential backoff: 1s, 2s, 4s, 8s, max 10s
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    console.log(`[Client] Reconnecting in ${delay}ms (attempt ${attempt + 1})...`);

    setStatus("reconnecting");

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current = attempt + 1;

      try {
        const ws = new WebSocket(getWsUrl());
        wsRef.current = ws;

        ws.onopen = () => {
          console.log("[Client] WebSocket reconnected, rejoining room...");
          // Send rejoin instead of join
          ws.send(JSON.stringify({ type: "rejoin", token: tokenRef.current, role: "client" }));
          pingRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 25000);
        };

        ws.onmessage = (event) => {
          handleWsMessage(event);
        };

        ws.onclose = () => {
          if (pingRef.current) clearInterval(pingRef.current);
          console.log("[Client] WebSocket closed during reconnection");
          if (!intentionalCloseRef.current && wasConnectedRef.current) {
            attemptReconnect();
          }
        };

        ws.onerror = () => {
          console.log("[Client] WebSocket error during reconnection");
          // Will trigger onclose which handles retry
        };
      } catch (err) {
        console.error("[Client] Reconnection attempt failed:", err);
        if (!intentionalCloseRef.current) {
          attemptReconnect();
        }
      }
    }, delay);
  }, [handleWsMessage]);

  const connect = useCallback((inputToken: string) => {
    try {
      setStatus("connecting");
      setError("");
      setItems([]);
      setTransportMode("relay");
      fileChunksRef.current.clear();
      pendingSendsRef.current.clear();
      intentionalCloseRef.current = false;
      wasConnectedRef.current = false;
      reconnectAttemptRef.current = 0;
      tokenRef.current = inputToken;

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.close();
        setError("Connection timed out. Make sure the PC has the page open.");
        setStatus("error");
        intentionalCloseRef.current = true;
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", token: inputToken }));
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "connected" || msg.type === "error") {
              clearTimeout(timeout);
            }
          } catch {}
        }
        handleWsMessage(event);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        if (pingRef.current) clearInterval(pingRef.current);
        console.log("[Client] WebSocket closed");

        // Auto-reconnect if we were previously connected and didn't intentionally close
        if (!intentionalCloseRef.current && wasConnectedRef.current) {
          // Abort any active file send
          if (activeSendAbortRef.current) {
            activeSendAbortRef.current.abort();
            activeSendAbortRef.current = null;
          }
          attemptReconnect();
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        if (!wasConnectedRef.current) {
          // First connection failed
          setError("Connection to server failed");
          setStatus("error");
          intentionalCloseRef.current = true;
        }
        // If already connected before, onclose will handle reconnection
      };
    } catch (err) {
      setError("Failed to connect");
      setStatus("error");
      console.error(err);
    }
  }, [handleWsMessage, attemptReconnect]);

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    const jsonStr = JSON.stringify({ type: "text", content: text });
    const mode = sendViaTransport(rtcRef.current, ws, jsonStr);

    const id = crypto.randomUUID();
    addItem({
      id,
      type: "text",
      direction: "sent",
      name: "Text Message",
      content: text,
      timestamp: Date.now(),
      status: "done",
    });
    console.log(`[Client] Sent text via ${mode}`);
  }, [addItem]);

  const sendFile = useCallback(async (file: File) => {
    const ws = wsRef.current;
    const id = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    // Track this send for potential resume
    const sendState: FileSendState = {
      id,
      file,
      totalChunks,
      lastSentChunk: -1,
      completed: false,
    };
    pendingSendsRef.current.set(id, sendState);

    addItem({
      id,
      type: "file",
      direction: "sent",
      name: file.name,
      size: file.size,
      progress: 0,
      timestamp: Date.now(),
      status: "transferring",
    });

    const metaStr = JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, mimeType: file.type, totalChunks },
    });
    sendViaTransport(rtcRef.current, ws, metaStr);

    const buffer = await file.arrayBuffer();
    const abortController = new AbortController();
    activeSendAbortRef.current = abortController;

    for (let i = 0; i < totalChunks; i++) {
      // Check if send was aborted (disconnected)
      if (abortController.signal.aborted) {
        console.log(`[Client] File send paused at chunk ${i}, will resume after reconnect`);
        return;
      }

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = buffer.slice(start, end);

      const idBytes = new TextEncoder().encode(id);
      const combined = new ArrayBuffer(HEADER_SIZE + chunk.byteLength);
      const view = new Uint8Array(combined);
      view.set(idBytes, 0);
      const indexView = new DataView(combined, 36, 4);
      indexView.setUint32(0, i, false);
      view.set(new Uint8Array(chunk), HEADER_SIZE);

      // Back-pressure
      let waitCount = 0;
      while (getTransportBufferedAmount(rtcRef.current, ws) > 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 50));
        waitCount++;
        if (waitCount > 200 || abortController.signal.aborted) {
          if (abortController.signal.aborted) return;
          break;
        }
      }

      sendViaTransport(rtcRef.current, ws, combined);
      sendState.lastSentChunk = i;

      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });
    }

    const completeStr = JSON.stringify({ type: "file-complete", id });
    sendViaTransport(rtcRef.current, ws, completeStr);
    updateItem(id, { progress: 100, status: "done" });
    sendState.completed = true;
    pendingSendsRef.current.delete(id);
    activeSendAbortRef.current = null;
  }, [addItem, updateItem]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (activeSendAbortRef.current) {
      activeSendAbortRef.current.abort();
      activeSendAbortRef.current = null;
    }
    if (pingRef.current) clearInterval(pingRef.current);
    if (rtcRef.current) {
      rtcRef.current.close();
      rtcRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("idle");
    setItems([]);
    setTransportMode("relay");
    fileChunksRef.current.clear();
    pendingSendsRef.current.clear();
    tokenRef.current = "";
    wasConnectedRef.current = false;
    reconnectAttemptRef.current = 0;
  }, []);

  return { status, items, error, transportMode, connect, sendText, sendFile, disconnect };
}
