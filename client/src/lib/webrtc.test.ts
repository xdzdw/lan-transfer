/**
 * White-box tests for the WebRTC transport layer (webrtc.ts)
 *
 * Since Node.js has no native RTCPeerConnection / RTCDataChannel / RTCSessionDescription / RTCIceCandidate,
 * we mock them globally before importing the module under test.
 *
 * Test coverage:
 * 1. createHostRTC  — offer flow, DataChannel open → P2P, timeout → fallback
 * 2. createClientRTC — answer flow, ondatachannel → P2P, timeout → fallback
 * 3. handleRTCSignaling — rtc-answer and rtc-ice dispatch
 * 4. sendViaTransport — priority: DataChannel > WebSocket, fallback on error
 * 5. getTransportBufferedAmount — returns correct buffered amount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock helpers ───────────────────────────────────────────────────────────

/** Minimal mock DataChannel */
function createMockDataChannel() {
  return {
    binaryType: "arraybuffer" as string,
    readyState: "connecting" as string,
    bufferedAmount: 0,
    onopen: null as null | (() => void),
    onmessage: null as null | ((event: any) => void),
    onclose: null as null | (() => void),
    onerror: null as null | ((event: any) => void),
    send: vi.fn(),
    close: vi.fn(),
    // Helper to simulate open
    _simulateOpen() {
      this.readyState = "open";
      this.onopen?.();
    },
    _simulateMessage(data: any) {
      this.onmessage?.({ data });
    },
    _simulateClose() {
      this.readyState = "closed";
      this.onclose?.();
    },
  };
}

/** Minimal mock RTCPeerConnection */
function createMockPC() {
  const pc = {
    connectionState: "new" as string,
    localDescription: null as any,
    remoteDescription: null as any,
    onicecandidate: null as null | ((event: any) => void),
    onconnectionstatechange: null as null | (() => void),
    ondatachannel: null as null | ((event: any) => void),
    _dataChannels: [] as any[],
    _iceCandidates: [] as any[],

    createDataChannel: vi.fn((label: string, _opts?: any) => {
      const dc = createMockDataChannel();
      pc._dataChannels.push(dc);
      return dc;
    }),
    createOffer: vi.fn(() => Promise.resolve({ type: "offer", sdp: "mock-offer-sdp" })),
    createAnswer: vi.fn(() => Promise.resolve({ type: "answer", sdp: "mock-answer-sdp" })),
    setLocalDescription: vi.fn((desc: any) => {
      pc.localDescription = desc;
      return Promise.resolve();
    }),
    setRemoteDescription: vi.fn((desc: any) => {
      pc.remoteDescription = desc;
      return Promise.resolve();
    }),
    addIceCandidate: vi.fn((candidate: any) => {
      pc._iceCandidates.push(candidate);
      return Promise.resolve();
    }),
    close: vi.fn(),

    // Helper to simulate connection state change
    _setConnectionState(state: string) {
      pc.connectionState = state;
      pc.onconnectionstatechange?.();
    },
    // Helper to simulate ondatachannel (client side)
    _simulateDataChannel(dc: any) {
      pc.ondatachannel?.({ channel: dc });
    },
    // Helper to simulate ICE candidate
    _simulateIceCandidate(candidate: any) {
      pc.onicecandidate?.({ candidate });
    },
  };
  return pc;
}

// ─── Global mock setup ──────────────────────────────────────────────────────

let latestPC: ReturnType<typeof createMockPC>;

// We need to mock browser globals before importing the module
const MockRTCPeerConnection = vi.fn(() => {
  latestPC = createMockPC();
  return latestPC;
});

const MockRTCSessionDescription = vi.fn((init: any) => init);
const MockRTCIceCandidate = vi.fn((init: any) => init);

// Mock WebSocket constants
const MockWebSocket = {
  OPEN: 1,
  CLOSED: 3,
};

// Install globals
(globalThis as any).RTCPeerConnection = MockRTCPeerConnection;
(globalThis as any).RTCSessionDescription = MockRTCSessionDescription;
(globalThis as any).RTCIceCandidate = MockRTCIceCandidate;
(globalThis as any).WebSocket = Object.assign(vi.fn(), MockWebSocket);

// Now import the module under test
import {
  createHostRTC,
  createClientRTC,
  handleRTCSignaling,
  sendViaTransport,
  getTransportBufferedAmount,
  type WebRTCTransport,
} from "./webrtc";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("webrtc.ts — WebRTC Transport Layer", () => {
  let mockWs: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWs = {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn(),
      bufferedAmount: 0,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ─── createHostRTC ──────────────────────────────────────────────────────

  describe("createHostRTC", () => {
    it("should create RTCPeerConnection and DataChannel", async () => {
      const onOpen = vi.fn();
      const onMessage = vi.fn();
      const onClose = vi.fn();
      const onFail = vi.fn();

      const transport = createHostRTC(mockWs, onOpen, onMessage, onClose, onFail);

      // Wait for async offer creation but NOT past the 6s timeout
      await vi.advanceTimersByTimeAsync(100);

      expect(MockRTCPeerConnection).toHaveBeenCalled();
      expect(latestPC.createDataChannel).toHaveBeenCalledWith("transfer", expect.any(Object));
      expect(transport.pc).toBe(latestPC);
      expect(transport.dataChannel).not.toBeNull();
      expect(transport.mode).toBe("upgrading");

      transport.close();
    });

    it("should send SDP offer via WebSocket after creation", async () => {
      const onOpen = vi.fn();
      const transport = createHostRTC(mockWs, onOpen, vi.fn(), vi.fn(), vi.fn());

      // Let the async offer flow complete but NOT past the 6s timeout
      await vi.advanceTimersByTimeAsync(100);

      // Should have sent rtc-offer via WebSocket
      const sentMessages = mockWs.send.mock.calls.map((c: any[]) => {
        try { return JSON.parse(c[0]); } catch { return null; }
      }).filter(Boolean);

      const offerMsg = sentMessages.find((m: any) => m.type === "rtc-offer");
      expect(offerMsg).toBeTruthy();
      expect(offerMsg.sdp).toEqual({ type: "offer", sdp: "mock-offer-sdp" });

      transport.close();
    });

    it("should call onOpen and set mode to p2p when DataChannel opens", async () => {
      const onOpen = vi.fn();
      const transport = createHostRTC(mockWs, onOpen, vi.fn(), vi.fn(), vi.fn());

      // Let offer flow complete but NOT past timeout
      await vi.advanceTimersByTimeAsync(100);

      // Simulate DataChannel opening before timeout
      const dc = latestPC._dataChannels[0];
      dc._simulateOpen();

      expect(onOpen).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("p2p");

      transport.close();
    });

    it("should call onMessage when DataChannel receives data", async () => {
      const onMessage = vi.fn();
      const transport = createHostRTC(mockWs, vi.fn(), onMessage, vi.fn(), vi.fn());

      await vi.advanceTimersByTimeAsync(100);

      const dc = latestPC._dataChannels[0];
      dc._simulateOpen();
      dc._simulateMessage("hello-p2p");

      expect(onMessage).toHaveBeenCalledWith({ data: "hello-p2p" });

      transport.close();
    });

    it("should call onFail after timeout if DataChannel never opens", async () => {
      const onFail = vi.fn();
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), onFail);

      // Let offer flow complete but don't open DataChannel
      await vi.advanceTimersByTimeAsync(100);

      expect(onFail).not.toHaveBeenCalled();

      // Advance past the 8s timeout (RTC_TIMEOUT_MS = 8000)
      await vi.advanceTimersByTimeAsync(8000);

      expect(onFail).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });

    it("should NOT call onFail after timeout if DataChannel already opened", async () => {
      const onOpen = vi.fn();
      const onFail = vi.fn();
      const transport = createHostRTC(mockWs, onOpen, vi.fn(), vi.fn(), onFail);

      await vi.advanceTimersByTimeAsync(100);

      // Open DataChannel before timeout
      const dc = latestPC._dataChannels[0];
      dc._simulateOpen();

      expect(onOpen).toHaveBeenCalledOnce();

      // Advance past timeout — should NOT trigger onFail
      await vi.advanceTimersByTimeAsync(6000);

      expect(onFail).not.toHaveBeenCalled();
      expect(transport.mode).toBe("p2p");

      transport.close();
    });

    it("should call onClose when DataChannel closes AND connection state is failed", async () => {
      const onClose = vi.fn();
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), onClose, vi.fn());

      await vi.advanceTimersByTimeAsync(100);

      const dc = latestPC._dataChannels[0];
      dc._simulateOpen();
      expect(transport.mode).toBe("p2p");

      // DataChannel close alone should NOT trigger onClose (new behavior)
      // The connection state must also be failed/closed
      latestPC.connectionState = "failed";
      dc._simulateClose();
      expect(onClose).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });

    it("should call onFail when connection state becomes failed before settled", async () => {
      const onFail = vi.fn();
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), onFail);

      await vi.advanceTimersByTimeAsync(100);

      // Simulate connection failure
      latestPC._setConnectionState("failed");

      expect(onFail).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });

    it("should send ICE candidates via WebSocket", async () => {
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), vi.fn());

      await vi.advanceTimersByTimeAsync(100);

      // Simulate ICE candidate
      latestPC._simulateIceCandidate({ toJSON: () => ({ candidate: "mock-candidate", sdpMid: "0" }) });

      const sentMessages = mockWs.send.mock.calls.map((c: any[]) => {
        try { return JSON.parse(c[0]); } catch { return null; }
      }).filter(Boolean);

      const iceMsg = sentMessages.find((m: any) => m.type === "rtc-ice");
      expect(iceMsg).toBeTruthy();
      expect(iceMsg.candidate).toEqual({ candidate: "mock-candidate", sdpMid: "0" });

      transport.close();
    });

    it("close() should clean up DataChannel and PeerConnection", async () => {
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), vi.fn());

      await vi.advanceTimersByTimeAsync(100);

      const dc = latestPC._dataChannels[0];
      transport.close();

      expect(dc.close).toHaveBeenCalled();
      expect(latestPC.close).toHaveBeenCalled();
    });
  });

  // ─── createClientRTC ────────────────────────────────────────────────────

  describe("createClientRTC", () => {
    const fakeOffer = { type: "offer" as const, sdp: "remote-offer-sdp" };

    it("should set remote description and send SDP answer", async () => {
      const transport = createClientRTC(mockWs, fakeOffer, vi.fn(), vi.fn(), vi.fn(), vi.fn());

      // Let answer flow complete but NOT past timeout
      await vi.advanceTimersByTimeAsync(100);

      expect(latestPC.setRemoteDescription).toHaveBeenCalled();
      expect(latestPC.createAnswer).toHaveBeenCalled();
      expect(latestPC.setLocalDescription).toHaveBeenCalled();

      const sentMessages = mockWs.send.mock.calls.map((c: any[]) => {
        try { return JSON.parse(c[0]); } catch { return null; }
      }).filter(Boolean);

      const answerMsg = sentMessages.find((m: any) => m.type === "rtc-answer");
      expect(answerMsg).toBeTruthy();
      expect(answerMsg.sdp).toEqual({ type: "answer", sdp: "mock-answer-sdp" });

      transport.close();
    });

    it("should call onOpen when DataChannel arrives and opens", async () => {
      const onOpen = vi.fn();
      const transport = createClientRTC(mockWs, fakeOffer, onOpen, vi.fn(), vi.fn(), vi.fn());

      // Let answer flow complete but NOT past timeout
      await vi.advanceTimersByTimeAsync(100);

      // Simulate host sending a DataChannel
      const dc = createMockDataChannel();
      latestPC._simulateDataChannel(dc);

      // Simulate DataChannel opening
      dc._simulateOpen();

      expect(onOpen).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("p2p");
      expect(transport.dataChannel).toBe(dc);

      transport.close();
    });

    it("should call onFail after timeout if no DataChannel arrives", async () => {
      const onFail = vi.fn();
      const transport = createClientRTC(mockWs, fakeOffer, vi.fn(), vi.fn(), vi.fn(), onFail);

      await vi.advanceTimersByTimeAsync(100);
      expect(onFail).not.toHaveBeenCalled();

      // Advance past the 8s timeout (RTC_TIMEOUT_MS = 8000)
      await vi.advanceTimersByTimeAsync(8000);
      expect(onFail).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });

    it("should call onClose when DataChannel closes AND connection state is failed", async () => {
      const onClose = vi.fn();
      const transport = createClientRTC(mockWs, fakeOffer, vi.fn(), vi.fn(), onClose, vi.fn());

      await vi.advanceTimersByTimeAsync(100);

      const dc = createMockDataChannel();
      latestPC._simulateDataChannel(dc);
      dc._simulateOpen();

      expect(transport.mode).toBe("p2p");

      // DataChannel close alone should NOT trigger onClose (new behavior)
      // The connection state must also be failed/closed
      latestPC.connectionState = "failed";
      dc._simulateClose();
      expect(onClose).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });

    it("should call onFail when connection state becomes failed before settled", async () => {
      const onFail = vi.fn();
      const transport = createClientRTC(mockWs, fakeOffer, vi.fn(), vi.fn(), vi.fn(), onFail);

      await vi.advanceTimersByTimeAsync(100);

      latestPC._setConnectionState("failed");

      expect(onFail).toHaveBeenCalledOnce();
      expect(transport.mode).toBe("relay");

      transport.close();
    });
  });

  // ─── handleRTCSignaling ─────────────────────────────────────────────────

  describe("handleRTCSignaling", () => {
    it("should set remote description for rtc-answer messages", async () => {
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      const answerSdp = { type: "answer", sdp: "remote-answer-sdp" };
      handleRTCSignaling(transport, { type: "rtc-answer", sdp: answerSdp as any });

      expect(latestPC.setRemoteDescription).toHaveBeenCalled();

      transport.close();
    });

    it("should add ICE candidate for rtc-ice messages", async () => {
      const transport = createHostRTC(mockWs, vi.fn(), vi.fn(), vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      const candidate = { candidate: "mock-ice", sdpMid: "0", sdpMLineIndex: 0 };
      handleRTCSignaling(transport, { type: "rtc-ice", candidate });

      expect(latestPC.addIceCandidate).toHaveBeenCalled();

      transport.close();
    });

    it("should do nothing when transport is null", () => {
      // Should not throw
      handleRTCSignaling(null, { type: "rtc-answer", sdp: { type: "answer", sdp: "x" } });
      handleRTCSignaling(null, { type: "rtc-ice", candidate: { candidate: "x" } });
    });
  });

  // ─── sendViaTransport ───────────────────────────────────────────────────

  describe("sendViaTransport", () => {
    it("should prefer DataChannel when P2P is active", () => {
      const dc = createMockDataChannel();
      dc.readyState = "open";

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "p2p",
        close: vi.fn(),
      };

      const mode = sendViaTransport(transport, mockWs, "hello");

      expect(mode).toBe("p2p");
      expect(dc.send).toHaveBeenCalledWith("hello");
      expect(mockWs.send).not.toHaveBeenCalled();
    });

    it("should fallback to WebSocket when DataChannel is not open", () => {
      const dc = createMockDataChannel();
      dc.readyState = "connecting";

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "upgrading",
        close: vi.fn(),
      };

      const mode = sendViaTransport(transport, mockWs, "hello");

      expect(mode).toBe("relay");
      expect(dc.send).not.toHaveBeenCalled();
      expect(mockWs.send).toHaveBeenCalledWith("hello");
    });

    it("should fallback to WebSocket when transport is null", () => {
      const mode = sendViaTransport(null, mockWs, "hello");

      expect(mode).toBe("relay");
      expect(mockWs.send).toHaveBeenCalledWith("hello");
    });

    it("should fallback to WebSocket when DataChannel send throws", () => {
      const dc = createMockDataChannel();
      dc.readyState = "open";
      dc.send.mockImplementation(() => { throw new Error("send failed"); });

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "p2p",
        close: vi.fn(),
      };

      const mode = sendViaTransport(transport, mockWs, "hello");

      expect(mode).toBe("relay");
      expect(mockWs.send).toHaveBeenCalledWith("hello");
    });

    it("should send binary data (ArrayBuffer) via DataChannel", () => {
      const dc = createMockDataChannel();
      dc.readyState = "open";

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "p2p",
        close: vi.fn(),
      };

      const buffer = new ArrayBuffer(10);
      const mode = sendViaTransport(transport, mockWs, buffer);

      expect(mode).toBe("p2p");
      expect(dc.send).toHaveBeenCalledWith(buffer);
    });

    it("should return relay when both transport and ws are null", () => {
      const mode = sendViaTransport(null, null, "hello");
      expect(mode).toBe("relay");
    });
  });

  // ─── getTransportBufferedAmount ─────────────────────────────────────────

  describe("getTransportBufferedAmount", () => {
    it("should return DataChannel bufferedAmount when P2P is active", () => {
      const dc = createMockDataChannel();
      dc.readyState = "open";
      dc.bufferedAmount = 12345;

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "p2p",
        close: vi.fn(),
      };

      expect(getTransportBufferedAmount(transport, mockWs)).toBe(12345);
    });

    it("should return WebSocket bufferedAmount when not in P2P mode", () => {
      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: null,
        mode: "relay",
        close: vi.fn(),
      };
      mockWs.bufferedAmount = 9999;

      expect(getTransportBufferedAmount(transport, mockWs)).toBe(9999);
    });

    it("should return 0 when both are null", () => {
      expect(getTransportBufferedAmount(null, null)).toBe(0);
    });

    it("should return WebSocket bufferedAmount when DataChannel exists but not open", () => {
      const dc = createMockDataChannel();
      dc.readyState = "connecting";
      dc.bufferedAmount = 5000;

      const transport: WebRTCTransport = {
        pc: {} as any,
        dataChannel: dc as any,
        mode: "upgrading",
        close: vi.fn(),
      };
      mockWs.bufferedAmount = 2000;

      expect(getTransportBufferedAmount(transport, mockWs)).toBe(2000);
    });
  });
});
