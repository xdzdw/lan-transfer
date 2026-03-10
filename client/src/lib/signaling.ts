/**
 * In-browser signaling server using BroadcastChannel
 * 
 * Since this is a static site deployed on the same domain,
 * both PC and mobile open the same URL. We use BroadcastChannel
 * as a cross-tab signaling mechanism when on the same device,
 * and for cross-device we embed a tiny WebSocket signaling relay.
 * 
 * For the production cross-device scenario, we'll embed the signaling
 * server directly in the page using a simple in-memory relay approach.
 */

// The signaling URL will be provided by the embedded WebSocket server
// or an external signaling service

export const SIGNALING_CHANNEL_NAME = "lan-transfer-signaling";

export interface SignalingMessage {
  type: "register" | "join" | "offer" | "answer" | "ice-candidate" | "client-joined" | "error";
  token?: string;
  role?: "host" | "client";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  message?: string;
}

/**
 * BroadcastChannel-based signaling for same-device (cross-tab) communication.
 * This works when PC browser and "mobile" browser are on the same machine (testing).
 */
export class BroadcastSignaling {
  private channel: BroadcastChannel;
  private handlers: Map<string, ((msg: SignalingMessage) => void)[]> = new Map();

  constructor() {
    this.channel = new BroadcastChannel(SIGNALING_CHANNEL_NAME);
    this.channel.onmessage = (event) => {
      const msg = event.data as SignalingMessage;
      const type = msg.type;
      const callbacks = this.handlers.get(type) || [];
      callbacks.forEach(cb => cb(msg));
      
      // Also fire wildcard handlers
      const wildcardCallbacks = this.handlers.get("*") || [];
      wildcardCallbacks.forEach(cb => cb(msg));
    };
  }

  on(type: string, handler: (msg: SignalingMessage) => void) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
  }

  send(msg: SignalingMessage) {
    this.channel.postMessage(msg);
  }

  close() {
    this.channel.close();
  }
}

/**
 * Get the WebSocket signaling URL
 * In production, this would point to a signaling server.
 * For our static site, we embed a minimal signaling relay.
 */
export function getSignalingUrl(): string {
  // Use the current host for the signaling server
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}/ws-signaling`;
}
