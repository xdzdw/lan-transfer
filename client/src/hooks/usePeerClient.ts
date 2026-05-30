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
import { pushDebugLog } from "@/components/DebugPanel";

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

const CHUNK_SIZE = 256 * 1024; // 256KB — larger chunks for better P2P throughput
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

  // Keep sent file references for chunk-request resend (auto-clean after 120s)
  const sentFilesRef = useRef<Map<string, { file: File; totalChunks: number; sentAt: number }>>(new Map());

  const addItem = useCallback((item: TransferItem) => {
    setItems(prev => [item, ...prev]);
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<TransferItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  // Track chunk-request retry state per file
  const chunkRequestRetryRef = useRef<Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null }>>(new Map());

  const requestMissingChunks = useCallback((fileId: string, missingChunks: number[]) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      pushDebugLog(`[RETRY-ERR] Cannot request chunks — WS not open`);
      return;
    }
    const retryState = chunkRequestRetryRef.current.get(fileId) || { attempts: 0, timer: null };
    if (retryState.attempts >= 5) {
      pushDebugLog(`[RETRY-ERR] Max retries (5) reached for ${fileId.slice(0, 8)}, giving up`);
      updateItem(fileId, { status: "error" });
      fileChunksRef.current.delete(fileId);
      chunkRequestRetryRef.current.delete(fileId);
      return;
    }
    retryState.attempts++;
    chunkRequestRetryRef.current.set(fileId, retryState);

    pushDebugLog(`[RETRY] Requesting ${missingChunks.length} missing chunks (attempt ${retryState.attempts}/5): [${missingChunks.slice(0, 10).join(",")}${missingChunks.length > 10 ? "..." : ""}]`);
    ws.send(JSON.stringify({
      type: "chunk-request",
      fileId,
      chunks: missingChunks,
    }));

    // Set a timeout to retry if chunks don't arrive within 10 seconds
    if (retryState.timer) clearTimeout(retryState.timer);
    retryState.timer = setTimeout(() => {
      const entry = fileChunksRef.current.get(fileId);
      if (!entry) return; // Already assembled
      const stillMissing: number[] = [];
      for (const idx of missingChunks) {
        if (!entry.chunks.has(idx)) stillMissing.push(idx);
      }
      if (stillMissing.length > 0) {
        pushDebugLog(`[RETRY] Timeout — still missing ${stillMissing.length} chunks, retrying...`);
        requestMissingChunks(fileId, stillMissing);
      }
    }, 10000);
  }, [updateItem]);

  const assembleFile = useCallback((fileId: string) => {
    const entry = fileChunksRef.current.get(fileId);
    if (!entry) {
      pushDebugLog(`[RECV] assembleFile: no entry for ${fileId.slice(0, 8)}`);
      return;
    }
    // Check for missing chunks
    const missingChunks: number[] = [];
    for (let i = 0; i < entry.meta.totalChunks; i++) {
      if (!entry.chunks.has(i)) missingChunks.push(i);
    }
    if (missingChunks.length > 0) {
      pushDebugLog(`[RECV] assembleFile: incomplete ${entry.received}/${entry.meta.size} bytes, ${entry.chunks.size}/${entry.meta.totalChunks} chunks, missing=[${missingChunks.slice(0, 10).join(",")}${missingChunks.length > 10 ? "..." : ""}]`);
      // Request missing chunks from sender
      requestMissingChunks(fileId, missingChunks);
      return;
    }

    const orderedChunks: ArrayBuffer[] = [];
    for (let i = 0; i < entry.meta.totalChunks; i++) {
      const chunk = entry.chunks.get(i);
      if (!chunk) {
        pushDebugLog(`[RECV-ERR] Missing chunk ${i}/${entry.meta.totalChunks} despite received=${entry.received}`);
        updateItem(fileId, { status: "error", progress: 0 });
        fileChunksRef.current.delete(fileId);
        return;
      }
      orderedChunks.push(chunk);
    }

    const blob = new Blob(orderedChunks, { type: entry.meta.mimeType || "application/octet-stream" });
    if (blob.size !== entry.meta.size) {
      pushDebugLog(`[RECV-ERR] Size mismatch: expected ${entry.meta.size}, got ${blob.size}`);
      updateItem(fileId, { status: "error", progress: 0 });
      fileChunksRef.current.delete(fileId);
      return;
    }

    pushDebugLog(`[RECV] DONE: ${entry.meta.name} (${(entry.meta.size / 1024 / 1024).toFixed(1)}MB, ${entry.meta.totalChunks} chunks)`);
    updateItem(fileId, { progress: 100, status: "done", blob });
    fileChunksRef.current.delete(fileId);
    // Clean up retry timer
    const retryState = chunkRequestRetryRef.current.get(fileId);
    if (retryState?.timer) clearTimeout(retryState.timer);
    chunkRequestRetryRef.current.delete(fileId);
  }, [updateItem]);

  // Track last logged receive progress per file to avoid log spam
  const recvLogProgressRef = useRef<Map<string, number>>(new Map());

  const processBinaryChunk = useCallback((buffer: ArrayBuffer) => {
    if (buffer.byteLength < HEADER_SIZE) return;

    const decoder = new TextDecoder();
    const idBytes = new Uint8Array(buffer, 0, 36);
    const fileId = decoder.decode(idBytes);

    const indexView = new DataView(buffer, 36, 4);
    const chunkIndex = indexView.getUint32(0, false);
    const chunkData = buffer.slice(HEADER_SIZE);

    const entry = fileChunksRef.current.get(fileId);
    if (!entry) {
      pushDebugLog(`[RECV-WARN] Chunk for unknown file ${fileId.slice(0, 8)}, idx=${chunkIndex}`);
      return;
    }

    // Dedup: only count bytes for new chunks (relay resend may send duplicates)
    if (!entry.chunks.has(chunkIndex)) {
      entry.chunks.set(chunkIndex, chunkData);
      entry.received += chunkData.byteLength;
    } else {
      // Duplicate chunk — update data but don't re-count bytes
      entry.chunks.set(chunkIndex, chunkData);
    }
    const progress = Math.min(99, Math.round((entry.received / entry.meta.size) * 100));
    updateItem(fileId, { progress, status: "transferring" });

    // Log every 10% progress
    const lastLogged = recvLogProgressRef.current.get(fileId) || 0;
    if (progress >= lastLogged + 10) {
      pushDebugLog(`[RECV] ${progress}% | ${entry.chunks.size}/${entry.meta.totalChunks} chunks | ${(entry.received / 1024 / 1024).toFixed(1)}MB/${(entry.meta.size / 1024 / 1024).toFixed(1)}MB`);
      recvLogProgressRef.current.set(fileId, progress);
    }

    if (entry.pendingComplete && entry.chunks.size >= entry.meta.totalChunks) {
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
          // If we already have this file (resume scenario), don't re-add item or reset chunks
          if (!fileChunksRef.current.has(meta.id)) {
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
          }
          break;
        }

        case "file-complete": {
          const entry = fileChunksRef.current.get(msg.id);
          if (entry) {
            entry.pendingComplete = true;
            pushDebugLog(`[RECV] file-complete signal received, have ${entry.chunks.size}/${entry.meta.totalChunks} chunks (${(entry.received / 1024 / 1024).toFixed(1)}MB/${(entry.meta.size / 1024 / 1024).toFixed(1)}MB)`);
            binaryQueueRef.current = binaryQueueRef.current.then(() => {
              assembleFile(msg.id);
            });
          } else {
            pushDebugLog(`[RECV-WARN] file-complete for unknown file ${msg.id?.slice(0, 8)}`);
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
    // Close any existing RTC connection before creating a new one
    if (rtcRef.current) {
      console.log("[Client] Closing existing RTC before handling new offer...");
      rtcRef.current.close();
      rtcRef.current = null;
    }
    console.log("[Client] Received WebRTC offer, creating answer...");
    setTransportMode("upgrading");

    const transport = createClientRTC(
      ws,
      offer,
      // onOpen — DataChannel is ready
      () => {
        rtcRef.current = transport;
        setTransportMode("p2p");
        pushDebugLog("[P2P] DataChannel OPEN — P2P mode active");
        console.log("[Client] WebRTC P2P established! Transfers will use direct connection.");
      },
      // onMessage — data from DataChannel
      handleDataMessage,
      // onClose — DataChannel closed, fall back to relay
      () => {
        pushDebugLog("[P2P] DataChannel CLOSED — fallback to relay");
        setTransportMode("relay");
      },
      // onFail — WebRTC failed, stay on relay
      () => {
        pushDebugLog("[P2P] WebRTC FAILED — using relay mode");
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

    pushDebugLog(`[RESUME] ${file.name} from chunk ${startChunk}/${totalChunks}`);

    if (startChunk >= totalChunks) {
      const completeStr = JSON.stringify({ type: "file-complete", id });
      sendViaTransport(rtcRef.current, ws, completeStr);
      updateItem(id, { progress: 100, status: "done" });
      sendState.completed = true;
      pendingSendsRef.current.delete(id);
      pushDebugLog(`[RESUME] Already complete, sent file-complete signal`);
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
    const resumeStartTime = Date.now();
    let lastLoggedProgress = 0;

    for (let i = startChunk; i < totalChunks; i++) {
      if (abortController.signal.aborted) {
        pushDebugLog(`[RESUME] Paused again at chunk ${i}/${totalChunks}`);
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

      // Back-pressure: event-driven for P2P, polling for relay
      const dc = rtcRef.current?.dataChannel;
      const dcOpen = dc?.readyState === "open";

      if (dcOpen && dc) {
        const P2P_MAX_BUFFER = 512 * 1024;
        if (dc.bufferedAmount > P2P_MAX_BUFFER) {
          await new Promise<void>((resolve) => {
            const onLow = () => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); };
            dc.addEventListener("bufferedamountlow", onLow);
            setTimeout(() => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); }, 5000);
          });
        }
      } else {
        const maxBuffer = 512 * 1024;
        let bpWaits = 0;
        while (ws && ws.bufferedAmount > maxBuffer) {
          if (abortController.signal.aborted) return;
          await new Promise(resolve => setTimeout(resolve, 10));
          bpWaits++;
          if (ws.readyState !== WebSocket.OPEN) {
            pushDebugLog(`[ERR] WebSocket closed during resume relay at chunk ${i}/${totalChunks}`);
            sendState.lastSentChunk = i - 1;
            return;
          }
        }
      }

      const dcStillOpen = rtcRef.current?.dataChannel?.readyState === "open";
      const wsOpen = ws?.readyState === WebSocket.OPEN;
      if (!dcStillOpen && !wsOpen) {
        pushDebugLog(`[ERR] Both transports dead at resume chunk ${i}/${totalChunks}`);
        sendState.lastSentChunk = i - 1;
        return;
      }

      const actualMode = sendViaTransport(rtcRef.current, ws, combined);
      sendState.lastSentChunk = i;

      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });

      if (progress >= lastLoggedProgress + 10) {
        const elapsed = (Date.now() - resumeStartTime) / 1000;
        const sentBytes = (i - startChunk + 1) * CHUNK_SIZE;
        const speedMBs = (sentBytes / (1024 * 1024)) / elapsed;
        const dcState = rtcRef.current?.dataChannel?.readyState || "none";
        pushDebugLog(`[RESUME] ${progress}% | ${elapsed.toFixed(1)}s | ${speedMBs.toFixed(2)} MB/s | mode=${actualMode} | dc=${dcState}`);
        lastLoggedProgress = progress;
      }
    }

    const completeStr = JSON.stringify({ type: "file-complete", id });
    sendViaTransport(rtcRef.current, ws, completeStr);
    updateItem(id, { progress: 100, status: "done" });
    sendState.completed = true;
    pendingSendsRef.current.delete(id);
    activeSendAbortRef.current = null;

    // Keep file reference for potential chunk-request resend (120s TTL)
    sentFilesRef.current.set(id, { file, totalChunks, sentAt: Date.now() });
    setTimeout(() => { sentFilesRef.current.delete(id); }, 120_000);

    const totalTime = ((Date.now() - resumeStartTime) / 1000).toFixed(1);
    pushDebugLog(`[RESUME] DONE: ${file.name} | ${totalTime}s`);
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
          pushDebugLog(`[WS] Connected to host (reconnected=${!!msg.reconnected})`);
          setStatus("connected");
          setError("");
          wasConnectedRef.current = true;
          reconnectAttemptRef.current = 0;
          if (msg.reconnected) {
            pushDebugLog("[RECONNECT] Resuming pending file sends...");
            resumePendingSends();
          }
          break;

        case "rejoined":
          pushDebugLog("[RECONNECT] Rejoined room OK");
          break;

        // WebRTC signaling messages
        case "rtc-offer":
          if (wsRef.current && msg.sdp) {
            if (!rtcRef.current || rtcRef.current.dataChannel?.readyState !== "open") {
              pushDebugLog("[P2P] Received RTC offer, creating answer...");
              handleRTCOffer(wsRef.current, msg.sdp);
            } else {
              pushDebugLog("[P2P] Ignoring rtc-offer — DC already open");
            }
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

        // Chunk resend request from receiver
        case "chunk-request": {
          const { fileId, chunks: requestedChunks } = msg as { fileId: string; chunks: number[] };
          const sentFile = sentFilesRef.current.get(fileId);
          if (!sentFile) {
            pushDebugLog(`[RESEND-ERR] chunk-request for unknown/expired file ${fileId?.slice(0, 8)}`);
            break;
          }
          pushDebugLog(`[RESEND] Received chunk-request for ${requestedChunks.length} chunks: [${requestedChunks.slice(0, 10).join(",")}${requestedChunks.length > 10 ? "..." : ""}]`);
          // Resend requested chunks via relay (safest path)
          (async () => {
            const ws = wsRef.current;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const CHUNK_SZ = 256 * 1024;
            for (const idx of requestedChunks) {
              const start = idx * CHUNK_SZ;
              const end = Math.min(start + CHUNK_SZ, sentFile.file.size);
              const blob = sentFile.file.slice(start, end);
              const chunkData = await blob.arrayBuffer();
              // Build header: 36-byte fileId + 4-byte chunk index
              const header = new ArrayBuffer(40);
              const encoder = new TextEncoder();
              const idBytes = encoder.encode(fileId);
              new Uint8Array(header).set(idBytes.slice(0, 36), 0);
              new DataView(header, 36, 4).setUint32(0, idx, false);
              // Combine header + chunk data
              const combined = new Uint8Array(header.byteLength + chunkData.byteLength);
              combined.set(new Uint8Array(header), 0);
              combined.set(new Uint8Array(chunkData), header.byteLength);
              // Back-pressure for relay
              while (ws.bufferedAmount > 512 * 1024) {
                await new Promise(resolve => setTimeout(resolve, 10));
                if (ws.readyState !== WebSocket.OPEN) return;
              }
              ws.send(combined.buffer);
            }
            pushDebugLog(`[RESEND] Done resending ${requestedChunks.length} chunks`);
          })();
          break;
        }

        case "peer-disconnected":
          if (msg.permanent) {
            pushDebugLog("[WS] Host PERMANENTLY disconnected");
            setStatus("error");
            setError("Host disconnected");
            setTransportMode("relay");
            if (rtcRef.current) {
              rtcRef.current.close();
              rtcRef.current = null;
            }
          } else {
            pushDebugLog(`[WS] Host temporarily disconnected, DC=${rtcRef.current?.dataChannel?.readyState || "none"}`);
            if (!rtcRef.current?.dataChannel || rtcRef.current.dataChannel.readyState !== "open") {
              setTransportMode("relay");
            } else {
              pushDebugLog("[P2P] DataChannel still open — keeping P2P");
            }
          }
          break;

        case "peer-reconnected":
          pushDebugLog("[WS] Host reconnected!");
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
    pushDebugLog(`[RECONNECT] Attempt ${attempt + 1} in ${delay}ms...`);

    setStatus("reconnecting");

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current = attempt + 1;

      try {
        const ws = new WebSocket(getWsUrl());
        wsRef.current = ws;

        ws.onopen = () => {
          pushDebugLog(`[RECONNECT] WS reconnected, rejoining token=${tokenRef.current}`);
          ws.send(JSON.stringify({ type: "rejoin", token: tokenRef.current, role: "client" }));
          pingRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 15000);
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
        }, 15000);
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
        pushDebugLog("[WS] Connection closed");

        // Auto-reconnect if we were previously connected and didn't intentionally close
        if (!intentionalCloseRef.current && wasConnectedRef.current) {
          // Only abort file sends if DataChannel is NOT available
          // If P2P is still working, the file can continue sending via DataChannel
          if (activeSendAbortRef.current && (!rtcRef.current?.dataChannel || rtcRef.current.dataChannel.readyState !== "open")) {
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
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);

    pushDebugLog(`[SEND] Start: ${file.name} (${fileSizeMB}MB, ${totalChunks} chunks)`);

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
    const sendStartTime = Date.now();
    let lastLoggedProgress = 0;

    // Track chunks sent via P2P that might be lost if DC crashes
    const p2pSentChunks: number[] = [];
    let dcWasOpen = rtcRef.current?.dataChannel?.readyState === "open";
    let dcCrashDetected = false;

    for (let i = 0; i < totalChunks; i++) {
      if (abortController.signal.aborted) {
        pushDebugLog(`[SEND] Paused at chunk ${i}/${totalChunks}, will resume`);
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

      // Back-pressure: event-driven for P2P, polling for relay
      const dc = rtcRef.current?.dataChannel;
      const dcOpen = dc?.readyState === "open";

      if (dcOpen && dc) {
        const P2P_MAX_BUFFER = 512 * 1024;
        if (dc.bufferedAmount > P2P_MAX_BUFFER) {
          await new Promise<void>((resolve) => {
            const onLow = () => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); };
            dc.addEventListener("bufferedamountlow", onLow);
            setTimeout(() => { dc.removeEventListener("bufferedamountlow", onLow); resolve(); }, 5000);
          });
        }
      } else {
        const maxBuffer = 512 * 1024;
        let bpWaits = 0;
        while (ws && ws.bufferedAmount > maxBuffer) {
          if (abortController.signal.aborted) return;
          await new Promise(resolve => setTimeout(resolve, 10));
          bpWaits++;
          if (ws.readyState !== WebSocket.OPEN) {
            pushDebugLog(`[ERR] WebSocket closed during relay at chunk ${i}/${totalChunks}`);
            sendState.lastSentChunk = i - 1;
            return;
          }
          if (bpWaits % 100 === 0) {
            pushDebugLog(`[WARN] Relay back-pressure wait ${bpWaits} at chunk ${i}, buf=${(ws.bufferedAmount / 1024).toFixed(0)}KB`);
          }
        }
      }

      const dcStillOpen = rtcRef.current?.dataChannel?.readyState === "open";
      const wsOpen = ws?.readyState === WebSocket.OPEN;
      if (!dcStillOpen && !wsOpen) {
        pushDebugLog(`[ERR] Both transports dead at chunk ${i}/${totalChunks}`);
        sendState.lastSentChunk = i - 1;
        return;
      }

      const actualMode = sendViaTransport(rtcRef.current, ws, combined);
      sendState.lastSentChunk = i;

      // Track P2P-sent chunks for potential resend
      if (actualMode === "p2p") {
        p2pSentChunks.push(i);
      }

      // Detect DC crash: was open, now closed
      if (dcWasOpen && rtcRef.current?.dataChannel?.readyState !== "open" && !dcCrashDetected) {
        dcCrashDetected = true;
        pushDebugLog(`[P2P-CRASH] DataChannel crashed after sending ${p2pSentChunks.length} chunks via P2P. Will resend via relay after main loop.`);
      }

      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });

      // Log progress every 10%
      if (progress >= lastLoggedProgress + 10) {
        const elapsed = (Date.now() - sendStartTime) / 1000;
        const sentBytes = (i + 1) * CHUNK_SIZE;
        const speedMBs = (sentBytes / (1024 * 1024)) / elapsed;
        const dcState = rtcRef.current?.dataChannel?.readyState || "none";
        pushDebugLog(`[SEND] ${progress}% | ${elapsed.toFixed(1)}s | ${speedMBs.toFixed(2)} MB/s | mode=${actualMode} | dc=${dcState}`);
        lastLoggedProgress = progress;
      }
    }

    // If DC crashed, resend the chunks that were sent via P2P (they may have been lost)
    if (dcCrashDetected && p2pSentChunks.length > 0 && ws?.readyState === WebSocket.OPEN) {
      pushDebugLog(`[RESEND] Resending ${p2pSentChunks.length} chunks via relay (originally sent via P2P before crash)`);
      for (const chunkIdx of p2pSentChunks) {
        if (abortController.signal.aborted) return;
        const start = chunkIdx * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = buffer.slice(start, end);

        const idBytes = new TextEncoder().encode(id);
        const combined = new ArrayBuffer(HEADER_SIZE + chunk.byteLength);
        const view = new Uint8Array(combined);
        view.set(idBytes, 0);
        const indexView = new DataView(combined, 36, 4);
        indexView.setUint32(0, chunkIdx, false);
        view.set(new Uint8Array(chunk), HEADER_SIZE);

        while (getTransportBufferedAmount(null, ws) > 512 * 1024) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        sendViaTransport(null, ws, combined); // Force relay
      }
      pushDebugLog(`[RESEND] Done resending ${p2pSentChunks.length} chunks via relay`);
    }

    // Send completion signal
    const completeStr = JSON.stringify({ type: "file-complete", id });
    sendViaTransport(rtcRef.current, ws, completeStr);
    updateItem(id, { progress: 100, status: "done" });
    sendState.completed = true;
    pendingSendsRef.current.delete(id);
    activeSendAbortRef.current = null;

    // Keep file reference for potential chunk-request resend (120s TTL)
    sentFilesRef.current.set(id, { file, totalChunks, sentAt: Date.now() });
    setTimeout(() => { sentFilesRef.current.delete(id); }, 120_000);

    const totalTime = ((Date.now() - sendStartTime) / 1000).toFixed(1);
    const avgSpeed = (file.size / (1024 * 1024)) / ((Date.now() - sendStartTime) / 1000);
    pushDebugLog(`[SEND] DONE: ${file.name} | ${totalTime}s | avg ${avgSpeed.toFixed(2)} MB/s`);
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
