/**
 * usePeerHost — PC端（Host）使用 WebSocket 中继
 * 
 * No WebRTC — all data flows through the WebSocket relay server.
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

const CHUNK_SIZE = 64 * 1024; // 64KB

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
  const fileChunksRef = useRef<Map<string, { meta: FileChunkMeta; chunks: ArrayBuffer[]; received: number }>>(new Map());
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addItem = useCallback((item: TransferItem) => {
    setItems(prev => [item, ...prev]);
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<TransferItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const handleWsMessage = useCallback((event: MessageEvent) => {
    try {
      // Binary data — file chunk
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buffer => {
          const decoder = new TextDecoder();
          const idBytes = new Uint8Array(buffer, 0, 36);
          const fileId = decoder.decode(idBytes);
          const chunkData = buffer.slice(36);

          const entry = fileChunksRef.current.get(fileId);
          if (entry) {
            entry.chunks.push(chunkData);
            entry.received += chunkData.byteLength;
            const progress = Math.min(99, Math.round((entry.received / entry.meta.size) * 100));
            updateItem(fileId, { progress, status: "transferring" });
          }
        });
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
          fileChunksRef.current.set(meta.id, { meta, chunks: [], received: 0 });
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
            const blob = new Blob(entry.chunks, { type: entry.meta.mimeType || "application/octet-stream" });
            updateItem(msg.id, { progress: 100, status: "done", blob });
            fileChunksRef.current.delete(msg.id);
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
  }, [addItem, updateItem]);

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

    // Send file chunks as binary with id prefix
    const buffer = await file.arrayBuffer();

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = buffer.slice(start, end);

      const idBytes = new TextEncoder().encode(id);
      const combined = new ArrayBuffer(36 + chunk.byteLength);
      const view = new Uint8Array(combined);
      view.set(idBytes, 0);
      view.set(new Uint8Array(chunk), 36);

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
