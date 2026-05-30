/**
 * WebRTC DataChannel transport layer for Quick Transfer
 * 
 * This module handles:
 * 1. Creating RTCPeerConnection with STUN servers (China-accessible)
 * 2. SDP offer/answer exchange via WebSocket signaling
 * 3. ICE candidate exchange via WebSocket signaling (with buffering)
 * 4. DataChannel creation and management
 * 5. Connection state monitoring with stability (no premature fallback)
 * 
 * Key stability improvements:
 * - "disconnected" state is TEMPORARY — we wait before falling back
 * - Only "failed" triggers immediate fallback
 * - Once P2P is established, we don't flip back to relay on transient issues
 * - sendViaTransport locks to a channel for the duration of a transfer
 * - ICE candidates are buffered until remote description is set
 */

import { pushDebugLog } from "@/components/DebugPanel";

// STUN + TURN servers
// TURN is critical: browsers use mDNS for host candidates (privacy),
// which cannot be resolved cross-device. TURN provides relay candidates
// that bypass this limitation entirely.
const ICE_SERVERS: RTCIceServer[] = [
  // STUN — Google primary
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // TURN — Open Relay Project (free, ports 80/443 bypass firewalls)
  // Docs: https://www.metered.ca/tools/openrelay/
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:80?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turns:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

const RTC_TIMEOUT_MS = 15000; // 15 seconds to establish WebRTC (increased for slow STUN)
const DISCONNECT_GRACE_MS = 10000; // 10 seconds grace period for "disconnected" state

export type TransportMode = "p2p" | "relay" | "upgrading";

export interface WebRTCTransport {
  /** The RTCPeerConnection instance */
  pc: RTCPeerConnection;
  /** The DataChannel for sending/receiving data */
  dataChannel: RTCDataChannel | null;
  /** Current transport mode */
  mode: TransportMode;
  /** Whether P2P was ever successfully established (sticky) */
  wasP2P: boolean;
  /** Close and clean up */
  close: () => void;
  /** Whether remote description has been set (for ICE candidate buffering) */
  remoteDescriptionSet?: boolean;
  /** Buffered ICE candidates received before remote description was set */
  pendingCandidates?: RTCIceCandidateInit[];
}

/**
 * Create a WebRTC connection as the host (offerer).
 * 
 * @param ws - WebSocket for signaling
 * @param onOpen - Called when DataChannel is ready
 * @param onMessage - Called when data arrives on DataChannel
 * @param onClose - Called when DataChannel/connection is permanently lost
 * @param onFail - Called when WebRTC setup fails (timeout or error)
 */
export function createHostRTC(
  ws: WebSocket,
  onOpen: () => void,
  onMessage: (event: MessageEvent) => void,
  onClose: () => void,
  onFail: () => void,
): WebRTCTransport {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  let transport: WebRTCTransport = {
    pc, dataChannel: null, mode: "upgrading", wasP2P: false, close: () => {},
    remoteDescriptionSet: false,
    pendingCandidates: [],
  };
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  let disconnectTimerId: ReturnType<typeof setTimeout> | null = null;

  // Create DataChannel (host is the offerer, so host creates the channel)
  const dc = pc.createDataChannel("transfer", {
    ordered: true,
    // Use default reliable mode (no maxRetransmits/maxPacketLifeTime)
  });
  dc.binaryType = "arraybuffer";
  // Set bufferedAmountLowThreshold for efficient back-pressure
  dc.bufferedAmountLowThreshold = 256 * 1024; // 256KB — triggers onbufferedamountlow event
  transport.dataChannel = dc;

  dc.onopen = () => {
    if (settled && !transport.wasP2P) return; // Only ignore if never was P2P
    settled = true;
    clearTimeout(timeoutId);
    if (disconnectTimerId) {
      clearTimeout(disconnectTimerId);
      disconnectTimerId = null;
    }
    transport.mode = "p2p";
    transport.wasP2P = true;
    console.log("[WebRTC Host] DataChannel open — P2P mode active");
    // Log ICE candidate pair info for debugging
    logSelectedCandidatePair(pc, "Host");
    onOpen();
  };

  dc.onmessage = onMessage;

  dc.onclose = () => {
    const bufAmt = dc.bufferedAmount;
    pushDebugLog(`[DC-CLOSE] Host DataChannel closed | buf=${(bufAmt / 1024).toFixed(0)}KB | pcState=${pc.connectionState}`);
    console.log("[WebRTC Host] DataChannel closed");
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (transport.mode === "p2p") {
        transport.mode = "relay";
        onClose();
      }
    }
  };

  dc.onerror = (e: Event) => {
    const rtcErr = e as RTCErrorEvent;
    const errDetail = rtcErr.error ? `${rtcErr.error.errorDetail}: ${rtcErr.error.message}` : "unknown";
    const bufAmt = dc.bufferedAmount;
    pushDebugLog(`[DC-ERR] Host DataChannel error: ${errDetail} | buf=${(bufAmt / 1024).toFixed(0)}KB | state=${dc.readyState}`);
    console.error("[WebRTC Host] DataChannel error:", e);
  };

  // Send ICE candidates to client via WebSocket + log each candidate for diagnosis
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate;
      pushDebugLog(`[ICE-CAND] Host local: type=${c.type} addr=${c.address}:${c.port} proto=${c.protocol} raddr=${c.relatedAddress || "-"}:${c.relatedPort || "-"}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "rtc-ice",
          candidate: c.toJSON(),
        }));
      }
    } else {
      pushDebugLog(`[ICE-CAND] Host gathering complete (null candidate)`);
    }
  };

  // Log ICE gathering state changes
  pc.onicegatheringstatechange = () => {
    pushDebugLog(`[ICE] Host gathering: ${pc.iceGatheringState}`);
  };

  // Log ICE connection state for more granular diagnosis
  pc.oniceconnectionstatechange = () => {
    pushDebugLog(`[ICE] Host iceConnection: ${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    pushDebugLog(`[ICE] Host connection: ${state}`);
    console.log("[WebRTC Host] Connection state:", state);

    if (state === "connected") {
      // Clear any pending disconnect timer — connection recovered
      if (disconnectTimerId) {
        clearTimeout(disconnectTimerId);
        disconnectTimerId = null;
        console.log("[WebRTC Host] Connection recovered from disconnected state");
      }
    }

    if (state === "disconnected") {
      // "disconnected" is TEMPORARY — WiFi jitter, brief network switch, etc.
      // Start a grace timer; only fall back if it doesn't recover
      if (!disconnectTimerId && transport.wasP2P) {
        console.log("[WebRTC Host] Connection temporarily disconnected, waiting for recovery...");
        disconnectTimerId = setTimeout(() => {
          disconnectTimerId = null;
          // Check again — it might have recovered during the grace period
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            console.log("[WebRTC Host] Connection did not recover — falling back to relay");
            if (transport.mode === "p2p") {
              transport.mode = "relay";
              onClose();
            }
          }
        }, DISCONNECT_GRACE_MS);
      }

      if (!settled) {
        // During initial setup, disconnected means it's still trying
        // Don't fail yet — let the timeout handle it
      }
    }

    if (state === "failed") {
      // "failed" is PERMANENT — ICE failed, no recovery possible
      logICEFailureDiagnosis(pc, "Host");
      if (disconnectTimerId) {
        clearTimeout(disconnectTimerId);
        disconnectTimerId = null;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        pushDebugLog(`[P2P] WebRTC FAILED — ICE could not establish connection`);
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
      pushDebugLog(`[P2P] WebRTC FAILED — timeout after ${RTC_TIMEOUT_MS / 1000}s`);
      transport.mode = "relay";
      onFail();
    }
  }, RTC_TIMEOUT_MS);

  transport.close = () => {
    settled = true;
    clearTimeout(timeoutId);
    if (disconnectTimerId) {
      clearTimeout(disconnectTimerId);
      disconnectTimerId = null;
    }
    try { dc.close(); } catch {}
    try { pc.close(); } catch {}
  };

  return transport;
}

/**
 * Create a WebRTC connection as the client (answerer).
 * 
 * @param ws - WebSocket for signaling
 * @param offer - SDP offer from host
 * @param onOpen - Called when DataChannel is ready
 * @param onMessage - Called when data arrives on DataChannel
 * @param onClose - Called when DataChannel/connection is permanently lost
 * @param onFail - Called when WebRTC setup fails (timeout or error)
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
  let transport: WebRTCTransport = {
    pc, dataChannel: null, mode: "upgrading", wasP2P: false, close: () => {},
    remoteDescriptionSet: false,
    pendingCandidates: [],
  };
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  let disconnectTimerId: ReturnType<typeof setTimeout> | null = null;

  // Client receives DataChannel from host
  pc.ondatachannel = (event) => {
    const dc = event.channel;
    dc.binaryType = "arraybuffer";
    // Set bufferedAmountLowThreshold for efficient back-pressure
    dc.bufferedAmountLowThreshold = 256 * 1024; // 256KB — triggers onbufferedamountlow event
    transport.dataChannel = dc;

    dc.onopen = () => {
      if (settled && !transport.wasP2P) return;
      settled = true;
      clearTimeout(timeoutId);
      if (disconnectTimerId) {
        clearTimeout(disconnectTimerId);
        disconnectTimerId = null;
      }
      transport.mode = "p2p";
      transport.wasP2P = true;
      console.log("[WebRTC Client] DataChannel open — P2P mode active");
      // Log ICE candidate pair info for debugging
      logSelectedCandidatePair(pc, "Client");
      onOpen();
    };

    dc.onmessage = onMessage;

    dc.onclose = () => {
      const bufAmt = dc.bufferedAmount;
      pushDebugLog(`[DC-CLOSE] Client DataChannel closed | buf=${(bufAmt / 1024).toFixed(0)}KB | pcState=${pc.connectionState}`);
      console.log("[WebRTC Client] DataChannel closed");
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (transport.mode === "p2p") {
          transport.mode = "relay";
          onClose();
        }
      }
    };

    dc.onerror = (e: Event) => {
      const rtcErr = e as RTCErrorEvent;
      const errDetail = rtcErr.error ? `${rtcErr.error.errorDetail}: ${rtcErr.error.message}` : "unknown";
      const bufAmt = dc.bufferedAmount;
      pushDebugLog(`[DC-ERR] Client DataChannel error: ${errDetail} | buf=${(bufAmt / 1024).toFixed(0)}KB | state=${dc.readyState}`);
      console.error("[WebRTC Client] DataChannel error:", e);
    };
  };

  // Send ICE candidates to host via WebSocket + log each candidate for diagnosis
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const c = event.candidate;
      pushDebugLog(`[ICE-CAND] Client local: type=${c.type} addr=${c.address}:${c.port} proto=${c.protocol} raddr=${c.relatedAddress || "-"}:${c.relatedPort || "-"}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "rtc-ice",
          candidate: c.toJSON(),
        }));
      }
    } else {
      pushDebugLog(`[ICE-CAND] Client gathering complete (null candidate)`);
    }
  };

  // Log ICE gathering state changes
  pc.onicegatheringstatechange = () => {
    pushDebugLog(`[ICE] Client gathering: ${pc.iceGatheringState}`);
  };

  // Log ICE connection state for more granular diagnosis
  pc.oniceconnectionstatechange = () => {
    pushDebugLog(`[ICE] Client iceConnection: ${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    pushDebugLog(`[ICE] Client connection: ${state}`);
    console.log("[WebRTC Client] Connection state:", state);

    if (state === "connected") {
      if (disconnectTimerId) {
        clearTimeout(disconnectTimerId);
        disconnectTimerId = null;
        console.log("[WebRTC Client] Connection recovered from disconnected state");
      }
    }

    if (state === "disconnected") {
      if (!disconnectTimerId && transport.wasP2P) {
        console.log("[WebRTC Client] Connection temporarily disconnected, waiting for recovery...");
        disconnectTimerId = setTimeout(() => {
          disconnectTimerId = null;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            console.log("[WebRTC Client] Connection did not recover — falling back to relay");
            if (transport.mode === "p2p") {
              transport.mode = "relay";
              onClose();
            }
          }
        }, DISCONNECT_GRACE_MS);
      }
    }

    if (state === "failed") {
      logICEFailureDiagnosis(pc, "Client");
      if (disconnectTimerId) {
        clearTimeout(disconnectTimerId);
        disconnectTimerId = null;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        transport.mode = "relay";
        pushDebugLog(`[P2P] WebRTC FAILED — ICE could not establish connection`);
        onFail();
      } else if (transport.mode === "p2p") {
        transport.mode = "relay";
        onClose();
      }
    }
  };

  // Set remote offer and create answer
  pc.setRemoteDescription(new RTCSessionDescription(offer))
    .then(() => {
      transport.remoteDescriptionSet = true;
      // Flush any buffered ICE candidates
      if (transport.pendingCandidates && transport.pendingCandidates.length > 0) {
        pushDebugLog(`[ICE] Flushing ${transport.pendingCandidates.length} buffered candidates`);
        for (const candidate of transport.pendingCandidates) {
          pc.addIceCandidate(new RTCIceCandidate(candidate))
            .catch((err) => console.error("[WebRTC] Failed to add buffered ICE candidate:", err));
        }
        transport.pendingCandidates = [];
      }
      return pc.createAnswer();
    })
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
      pushDebugLog(`[P2P] Client answer creation failed: ${err.message}`);
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
      pushDebugLog(`[P2P] WebRTC FAILED — timeout after ${RTC_TIMEOUT_MS / 1000}s`);
      transport.mode = "relay";
      onFail();
    }
  }, RTC_TIMEOUT_MS);

  transport.close = () => {
    settled = true;
    clearTimeout(timeoutId);
    if (disconnectTimerId) {
      clearTimeout(disconnectTimerId);
      disconnectTimerId = null;
    }
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
 * 
 * IMPORTANT: ICE candidates are buffered until remote description is set.
 * This prevents the common "Failed to add ICE candidate" error when candidates
 * arrive before the answer/offer is processed.
 */
export function handleRTCSignaling(
  transport: WebRTCTransport | null,
  msg: { type: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
): void {
  if (!transport) return;
  const { pc } = transport;

  if (msg.type === "rtc-answer" && msg.sdp) {
    pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
      .then(() => {
        console.log("[WebRTC] Set remote answer");
        transport.remoteDescriptionSet = true;
        // Flush any buffered ICE candidates
        if (transport.pendingCandidates && transport.pendingCandidates.length > 0) {
          pushDebugLog(`[ICE] Flushing ${transport.pendingCandidates.length} buffered candidates (host side)`);
          for (const candidate of transport.pendingCandidates) {
            pc.addIceCandidate(new RTCIceCandidate(candidate))
              .catch((err) => console.error("[WebRTC] Failed to add buffered ICE candidate:", err));
          }
          transport.pendingCandidates = [];
        }
      })
      .catch((err) => {
        console.error("[WebRTC] Failed to set remote answer:", err);
        pushDebugLog(`[P2P] Failed to set remote answer: ${err.message}`);
      });
  }

  if (msg.type === "rtc-ice" && msg.candidate) {
    // Buffer ICE candidates if remote description hasn't been set yet
    if (!transport.remoteDescriptionSet) {
      if (!transport.pendingCandidates) transport.pendingCandidates = [];
      transport.pendingCandidates.push(msg.candidate);
      return;
    }
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      .catch((err) => console.error("[WebRTC] Failed to add ICE candidate:", err));
  }
}

/**
 * Log the selected ICE candidate pair for debugging connection type.
 */
function logSelectedCandidatePair(pc: RTCPeerConnection, role: string): void {
  try {
    pc.getStats().then((stats) => {
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          const localId = report.localCandidateId;
          const remoteId = report.remoteCandidateId;
          let localType = "unknown";
          let remoteType = "unknown";
          let localAddr = "";
          let remoteAddr = "";
          let localProto = "";
          let remoteProto = "";
          stats.forEach((r) => {
            if (r.id === localId) {
              localType = r.candidateType || "unknown";
              localAddr = `${r.address || r.ip || ""}:${r.port || ""}`;
              localProto = r.protocol || "";
            }
            if (r.id === remoteId) {
              remoteType = r.candidateType || "unknown";
              remoteAddr = `${r.address || r.ip || ""}:${r.port || ""}`;
              remoteProto = r.protocol || "";
            }
          });
          pushDebugLog(`[ICE] ${role} CONNECTED pair: local=${localType}(${localAddr},${localProto}) remote=${remoteType}(${remoteAddr},${remoteProto})`);
        }
      });

      // Also log all failed candidate pairs for diagnosis
      const failedPairs: string[] = [];
      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "failed") {
          failedPairs.push(`${report.localCandidateId}<->${report.remoteCandidateId}`);
        }
      });
      if (failedPairs.length > 0) {
        pushDebugLog(`[ICE] ${role} failed pairs: ${failedPairs.length}`);
      }
    });
  } catch (e) {
    // Ignore stats errors
  }
}

/**
 * Log detailed ICE failure diagnosis when connection fails.
 * Call this when connectionState becomes "failed".
 */
export function logICEFailureDiagnosis(pc: RTCPeerConnection, role: string): void {
  try {
    pc.getStats().then((stats) => {
      const localCandidates: string[] = [];
      const remoteCandidates: string[] = [];
      let checkedPairs = 0;
      let failedPairs = 0;

      stats.forEach((report) => {
        if (report.type === "local-candidate") {
          localCandidates.push(`${report.candidateType}(${report.address || report.ip}:${report.port},${report.protocol})`);
        }
        if (report.type === "remote-candidate") {
          remoteCandidates.push(`${report.candidateType}(${report.address || report.ip}:${report.port},${report.protocol})`);
        }
        if (report.type === "candidate-pair") {
          checkedPairs++;
          if (report.state === "failed") failedPairs++;
        }
      });

      pushDebugLog(`[ICE-DIAG] ${role} FAILURE ANALYSIS:`);
      pushDebugLog(`[ICE-DIAG] Local candidates (${localCandidates.length}): ${localCandidates.join(", ") || "NONE"}`);
      pushDebugLog(`[ICE-DIAG] Remote candidates (${remoteCandidates.length}): ${remoteCandidates.join(", ") || "NONE"}`);
      pushDebugLog(`[ICE-DIAG] Pairs checked=${checkedPairs} failed=${failedPairs}`);

      // Diagnosis logic
      if (localCandidates.length === 0) {
        pushDebugLog(`[ICE-DIAG] CAUSE: No local candidates gathered — network interface issue or browser restriction`);
      } else if (remoteCandidates.length === 0) {
        pushDebugLog(`[ICE-DIAG] CAUSE: No remote candidates received — signaling issue or peer not responding`);
      } else if (localCandidates.every(c => c.startsWith("host")) && remoteCandidates.every(c => c.startsWith("host"))) {
        pushDebugLog(`[ICE-DIAG] CAUSE: Both sides only have host candidates (no srflx) — STUN server unreachable or blocked`);
        pushDebugLog(`[ICE-DIAG] Both have LAN IPs but cannot connect — likely AP ISOLATION or firewall blocking LAN UDP`);
      } else if (localCandidates.some(c => c.startsWith("host")) && remoteCandidates.some(c => c.startsWith("host"))) {
        const hasLocalSrflx = localCandidates.some(c => c.startsWith("srflx"));
        const hasRemoteSrflx = remoteCandidates.some(c => c.startsWith("srflx"));
        if (hasLocalSrflx || hasRemoteSrflx) {
          pushDebugLog(`[ICE-DIAG] CAUSE: Have srflx candidates but still failed — likely symmetric NAT or restrictive firewall`);
        } else {
          pushDebugLog(`[ICE-DIAG] CAUSE: Host candidates exist but connection failed — AP ISOLATION most likely (router blocks device-to-device traffic)`);
        }
      }
    });
  } catch (e) {
    // Ignore stats errors
  }
}

/**
 * Send data through the best available channel.
 * Prefers DataChannel (P2P) if open, falls back to WebSocket (relay).
 * 
 * IMPORTANT: This function checks readyState directly, not the transport.mode flag.
 * This prevents issues where mode flag lags behind actual channel state.
 * 
 * @returns "p2p" if sent via DataChannel, "relay" if sent via WebSocket
 */
export function sendViaTransport(
  transport: WebRTCTransport | null,
  ws: WebSocket | null,
  data: string | ArrayBuffer,
): TransportMode {
  // Try DataChannel first — check actual readyState, not just mode flag
  if (
    transport?.dataChannel &&
    transport.dataChannel.readyState === "open"
  ) {
    try {
      transport.dataChannel.send(data as any);
      return "p2p";
    } catch (err) {
      // Log to debug panel so user can see why P2P failed
      const errMsg = err instanceof Error ? err.message : String(err);
      const bufAmt = transport.dataChannel.bufferedAmount;
      pushDebugLog(`[P2P-ERR] send failed: ${errMsg} | buf=${(bufAmt / 1024).toFixed(0)}KB | dataSize=${typeof data === "string" ? data.length : (data as ArrayBuffer).byteLength}B`);
      console.warn("[Transport] DataChannel send failed, falling back to relay:", err);
    }
  } else if (transport?.dataChannel) {
    // DataChannel exists but not open — log once for debugging
    if (!sendViaTransport._loggedNotOpen) {
      pushDebugLog(`[P2P-WARN] DataChannel exists but state=${transport.dataChannel.readyState}, using relay`);
      sendViaTransport._loggedNotOpen = true;
    }
  }

  // Fallback to WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
    return "relay";
  }

  return "relay";
}
// Track whether we've logged the "not open" warning to avoid spam
sendViaTransport._loggedNotOpen = false as boolean;

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
    transport.dataChannel.readyState === "open"
  ) {
    return transport.dataChannel.bufferedAmount;
  }
  if (ws) {
    return ws.bufferedAmount;
  }
  return 0;
}
