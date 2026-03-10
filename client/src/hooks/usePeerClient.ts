/**
 * usePeerClient — 手机端（Client）使用 WebSocket 信令服务器 + WebRTC
 */

import { useCallback, useRef, useState } from "react";
import type { TransferItem } from "./usePeerHost";

interface FileChunkMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
}

const CHUNK_SIZE = 64 * 1024;

function getSignalingUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/api/ws-signaling`;
}

export function usePeerClient() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [items, setItems] = useState<TransferItem[]>([]);
  const [error, setError] = useState<string>("");

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fileChunksRef = useRef<Map<string, { meta: FileChunkMeta; chunks: ArrayBuffer[]; received: number }>>(new Map());

  const addItem = useCallback((item: TransferItem) => {
    setItems(prev => [item, ...prev]);
  }, []);

  const updateItem = useCallback((id: string, updates: Partial<TransferItem>) => {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const handleDataChannelMessage = useCallback((event: MessageEvent) => {
    try {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        
        if (msg.type === "text") {
          addItem({
            id: crypto.randomUUID(),
            type: "text",
            direction: "received",
            name: "Text Message",
            content: msg.content,
            timestamp: Date.now(),
            status: "done",
          });
        } else if (msg.type === "file-meta") {
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
        } else if (msg.type === "file-complete") {
          const entry = fileChunksRef.current.get(msg.id);
          if (entry) {
            const blob = new Blob(entry.chunks, { type: entry.meta.type || "application/octet-stream" });
            updateItem(msg.id, { progress: 100, status: "done", blob });
            fileChunksRef.current.delete(msg.id);
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        const decoder = new TextDecoder();
        const idBytes = new Uint8Array(event.data, 0, 36);
        const fileId = decoder.decode(idBytes);
        const chunkData = event.data.slice(36);
        
        const entry = fileChunksRef.current.get(fileId);
        if (entry) {
          entry.chunks.push(chunkData);
          entry.received += chunkData.byteLength;
          const progress = Math.min(99, Math.round((entry.received / entry.meta.size) * 100));
          updateItem(fileId, { progress, status: "transferring" });
        }
      }
    } catch (err) {
      console.error("Error handling message:", err);
    }
  }, [addItem, updateItem]);

  const connect = useCallback(async (inputToken: string) => {
    try {
      setStatus("connecting");
      setError("");

      const ws = new WebSocket(getSignalingUrl());
      wsRef.current = ws;

      // Connection timeout
      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close();
        }
        setError("Connection timed out. Make sure the PC has the page open.");
        setStatus("error");
      }, 15000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", token: inputToken }));
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          switch (msg.type) {
            case "joined":
              console.log("[Client] Joined room, waiting for offer...");
              break;

            case "offer": {
              clearTimeout(timeout);
              console.log("[Client] Received offer, creating answer...");

              const pc = new RTCPeerConnection({
                iceServers: [
                  { urls: "stun:stun.l.google.com:19302" },
                  { urls: "stun:stun1.l.google.com:19302" },
                ],
              });
              peerRef.current = pc;

              pc.ondatachannel = (e) => {
                const channel = e.channel;
                channelRef.current = channel;
                channel.binaryType = "arraybuffer";

                channel.onopen = () => {
                  setStatus("connected");
                  setError("");
                };
                channel.onclose = () => {
                  setStatus("idle");
                };
                channel.onmessage = handleDataChannelMessage;
              };

              pc.onicecandidate = (e) => {
                if (e.candidate && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate }));
                }
              };

              pc.onconnectionstatechange = () => {
                if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                  setStatus("idle");
                }
              };

              await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              ws.send(JSON.stringify({ type: "answer", sdp: pc.localDescription }));
              break;
            }

            case "ice-candidate": {
              if (peerRef.current && msg.candidate) {
                await peerRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
              }
              break;
            }

            case "host-disconnected": {
              clearTimeout(timeout);
              channelRef.current?.close();
              peerRef.current?.close();
              channelRef.current = null;
              peerRef.current = null;
              setStatus("idle");
              setError("Host disconnected");
              break;
            }

            case "error": {
              clearTimeout(timeout);
              setError(msg.message || "Connection error");
              setStatus("error");
              break;
            }
          }
        } catch (err) {
          console.error("[Client] Error processing message:", err);
        }
      };

      ws.onclose = () => {
        console.log("[Client] WebSocket closed");
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        setError("Connection to signaling server failed");
        setStatus("error");
      };
    } catch (err) {
      setError("Failed to connect");
      setStatus("error");
      console.error(err);
    }
  }, [handleDataChannelMessage]);

  const sendText = useCallback((text: string) => {
    if (!channelRef.current || channelRef.current.readyState !== "open") return;
    
    const id = crypto.randomUUID();
    channelRef.current.send(JSON.stringify({ type: "text", content: text }));
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
    if (!channelRef.current || channelRef.current.readyState !== "open") return;
    
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

    channelRef.current.send(JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, type: file.type, totalChunks },
    }));

    const channel = channelRef.current;
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
      
      while (channel.bufferedAmount > 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      channel.send(combined);
      
      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });
    }

    channel.send(JSON.stringify({ type: "file-complete", id }));
    updateItem(id, { progress: 100, status: "done" });
  }, [addItem, updateItem]);

  const disconnect = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    wsRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
    wsRef.current = null;
    setStatus("idle");
    setItems([]);
  }, []);

  return {
    status,
    items,
    error,
    connect,
    sendText,
    sendFile,
    disconnect,
  };
}
