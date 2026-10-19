import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RELAY_MAX_FILE_BYTES,
  RelayLimitError,
  type RelayFileMeta,
} from "@shared/relayLimits";
import type { WebRTCTransport } from "./webrtc";
import {
  getFileTransportMode,
  prepareFileTransfer,
  registerRelayFile,
  sendFileViaTransport,
} from "./relayTransfer";

const MockWebSocket = { OPEN: 1, CLOSED: 3 };
(globalThis as unknown as { WebSocket: unknown }).WebSocket = Object.assign(
  vi.fn(),
  MockWebSocket
);

type StatsReport = Record<string, unknown> & { id: string; type: string };

function stats(...reports: StatsReport[]) {
  return {
    forEach(callback: (report: StatsReport) => void) {
      reports.forEach(callback);
    },
  };
}

function selectedStats(
  localType: string,
  remoteType: string,
  extraSucceeded = false
) {
  const reports: StatsReport[] = [
    {
      id: "transport-1",
      type: "transport",
      selectedCandidatePairId: "selected-pair",
    },
    {
      id: "selected-pair",
      type: "candidate-pair",
      state: "succeeded",
      localCandidateId: "selected-local",
      remoteCandidateId: "selected-remote",
    },
    { id: "selected-local", type: "local-candidate", candidateType: localType },
    {
      id: "selected-remote",
      type: "remote-candidate",
      candidateType: remoteType,
    },
  ];
  if (extraSucceeded) {
    reports.push(
      {
        id: "unselected-direct-pair",
        type: "candidate-pair",
        state: "succeeded",
        localCandidateId: "unselected-local",
        remoteCandidateId: "unselected-remote",
      },
      {
        id: "unselected-local",
        type: "local-candidate",
        candidateType: "host",
      },
      {
        id: "unselected-remote",
        type: "remote-candidate",
        candidateType: "host",
      }
    );
  }
  return stats(...reports);
}

function mockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    bufferedAmount: 0,
  } as unknown as WebSocket;
}

function transportWithStats(
  statsResult: ReturnType<typeof stats>,
  dcSend = vi.fn()
): WebRTCTransport {
  return {
    pc: {
      getStats: vi.fn(() => Promise.resolve(statsResult)),
    } as unknown as RTCPeerConnection,
    dataChannel: {
      readyState: "open",
      bufferedAmount: 0,
      send: dcSend,
    } as unknown as RTCDataChannel,
    mode: "p2p",
    wasP2P: true,
    close: vi.fn(),
  };
}

function directTransport(dcSend = vi.fn()): WebRTCTransport {
  return {
    pc: {
      sctp: {
        transport: {
          iceTransport: {
            getSelectedCandidatePair: () => ({
              local: { candidateType: "host" },
              remote: { candidateType: "srflx" },
            }),
          },
        },
      },
      getStats: vi.fn(),
    } as unknown as RTCPeerConnection,
    dataChannel: {
      readyState: "open",
      bufferedAmount: 0,
      send: dcSend,
    } as unknown as RTCDataChannel,
    mode: "p2p",
    wasP2P: true,
    close: vi.fn(),
  };
}

function relayTransport(): WebRTCTransport {
  return {
    pc: {
      getStats: vi.fn(() => Promise.resolve(selectedStats("relay", "srflx"))),
    } as unknown as RTCPeerConnection,
    dataChannel: {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
    } as unknown as RTCDataChannel,
    mode: "p2p",
    wasP2P: true,
    close: vi.fn(),
  };
}

function ordinaryMeta(size = RELAY_MAX_FILE_BYTES + 1): RelayFileMeta {
  return {
    id: "f-00000000-0000-0000-0000-000000000000",
    name: "archive.zip",
    size,
    mimeType: "application/zip",
    totalChunks: 1,
  };
}

function imageMeta(size = RELAY_MAX_FILE_BYTES * 2): RelayFileMeta {
  return {
    id: "i-00000000-0000-0000-0000-000000000000",
    name: "photo.png",
    size,
    mimeType: "image/png",
    totalChunks: 1,
  };
}

describe("relayTransfer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers relay metadata only, without treating it as forwarded file data", () => {
    const ws = mockWs();
    const meta = ordinaryMeta(123);
    registerRelayFile(ws, meta);
    expect(ws.send as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      JSON.stringify({ type: "relay-register", meta })
    );
  });

  it("does not write oversized bytes to WebSocket when relay is the only route", () => {
    const ws = mockWs();
    const meta = ordinaryMeta();
    expect(() =>
      sendFileViaTransport(null, ws, new ArrayBuffer(8), meta)
    ).toThrow(RelayLimitError);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("runs the fallback guard after DataChannel TypeError and before any WS byte write", () => {
    const ws = mockWs();
    const dcSend = vi.fn(() => {
      throw new TypeError("too large for channel");
    });
    const transport = directTransport(dcSend);
    const meta = ordinaryMeta();

    expect(() =>
      sendFileViaTransport(transport, ws, new ArrayBuffer(8), meta)
    ).toThrow(RelayLimitError);
    expect(dcSend).toHaveBeenCalledOnce();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("allows an in-limit file and an exempt image to fall back to relay", () => {
    const withinLimitWs = mockWs();
    const withinLimitDc = vi.fn(() => {
      throw new TypeError("dc unavailable");
    });
    expect(
      sendFileViaTransport(
        directTransport(withinLimitDc),
        withinLimitWs,
        new ArrayBuffer(8),
        ordinaryMeta(RELAY_MAX_FILE_BYTES)
      )
    ).toBe("relay");
    expect(withinLimitWs.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));

    const imageWs = mockWs();
    const imageDc = vi.fn(() => {
      throw new TypeError("dc unavailable");
    });
    expect(
      sendFileViaTransport(
        directTransport(imageDc),
        imageWs,
        new ArrayBuffer(8),
        imageMeta()
      )
    ).toBe("relay");
    expect(imageWs.send).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it("allows oversized ordinary files only over a verified direct selected pair", async () => {
    const ws = mockWs();
    const dcSend = vi.fn();
    const transport = directTransport(dcSend);
    const meta = ordinaryMeta();

    await expect(
      prepareFileTransfer(transport, ws, meta)
    ).resolves.toBeUndefined();
    expect(sendFileViaTransport(transport, ws, new ArrayBuffer(8), meta)).toBe(
      "p2p"
    );
    expect(dcSend).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "relay-register", meta })
    );
  });

  it("rejects ordinary oversized files on the selected TURN pair but permits images", async () => {
    const ws = mockWs();
    const transport = relayTransport();
    const meta = ordinaryMeta();

    await expect(
      prepareFileTransfer(transport, ws, meta)
    ).rejects.toBeInstanceOf(RelayLimitError);
    expect(() =>
      sendFileViaTransport(transport, ws, new ArrayBuffer(8), meta)
    ).toThrow(RelayLimitError);
    expect(
      transport.dataChannel!.send as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();

    await expect(
      prepareFileTransfer(transport, ws, imageMeta())
    ).resolves.toBeUndefined();
    expect(
      sendFileViaTransport(transport, ws, new ArrayBuffer(8), imageMeta())
    ).toBe("turn");
  });

  it("uses only transport.selectedCandidatePairId, never an arbitrary succeeded pair", async () => {
    const transport = transportWithStats(selectedStats("relay", "srflx", true));
    await expect(
      prepareFileTransfer(transport, null, ordinaryMeta())
    ).rejects.toBeInstanceOf(RelayLimitError);
    expect(getFileTransportMode(transport)).toBe("turn");
  });

  it("refreshes a dynamic selected path and protects force-WS retries", async () => {
    let currentStats = selectedStats("host", "srflx");
    const dcSend = vi.fn();
    const transport = transportWithStats(currentStats, dcSend);
    (transport.pc.getStats as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve(currentStats)
    );
    const meta = ordinaryMeta();

    await prepareFileTransfer(transport, null, meta);
    expect(
      sendFileViaTransport(transport, null, new ArrayBuffer(4), meta)
    ).toBe("p2p");

    currentStats = selectedStats("relay", "srflx");
    await expect(
      prepareFileTransfer(transport, null, meta)
    ).rejects.toBeInstanceOf(RelayLimitError);

    const retryWs = mockWs();
    expect(() =>
      sendFileViaTransport(null, retryWs, new ArrayBuffer(4), meta)
    ).toThrow(RelayLimitError);
    expect(retryWs.send).not.toHaveBeenCalled();
  });
});
