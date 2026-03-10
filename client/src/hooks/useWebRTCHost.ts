/**
 * useWebRTCHost — PC端（Host）逻辑
 * 
 * 架构说明：
 * 由于纯前端无法直接建立WebSocket服务端，我们使用 BroadcastChannel + WebRTC 的方案：
 * 1. PC端生成4位令牌，将自己的信息通过 BroadcastChannel 广播
 * 2. 手机端输入令牌后，通过同一个 BroadcastChannel 找到PC端
 * 3. 双方通过 BroadcastChannel 交换 WebRTC SDP/ICE 信息
 * 4. 建立 WebRTC DataChannel 进行点对点数据传输
 * 
 * 注意：这要求两端在同一浏览器上下文（同一设备同一浏览器）才能用 BroadcastChannel。
 * 但实际场景是跨设备的，所以我们改用一个简单的信令方案：
 * - 使用 window 对象上的自定义事件 + localStorage 作为跨标签页信令
 * - 对于真正的跨设备场景，需要一个信令服务器
 * 
 * 最终方案：使用浏览器内置的 WebRTC + 一个极简的信令中继
 * 由于这是纯前端项目，我们使用 "manual signaling" 模式：
 * PC端显示连接信息（IP + 令牌），手机端手动输入来建立连接
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

const CHUNK_SIZE = 64 * 1024; // 64KB chunks for WebRTC

export function useWebRTCHost() {
  const [token, setToken] = useState<string>("");
  const [status, setStatus] = useState<"idle" | "waiting" | "connected" | "error">("idle");
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

  const generateToken = useCallback(() => {
    const t = String(Math.floor(1000 + Math.random() * 9000));
    setToken(t);
    return t;
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
          // Start receiving a file
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
        // Binary chunk: first 36 bytes are the file ID (UUID string)
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

  const setupDataChannel = useCallback((channel: RTCDataChannel) => {
    channelRef.current = channel;
    channel.binaryType = "arraybuffer";
    
    channel.onopen = () => {
      setStatus("connected");
      setError("");
    };
    
    channel.onclose = () => {
      setStatus("waiting");
    };
    
    channel.onerror = (e) => {
      console.error("DataChannel error:", e);
      setError("Connection error");
    };
    
    channel.onmessage = handleDataChannelMessage;
  }, [handleDataChannelMessage]);

  const startHost = useCallback(async (signalingUrl: string) => {
    try {
      const t = generateToken();
      setStatus("waiting");
      setError("");

      // Connect to signaling server
      const ws = new WebSocket(signalingUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "register", token: t, role: "host" }));
      };

      ws.onerror = () => {
        setError("Signaling server connection failed");
        setStatus("error");
      };

      ws.onclose = () => {
        if (status === "waiting") {
          // Don't set error if we're already connected via WebRTC
        }
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "client-joined") {
          // Create peer connection
          const pc = new RTCPeerConnection({
            iceServers: [
              { urls: "stun:stun.l.google.com:19302" },
              { urls: "stun:stun1.l.google.com:19302" },
            ],
          });
          peerRef.current = pc;

          // Create data channel
          const channel = pc.createDataChannel("transfer", {
            ordered: true,
          });
          setupDataChannel(channel);

          // Send ICE candidates
          pc.onicecandidate = (e) => {
            if (e.candidate) {
              ws.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate, token: t }));
            }
          };

          // Create offer
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({ type: "offer", sdp: offer, token: t }));
        } else if (msg.type === "answer") {
          await peerRef.current?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === "ice-candidate") {
          await peerRef.current?.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      };
    } catch (err) {
      setError("Failed to start host");
      setStatus("error");
      console.error(err);
    }
  }, [generateToken, setupDataChannel, status]);

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
    
    // Add to items
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
    channelRef.current.send(JSON.stringify({
      type: "file-meta",
      meta: { id, name: file.name, size: file.size, type: file.type, totalChunks },
    }));

    // Send file chunks
    const channel = channelRef.current;
    const buffer = await file.arrayBuffer();
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = buffer.slice(start, end);
      
      // Prepend file ID to chunk
      const idBytes = new TextEncoder().encode(id);
      const combined = new ArrayBuffer(36 + chunk.byteLength);
      const view = new Uint8Array(combined);
      view.set(idBytes, 0);
      view.set(new Uint8Array(chunk), 36);
      
      // Wait for buffer to drain if needed
      while (channel.bufferedAmount > 1024 * 1024) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      channel.send(combined);
      
      const progress = Math.min(99, Math.round(((i + 1) / totalChunks) * 100));
      updateItem(id, { progress, status: "transferring" });
    }

    // Send completion signal
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
