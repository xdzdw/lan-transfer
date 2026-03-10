/**
 * usePeerClient — 手机端（Client）使用 BroadcastChannel 信令 + WebRTC
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
const CHANNEL_PREFIX = "lan-transfer-";

export function usePeerClient() {
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [items, setItems] = useState<TransferItem[]>([]);
  const [error, setError] = useState<string>("");

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
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

      const bc = new BroadcastChannel(CHANNEL_PREFIX + inputToken);
      bcRef.current = bc;

      // Set up a timeout for connection
      const timeout = setTimeout(() => {
        if (status === "connecting") {
          setError("No host found with this token. Make sure both devices have the same page open.");
          setStatus("error");
          bc.close();
        }
      }, 10000);

      bc.onmessage = async (event) => {
        const msg = event.data;

        if (msg.type === "offer") {
          clearTimeout(timeout);
          
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
            if (e.candidate) {
              bc.postMessage({ type: "ice-candidate", candidate: e.candidate, from: "client" });
            }
          };

          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          bc.postMessage({ type: "answer", sdp: pc.localDescription });
        } else if (msg.type === "ice-candidate" && msg.from === "host") {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };

      // Tell host we want to join
      bc.postMessage({ type: "join" });
    } catch (err) {
      setError("Failed to connect");
      setStatus("error");
      console.error(err);
    }
  }, [handleDataChannelMessage, status]);

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
    bcRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
    bcRef.current = null;
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
