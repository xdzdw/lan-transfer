/**
 * useWebRTCClient — 手机端（Client）逻辑
 * 
 * 手机端输入4位令牌后，通过信令服务器找到PC端，
 * 然后通过 WebRTC DataChannel 建立点对点连接进行数据传输。
 */

import { useCallback, useRef, useState } from "react";
import type { TransferItem } from "./useWebRTCHost";

interface FileChunkMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  totalChunks: number;
}

const CHUNK_SIZE = 64 * 1024;

export function useWebRTCClient() {
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
      console.error("Error handling data channel message:", err);
    }
  }, [addItem, updateItem]);

  const connect = useCallback(async (signalingUrl: string, token: string) => {
    try {
      setStatus("connecting");
      setError("");

      const ws = new WebSocket(signalingUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", token, role: "client" }));
      };

      ws.onerror = () => {
        setError("Cannot connect to signaling server");
        setStatus("error");
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "error") {
          setError(msg.message || "Connection failed");
          setStatus("error");
          return;
        }

        if (msg.type === "offer") {
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
            
            channel.onerror = (err) => {
              console.error("DataChannel error:", err);
              setError("Connection error");
            };
            
            channel.onmessage = handleDataChannelMessage;
          };

          pc.onicecandidate = (e) => {
            if (e.candidate) {
              ws.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate, token }));
            }
          };

          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ws.send(JSON.stringify({ type: "answer", sdp: answer, token }));
        } else if (msg.type === "ice-candidate") {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
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
