/**
 * WebRTC DataChannel transport layer for Quick Transfer
 * 
 * This module handles:
 * 1. Creating RTCPeerConnection with STUN servers
 * 2. SDP offer/answer exchange via WebSocket signaling
 * 3. ICE candidate exchange via WebSocket signaling
 * 4. DataChannel creation and management
 * 5. Connection state monitoring
 * 
 * Usage:
 * - Host creates offer, client creates answer
 * - Both sides exchange ICE candidates through WebSocket
 * - Once DataChannel is open, data flows P2P (fast on LAN)
 * - If WebRTC fails within timeout, caller falls back to WebSocket relay
 */

// Public STUN servers for NAT traversal
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

const RTC_TIMEOUT_MS = 6000; // 6 seconds to establish WebRTC

export type TransportMode = "p2p" | "relay" | "upgrading";

export interface WebRTCTransport {
  /** The RTCPeerConnection instance */
  pc: RTCPeerConnection;
  /** The DataChannel for sending/receiving data */
  dataChannel: RTCDataChannel | null;
  /** Current transport mode */
  mode: TransportMode;
  /** Close and clean up */
  close: () => void;
}

/**
 * Create a WebRTC connection as the host (offerer).
 * 
 * Flow:
 * 1. Create RTCPeerConnection
 * 2. Create DataChannel
 * 3. Create SDP offer → send via WebSocket
 * 4. Receive SDP answer from client via WebSocket
 * 5. Exchange ICE candidates via WebSocket
 * 6. DataChannel opens → P2P ready
 * 
 * @param ws - WebSocket for signaling
 * @param onOpen - Called when DataChannel is ready
 * @param onMessage - Called when data arrives on DataChannel
 * @param onClose - Called when DataChannel/connection closes
 * @param onFail - Called when WebRTC setup fails (timeout or error)
 * @returns WebRTCTransport object
 */
export function createHostRTC(
  ws: WebSocket,
  onOpen: () => void,
  onMessage: (event: MessageEvent) => void,
  onClose: () => void,
  onFail: () => void,
): WebRTCTransport {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  let transport: WebRTCTransport = { pc, dataChannel: null, mode: "upgrading", close: () => {} };
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  // Create DataChannel (host is the offerer, so host creates the channel)
  const dc = pc.createDataChannel("transfer", {
    ordered: true,
    // Use default reliable mode (no maxRetransmits/maxPacketLifeTime)
  });
  dc.binaryType = "arraybuffer";
  transport.dataChannel = dc;

  dc.onopen = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    transport.mode = "p2p";
    console.log("[WebRTC Host] DataChannel open — P2P mode active");
    onOpen();
  };

  dc.onmessage = onMessage;

  dc.onclose = () => {
    console.log("[WebRTC Host] DataChannel closed");
    if (transport.mode === "p2p") {
      transport.mode = "relay";
      onClose();
    }
  };

  dc.onerror = (e) => {
    console.error("[WebRTC Host] DataChannel error:", e);
  };

  // Send ICE candidates to client via WebSocket
  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "rtc-ice",
        candidate: event.candidate.toJSON(),
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log("[WebRTC Host] Connection state:", pc.connectionState);
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        onFail();
      } else if (transport.mode === "p2p") {
        transport.mode = "relay";
        onClose();
      }
    }
  };

  // Create offer
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "rtc-offer",
          sdp: pc.localDescription,
        }));
        console.log("[WebRTC Host] Sent SDP offer");
      }
    })
    .catch((err) => {
      console.error("[WebRTC Host] Failed to create offer:", err);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        onFail();
      }
    });

  // Timeout: if DataChannel doesn't open in time, fall back
  timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      console.log("[WebRTC Host] Timeout — falling back to relay");
      transport.mode = "relay";
      onFail();
    }
  }, RTC_TIMEOUT_MS);

  transport.close = () => {
    settled = true;
    clearTimeout(timeoutId);
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
  };

  return transport;
}

/**
 * Create a WebRTC connection as the client (answerer).
 * 
 * Flow:
 * 1. Receive SDP offer from host via WebSocket
 * 2. Create RTCPeerConnection
 * 3. Set remote description (offer)
 * 4. Create SDP answer → send via WebSocket
 * 5. Exchange ICE candidates via WebSocket
 * 6. DataChannel arrives via ondatachannel → P2P ready
 * 
 * @param ws - WebSocket for signaling
 * @param offer - SDP offer from host
 * @param onOpen - Called when DataChannel is ready
 * @param onMessage - Called when data arrives on DataChannel
 * @param onClose - Called when DataChannel/connection closes
 * @param onFail - Called when WebRTC setup fails (timeout or error)
 * @returns WebRTCTransport object
 */
export function createClientRTC(
  ws: WebSocket,
  offer: RTCSessionDescriptionInit,
  onOpen: () => void,
  onMessage: (event: MessageEvent) => void,
  onClose: () => void,
  onFail: () => void,
): WebRTCTransport {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  let transport: WebRTCTransport = { pc, dataChannel: null, mode: "upgrading", close: () => {} };
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  // Client receives DataChannel from host
  pc.ondatachannel = (event) => {
    const dc = event.channel;
    dc.binaryType = "arraybuffer";
    transport.dataChannel = dc;

    dc.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      transport.mode = "p2p";
      console.log("[WebRTC Client] DataChannel open — P2P mode active");
      onOpen();
    };

    dc.onmessage = onMessage;

    dc.onclose = () => {
      console.log("[WebRTC Client] DataChannel closed");
      if (transport.mode === "p2p") {
        transport.mode = "relay";
        onClose();
      }
    };

    dc.onerror = (e) => {
      console.error("[WebRTC Client] DataChannel error:", e);
    };
  };

  // Send ICE candidates to host via WebSocket
  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "rtc-ice",
        candidate: event.candidate.toJSON(),
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log("[WebRTC Client] Connection state:", pc.connectionState);
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        onFail();
      } else if (transport.mode === "p2p") {
        transport.mode = "relay";
        onClose();
      }
    }
  };

  // Set remote offer and create answer
  pc.setRemoteDescription(new RTCSessionDescription(offer))
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "rtc-answer",
          sdp: pc.localDescription,
        }));
        console.log("[WebRTC Client] Sent SDP answer");
      }
    })
    .catch((err) => {
      console.error("[WebRTC Client] Failed to create answer:", err);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        onFail();
      }
    });

  // Timeout
  timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      console.log("[WebRTC Client] Timeout — falling back to relay");
      transport.mode = "relay";
      onFail();
    }
  }, RTC_TIMEOUT_MS);

  transport.close = () => {
    settled = true;
    clearTimeout(timeoutId);
    try {
      if (transport.dataChannel) transport.dataChannel.close();
    } catch {}
    try { pc.close(); } catch {}
  };

  return transport;
}

/**
 * Handle incoming WebRTC signaling messages on an existing transport.
 * Call this from the WebSocket message handler for rtc-answer and rtc-ice messages.
 */
export function handleRTCSignaling(
  transport: WebRTCTransport | null,
  msg: { type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
): void {
  if (!transport) return;
  const { pc } = transport;

  if (msg.type === "rtc-answer" && msg.sdp) {
    pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      .then(() => console.log("[WebRTC] Set remote answer"))
      .catch((err) => console.error("[WebRTC] Failed to set remote answer:", err));
  }

  if (msg.type === "rtc-ice" && msg.candidate) {
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      .catch((err) => console.error("[WebRTC] Failed to add ICE candidate:", err));
  }
}

/**
 * Send data through the best available channel.
 * Prefers DataChannel (P2P) if open, falls back to WebSocket (relay).
 * 
 * @returns "p2p" if sent via DataChannel, "relay" if sent via WebSocket
 */
export function sendViaTransport(
  transport: WebRTCTransport | null,
  ws: WebSocket | null,
  data: string | ArrayBuffer,
): TransportMode {
  // Try DataChannel first
  if (
    transport?.dataChannel &&
    transport.dataChannel.readyState === "open" &&
    transport.mode === "p2p"
  ) {
    try {
      transport.dataChannel.send(data as any);
      return "p2p";
    } catch (err) {
      console.warn("[Transport] DataChannel send failed, falling back to relay:", err);
    }
  }

  // Fallback to WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return "relay";
  }

  return "relay";
}

/**
 * Check the buffered amount of the active transport channel.
 * Used for back-pressure during file transfers.
 */
export function getTransportBufferedAmount(
  transport: WebRTCTransport | null,
  ws: WebSocket | null,
): number {
  if (
    transport?.dataChannel &&
    transport.dataChannel.readyState === "open" &&
    transport.mode === "p2p"
  ) {
    return transport.dataChannel.bufferedAmount;
  }
  if (ws) {
    return ws.bufferedAmount;
  }
  return 0;
}
