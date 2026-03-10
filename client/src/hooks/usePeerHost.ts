/**
 * usePeerHost — PC端（Host）使用 BroadcastChannel 信令 + WebRTC
 * 
 * 由于这是纯静态站点，无法运行 WebSocket 服务端。
 * 方案：使用 BroadcastChannel 作为同源跨标签页信令，
 * 然后通过 WebRTC DataChannel 进行数据传输。
 * 
 * 对于真正的跨设备场景（手机和电脑不在同一浏览器），
 * 需要一个外部信令服务器。这里我们提供两种模式：
 * 1. BroadcastChannel 模式（同设备测试）
 * 2. 手动信令模式（通过复制粘贴 SDP）
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
  type: string;
  totalChunks: number;
}

const CHUNK_SIZE = 64 * 1024; // 64KB
const CHANNEL_PREFIX = "lan-transfer-";

export function usePeerHost() {
  const [token, setToken] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "waiting" | "connected" | "error">("idle");
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

  const startHost = useCallback(async () => {
    try {
      // Generate 4-digit token
      const t = String(Math.floor(1000 + Math.random() * 9000));
      setToken(t);
      setStatus("waiting");
      setError("");

      // Create BroadcastChannel for signaling
      const bc = new BroadcastChannel(CHANNEL_PREFIX + t);
      bcRef.current = bc;

      bc.onmessage = async (event) => {
        const msg = event.data;

        if (msg.type === "join") {
          // Client wants to connect — create WebRTC peer
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
            ],
          });
          peerRef.current = pc;

          const dataChannel = pc.createDataChannel("transfer", { ordered: true });
          dataChannel.binaryType = "arraybuffer";
          channelRef.current = dataChannel;
          
          dataChannel.onopen = () => {
            setStatus("connected");
            setError("");
          };
          dataChannel.onclose = () => {
            setStatus("waiting");
          };
          dataChannel.onmessage = handleDataChannelMessage;

          pc.onicecandidate = (e) => {
            if (e.candidate) {
              bc.postMessage({ type: "ice-candidate", candidate: e.candidate, from: "host" });
            }
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          bc.postMessage({ type: "offer", sdp: pc.localDescription });
        } else if (msg.type === "answer") {
          await peerRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === "ice-candidate" && msg.from === "client") {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };
    } catch (err) {
      setError("Failed to start");
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
    bcRef.current?.close();
    channelRef.current = null;
    peerRef.current = null;
    bcRef.current = null;
    setStatus("idle");
    setToken("");
    setItems([]);
  }, []);

  return {
    token,
    status,
    items,
    error,
    startHost,
    sendText,
    sendFile,
    disconnect,
  };
}
