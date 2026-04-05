/**
 * usePeerHost — PC端（Host）使用 WebSocket 中继
 * 
 * No WebRTC — all data flows through the WebSocket relay server.
 * 
 * File transfer protocol:
 * 1. Sender sends file-meta JSON with { id, name, size, mimeType, totalChunks }
 * 2. Sender sends binary chunks: [36-byte UUID][4-byte chunk index (big-endian)][chunk data]
 * 3. Sender sends file-complete JSON with { id }
 * 4. Receiver assembles chunks IN ORDER by chunk index, verifies total size matches
 */

import { useCallback, useRef, useState } from "react";

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
  chunks: Map<number, ArrayBuffer>; // indexed by chunk number for ordered assembly
  received: number; // total bytes received
  pendingComplete: boolean; // file-complete signal received before all chunks processed
}

const CHUNK_SIZE = 64 * 1024; // 64KB
const HEADER_SIZE = 40; // 36-byte UUID + 4-byte chunk index

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/ws-signaling`;
}

export function usePeerHost() {
  const [token, setToken] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "waiting" | "connected" | "error">("idle");
  const [items, setItems] = useState<TransferItem[]>([]);
  const [error, setError] = useState<string>("");

  const wsRef = useRef<WebSocket | null>(null);
  const fileChunksRef = useRef<Map<string, FileReceiveState>>(new Map());
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Queue for processing binary messages sequentially
  const binaryQueueRef = useRef<Promise<void>>(Promise.resolve());

  const addItem = useCallback((item: TransferItem) => {
    setItems(prev => [item, ...prev]);
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<TransferItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const assembleFile = useCallback((fileId: string) => {
    const entry = fileChunksRef.current.get(fileId);
    if (!entry) return;

    // Check if all bytes received
    if (entry.received < entry.meta.size) return;

    // Assemble chunks in order
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

    // Verify size
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

    // Read chunk index (4 bytes, big-endian uint32)
    const indexView = new DataView(buffer, 36, 4);
    const chunkIndex = indexView.getUint32(0, false); // big-endian

    const chunkData = buffer.slice(HEADER_SIZE);

    const entry = fileChunksRef.current.get(fileId);
    if (!entry) return;

    entry.chunks.set(chunkIndex, chunkData);
    entry.received += chunkData.byteLength;
    const progress = Math.min(99, Math.round((entry.received / entry.meta.size) * 100));
    updateItem(fileId, { progress, status: "transferring" });

    // If file-complete was already received and all bytes are here, assemble
    if (entry.pendingComplete && entry.received >= entry.meta.size) {
      assembleFile(fileId);
    }
  }, [updateItem, assembleFile]);

  const handleWsMessage = useCallback((event: MessageEvent) => {
    try {
      // Binary data — file chunk, process sequentially via queue
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
        case "registered":
          console.log("[Host] Registered with token:", msg.token);
          break;

        case "connected":
          setStatus("connected");
          setError("");
          break;

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
            // Process after current binary queue drains
            binaryQueueRef.current = binaryQueueRef.current.then(() => {
              assembleFile(msg.id);
            });
          }
          break;
        }

        case "peer-disconnected":
          setStatus("waiting");
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
  }, [addItem, updateItem, processBinaryChunk, assembleFile]);

  const startHost = useCallback(() => {
    try {
      const t = String(Math.floor(1000 + Math.random() * 9000));
      setToken(t);
      setStatus("waiting");
      setError("");
      setItems([]);
      fileChunksRef.current.clear();

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", token: t }));
        // Keep-alive ping every 25 seconds
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 25000);
      };

      ws.onmessage = handleWsMessage;

      ws.onclose = () => {
        if (pingRef.current) clearInterval(pingRef.current);
        console.log("[Host] WebSocket closed");
      };

      ws.onerror = () => {
        setError("Connection to server failed");
        setStatus("error");
      };
    } catch (err) {
      setError("Failed to start");
      setStatus("error");
      console.error(err);
    }
  }, [handleWsMessage]);

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    ws.send(JSON.stringify({ type: "text", content: text }));
    addItem({
      id,
      type: "text",
      direction: "sent",
      name: "Text Message",
      content: text,
      timestamp: Date.now(),
      status: "done",
    });
  }, [addItem]);

  const sendFile = useCallback(async (file: File) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const id = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

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
    ws.send(JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, mimeType: file.type, totalChunks },
    }));

    // Send file chunks as binary: [36-byte UUID][4-byte chunk index][chunk data]
    const buffer = await file.arrayBuffer();

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = buffer.slice(start, end);

      const idBytes = new TextEncoder().encode(id);
      const combined = new ArrayBuffer(HEADER_SIZE + chunk.byteLength);
      const view = new Uint8Array(combined);
      view.set(idBytes, 0);
      // Write chunk index as 4-byte big-endian uint32
      const indexView = new DataView(combined, 36, 4);
      indexView.setUint32(0, i, false); // big-endian
      view.set(new Uint8Array(chunk), HEADER_SIZE);

      // Back-pressure: wait if buffer is full
      while (ws.bufferedAmount > 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      ws.send(combined);

      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });
    }

    // Send completion signal
    ws.send(JSON.stringify({ type: "file-complete", id }));
    updateItem(id, { progress: 100, status: "done" });
  }, [addItem, updateItem]);

  const disconnect = useCallback(() => {
    if (pingRef.current) clearInterval(pingRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("idle");
    setToken("");
    setItems([]);
    fileChunksRef.current.clear();
  }, []);

  return { token, status, items, error, startHost, sendText, sendFile, disconnect };
}
