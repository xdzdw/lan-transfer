/**
 * usePeerHost — PC端（Host）混合传输
 * 
 * Hybrid approach:
 * 1. WebSocket connects to server, registers token, waits for client
 * 2. Once client joins, both sides attempt WebRTC P2P via DataChannel
 * 3. If WebRTC succeeds → data flows P2P (fast LAN direct transfer)
 * 4. If WebRTC fails/times out → automatic fallback to WebSocket relay
 * 
 * Reconnection:
 * - On WebSocket close, auto-reconnect with exponential backoff
 * - Sends "register" with same token to re-register the room
 * - Pending file sends are resumed from the last sent chunk
 * 
 * File transfer protocol (same for both P2P and relay):
 * 1. Sender sends file-meta JSON with { id, name, size, mimeType, totalChunks }
 * 2. Sender sends binary chunks: [36-byte UUID][4-byte chunk index (big-endian)][chunk data]
 * 3. Sender sends file-complete JSON with { id }
 * 4. Receiver assembles chunks IN ORDER by chunk index, verifies total size matches
 */

import { useCallback, useRef, useState } from "react";
import {
  createHostRTC,
  handleRTCSignaling,
  sendViaTransport,
  getTransportBufferedAmount,
  type WebRTCTransport,
  type TransportMode,
} from "@/lib/webrtc";
import { pushDebugLog } from "@/components/DebugPanel";

export interface TransferItem {
  id: string;
  type: "text" | "file";
  direction: "sent" | "received";
  name: string;
  size?: number;
  content?: string;
  blob?: Blob;
  progress?: number;
  timestamp: number;
  status: "pending" | "transferring" | "done" | "error";
}

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
  lastSentChunk: number;
  completed: boolean;
}

const CHUNK_SIZE = 256 * 1024; // 256KB — larger chunks for better P2P throughput
const HEADER_SIZE = 40; // 36-byte UUID + 4-byte chunk index

// === TEMPORARY TEST FLAG: set to true to disable WebRTC and force relay-only mode ===
const FORCE_RELAY_MODE = false;
// === END TEMPORARY TEST FLAG ===

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws-signaling`;
}

export function usePeerHost() {
  const [token, setToken] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "waiting" | "connected" | "reconnecting" | "error">("idle");
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
  const wasStartedRef = useRef<boolean>(false);
  const previousStatusRef = useRef<"waiting" | "connected" | null>(null);

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
        console.error(`[Host] Missing chunk ${i} for file ${fileId}`);
        updateItem(fileId, { status: "error", progress: 0 });
        fileChunksRef.current.delete(fileId);
        return;
      }
      orderedChunks.push(chunk);
    }

    const blob = new Blob(orderedChunks, { type: entry.meta.mimeType || "application/octet-stream" });
    if (blob.size !== entry.meta.size) {
      console.error(`[Host] File size mismatch: expected ${entry.meta.size}, got ${blob.size}`);
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

    // Dedup: only count bytes for new chunks (relay resend may send duplicates)
    if (!entry.chunks.has(chunkIndex)) {
      entry.chunks.set(chunkIndex, chunkData);
      entry.received += chunkData.byteLength;
    } else {
      entry.chunks.set(chunkIndex, chunkData);
    }
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
          // If we already have this file (resume scenario), don't re-add item
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
            binaryQueueRef.current = binaryQueueRef.current.then(() => {
              assembleFile(msg.id);
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error("[Host] Error handling data message:", err);
    }
  }, [addItem, processBinaryChunk, assembleFile]);

  /** Initiate WebRTC P2P upgrade after WebSocket connection established */
  const initiateWebRTC = useCallback((ws: WebSocket) => {
    // TEMPORARY: Skip WebRTC when testing relay-only mode
    if (FORCE_RELAY_MODE) {
      pushDebugLog("[P2P] FORCE_RELAY_MODE=true, skipping WebRTC");
      setTransportMode("relay");
      return;
    }
    // Close any existing RTC connection before creating a new one
    if (rtcRef.current) {
      console.log("[Host] Closing existing RTC before re-initiating...");
      rtcRef.current.close();
      rtcRef.current = null;
    }
    console.log("[Host] Initiating WebRTC P2P upgrade...");
    setTransportMode("upgrading");

    const transport = createHostRTC(
      ws,
      // onOpen — DataChannel is ready
      () => {
        rtcRef.current = transport;
        setTransportMode("p2p");
        pushDebugLog("[P2P] DataChannel OPEN — P2P mode active");
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
    for (const [_id, sendState] of Array.from(pendingSendsRef.current.entries())) {
      if (sendState.completed) continue;
      console.log(`[Host] Resuming file send ${sendState.file.name} from chunk ${sendState.lastSentChunk + 1}/${sendState.totalChunks}`);
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

    // Re-send file-meta so receiver knows what's coming
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

    // Track chunks sent via P2P that might be lost if DC crashes
    const p2pSentChunks: number[] = [];
    let dcWasOpen = rtcRef.current?.dataChannel?.readyState === "open";
    let dcCrashDetected = false;

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

      // Back-pressure: wait until buffer drains before sending
      const dcOpen = rtcRef.current?.dataChannel?.readyState === "open";
      const maxBuffer = dcOpen ? 1 * 1024 * 1024 : 512 * 1024; // 1MB for P2P, 512KB for relay
      let bpWaits = 0;
      while (getTransportBufferedAmount(rtcRef.current, ws) > maxBuffer) {
        if (abortController.signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, 5));
        bpWaits++;
        const dcStillOpen = rtcRef.current?.dataChannel?.readyState === "open";
        const wsOpen = ws?.readyState === WebSocket.OPEN;
        if (!dcStillOpen && !wsOpen) {
          pushDebugLog(`[ERR] Both transports dead at resume chunk ${i}/${totalChunks}`);
          sendState.lastSentChunk = i - 1;
          return;
        }
        if (bpWaits % 200 === 0) {
          pushDebugLog(`[WARN] Resume back-pressure wait ${bpWaits} at chunk ${i}, dc=${dcStillOpen ? "open" : "closed"}`);
        }
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
        pushDebugLog(`[RESUME-P2P-CRASH] DataChannel crashed, will resend ${p2pSentChunks.length} chunks via relay`);
      }

      // Yield event loop every 4 chunks to prevent DataChannel buffer overflow
      if (dcOpen && i % 4 === 3) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }

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

    // If DC crashed, resend the chunks that were sent via P2P (they may have been lost)
    if (dcCrashDetected && p2pSentChunks.length > 0 && ws?.readyState === WebSocket.OPEN) {
      pushDebugLog(`[RESUME-RESEND] Resending ${p2pSentChunks.length} chunks via relay`);
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
        sendViaTransport(null, ws, combined);
      }
      pushDebugLog(`[RESUME-RESEND] Done resending ${p2pSentChunks.length} chunks`);
    }

    const completeStr = JSON.stringify({ type: "file-complete", id });
    sendViaTransport(rtcRef.current, ws, completeStr);
    updateItem(id, { progress: 100, status: "done" });
    sendState.completed = true;
    pendingSendsRef.current.delete(id);
    activeSendAbortRef.current = null;

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
        case "registered":
          pushDebugLog(`[WS] Registered token=${msg.token}`);
          reconnectAttemptRef.current = 0;
          // Restore previous status after reconnection
          if (previousStatusRef.current === "connected") {
            // We were connected before, wait for client to reconnect
            setStatus("waiting");
          } else {
            setStatus("waiting");
          }
          setError("");
          break;

        case "connected":
          pushDebugLog(`[WS] Client connected (reconnected=${!!msg.reconnected})`);
          setStatus("connected");
          setError("");
          previousStatusRef.current = "connected";
          // Only start WebRTC if we don't already have an active P2P connection
          if (wsRef.current && (!rtcRef.current || rtcRef.current.dataChannel?.readyState !== "open")) {
            pushDebugLog("[P2P] Initiating WebRTC upgrade...");
            initiateWebRTC(wsRef.current);
          } else {
            pushDebugLog("[P2P] Existing DataChannel still open, skipping re-init");
          }
          // If this is a reconnection, resume pending sends
          if (msg.reconnected) {
            pushDebugLog("[RECONNECT] Resuming pending file sends...");
            resumePendingSends();
          }
          break;

        // WebRTC signaling messages
        case "rtc-answer":
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
            pushDebugLog("[WS] Peer PERMANENTLY disconnected");
            setStatus("waiting");
            previousStatusRef.current = "waiting";
            setTransportMode("relay");
            if (rtcRef.current) {
              rtcRef.current.close();
              rtcRef.current = null;
            }
          } else {
            pushDebugLog(`[WS] Peer temporarily disconnected, DC=${rtcRef.current?.dataChannel?.readyState || "none"}`);
            if (!rtcRef.current?.dataChannel || rtcRef.current.dataChannel.readyState !== "open") {
              setTransportMode("relay");
            } else {
              pushDebugLog("[P2P] DataChannel still open — keeping P2P");
            }
          }
          break;

        case "peer-reconnected":
          pushDebugLog("[WS] Peer reconnected!");
          setStatus("connected");
          setError("");
          // Only re-initiate WebRTC if current P2P is not working
          if (wsRef.current && (!rtcRef.current || rtcRef.current.dataChannel?.readyState !== "open")) {
            initiateWebRTC(wsRef.current);
          }
          // Resume pending sends
          resumePendingSends();
          break;

        case "error":
          setError(msg.message || "Connection error");
          break;

        case "pong":
          break;
      }
    } catch (err) {
      console.error("[Host] Error handling message:", err);
    }
  }, [handleDataMessage, initiateWebRTC, resumePendingSends]);

  /** Attempt to reconnect WebSocket */
  const attemptReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;
    if (!tokenRef.current) return;

    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    pushDebugLog(`[RECONNECT] Attempt ${attempt + 1} in ${delay}ms...`);

    setStatus("reconnecting");

    reconnectTimerRef.current = setTimeout(() => {
      reconnectAttemptRef.current = attempt + 1;

      try {
        const ws = new WebSocket(getWsUrl());
        wsRef.current = ws;

        ws.onopen = () => {
          pushDebugLog(`[RECONNECT] WS reconnected, re-registering token=${tokenRef.current}`);
          ws.send(JSON.stringify({ type: "register", token: tokenRef.current }));
          pingRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping" }));
            }
          }, 15000);
        };

        ws.onmessage = handleWsMessage;

        ws.onclose = () => {
          if (pingRef.current) clearInterval(pingRef.current);
          console.log("[Host] WebSocket closed during reconnection");
          if (!intentionalCloseRef.current && wasStartedRef.current) {
            attemptReconnect();
          }
        };

        ws.onerror = () => {
          console.log("[Host] WebSocket error during reconnection");
        };
      } catch (err) {
        console.error("[Host] Reconnection attempt failed:", err);
        if (!intentionalCloseRef.current) {
          attemptReconnect();
        }
      }
    }, delay);
  }, [handleWsMessage]);

  const startHost = useCallback(() => {
    try {
      const t = String(Math.floor(1000 + Math.random() * 9000));
      setToken(t);
      tokenRef.current = t;
      setStatus("waiting");
      setError("");
      setItems([]);
      setTransportMode("relay");
      fileChunksRef.current.clear();
      pendingSendsRef.current.clear();
      intentionalCloseRef.current = false;
      wasStartedRef.current = true;
      previousStatusRef.current = "waiting";
      reconnectAttemptRef.current = 0;

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", token: t }));
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 15000);
      };

      ws.onmessage = handleWsMessage;

      ws.onclose = () => {
        if (pingRef.current) clearInterval(pingRef.current);
        pushDebugLog("[WS] Connection closed");

        // Auto-reconnect if we didn't intentionally close
        if (!intentionalCloseRef.current && wasStartedRef.current) {
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
        if (!wasStartedRef.current || intentionalCloseRef.current) {
          setError("Connection to server failed");
          setStatus("error");
        }
      };
    } catch (err) {
      setError("Failed to start");
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
    pushDebugLog(`[SEND] Text via ${mode}`);
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

    // Send file metadata
    const metaStr = JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, mimeType: file.type, totalChunks },
    });
    sendViaTransport(rtcRef.current, ws, metaStr);

    // Send file chunks
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

      // Back-pressure: wait until buffer drains before sending
      // CRITICAL: Must yield event loop to let browser update bufferedAmount
      const dcOpen = rtcRef.current?.dataChannel?.readyState === "open";
      const maxBuffer = dcOpen ? 1 * 1024 * 1024 : 512 * 1024; // 1MB for P2P (prevent DC crash), 512KB for relay
      let bpWaits = 0;
      while (getTransportBufferedAmount(rtcRef.current, ws) > maxBuffer) {
        if (abortController.signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, 5)); // Short yield for P2P
        bpWaits++;
        // Check if both transports are dead
        const dcStillOpen = rtcRef.current?.dataChannel?.readyState === "open";
        const wsOpen = ws?.readyState === WebSocket.OPEN;
        if (!dcStillOpen && !wsOpen) {
          pushDebugLog(`[ERR] Both transports dead at chunk ${i}/${totalChunks}`);
          sendState.lastSentChunk = i - 1;
          return;
        }
        if (bpWaits % 200 === 0) {
          pushDebugLog(`[WARN] Back-pressure wait ${bpWaits} at chunk ${i}, buf=${(getTransportBufferedAmount(rtcRef.current, ws) / 1024).toFixed(0)}KB, dc=${dcStillOpen ? "open" : "closed"}`);
        }
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

      // Yield event loop every 4 chunks to prevent DataChannel buffer overflow
      // This gives the browser time to flush data and update bufferedAmount
      if (dcOpen && i % 4 === 3) {
        await new Promise(resolve => setTimeout(resolve, 0));
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

        // Back-pressure for relay resend
        while (getTransportBufferedAmount(null, ws) > 512 * 1024) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        sendViaTransport(null, ws, combined); // Force relay (pass null for rtc)
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
    setToken("");
    setItems([]);
    setTransportMode("relay");
    fileChunksRef.current.clear();
    pendingSendsRef.current.clear();
    tokenRef.current = "";
    wasStartedRef.current = false;
    previousStatusRef.current = null;
    reconnectAttemptRef.current = 0;
  }, []);

  return { token, status, items, error, transportMode, startHost, sendText, sendFile, disconnect };
}
