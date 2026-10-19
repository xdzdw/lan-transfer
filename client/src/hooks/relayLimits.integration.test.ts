// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_MAX_FILE_BYTES, FILE_CHUNK_BYTES } from "@shared/relayLimits";

vi.mock("@/components/DebugPanel", () => ({ pushDebugLog: vi.fn() }));
vi.mock("@/lib/webrtc", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/webrtc")>();
  const makeTransport = () => ({
    pc: { getStats: async () => new Map(), connectionState: "new" },
    dataChannel: null,
    mode: "relay",
    wasP2P: false,
    close: vi.fn(),
  });
  return {
    ...original,
    createHostRTC: vi.fn(makeTransport),
    createClientRTC: vi.fn(makeTransport),
  };
});

import { usePeerHost } from "./usePeerHost";
import { usePeerClient } from "./usePeerClient";

class TestSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: TestSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  rejectNextBinary = false;
  constructor(_url: string) {
    TestSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
    if (this.rejectNextBinary && data instanceof ArrayBuffer) {
      this.rejectNextBinary = false;
      const fileId = new TextDecoder().decode(new Uint8Array(data, 0, 36));
      this.receive({
        type: "file-rejected",
        fileId,
        code: "RELAY_FILE_TOO_LARGE",
        maxBytes: RELAY_MAX_FILE_BYTES,
      });
    }
  }
  open() {
    this.readyState = TestSocket.OPEN;
    this.onopen?.();
  }
  receive(message: object) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(message) })
    );
  }
  close() {
    this.readyState = TestSocket.CLOSED;
    this.onclose?.();
  }
  commands() {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map(data => JSON.parse(data));
  }
  binary() {
    return this.sent.filter(
      (data): data is ArrayBuffer => data instanceof ArrayBuffer
    );
  }
}

function makeFile(
  size: number,
  name: string,
  type = "application/octet-stream"
) {
  const bytes = new Uint8Array(size);
  if (type === "image/png") bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const file = new File([bytes], name, { type });
  const read = vi.fn(async () => bytes.buffer.slice(0));
  Object.defineProperty(file, "arrayBuffer", { value: read });
  return { file, read };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", TestSocket);
  TestSocket.instances = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

for (const role of ["host", "client"] as const) {
  describe(`${role} relay transfer protection`, () => {
    function connectHook() {
      const host = role === "host";
      const hook = renderHook(() => (host ? usePeerHost() : usePeerClient()));
      act(() => {
        const current = hook.result.current;
        if ("startHost" in current) current.startHost();
        else current.connect("1235");
      });
      const ws = TestSocket.instances[0];
      act(() => {
        ws.open();
        if (host) ws.receive({ type: "registered", token: "1235" });
        ws.receive({ type: "connected" });
      });
      return { ...hook, ws };
    }

    it("rejects an oversized ordinary file before reading or sending it", async () => {
      const { result, ws } = connectHook();
      const { file, read } = makeFile(RELAY_MAX_FILE_BYTES + 1, "large.zip");
      await act(async () => {
        await expect(result.current.sendFile(file)).rejects.toMatchObject({
          code: "RELAY_FILE_TOO_LARGE",
        });
      });
      expect(read).not.toHaveBeenCalled();
      expect(ws.binary()).toHaveLength(0);
      expect(ws.commands().some(message => message.type === "file-meta")).toBe(
        false
      );
      expect(result.current.status).toBe("connected");
    });

    it("sends a small file using the same chunk size as retries", async () => {
      const { result, ws } = connectHook();
      const { file } = makeFile(FILE_CHUNK_BYTES + 7, "small.zip");
      await act(async () => {
        await result.current.sendFile(file);
      });
      expect(
        ws.commands().find(message => message.type === "file-meta").meta
          .totalChunks
      ).toBe(2);
      expect(ws.binary().map(data => data.byteLength)).toEqual([
        FILE_CHUNK_BYTES + 40,
        47,
      ]);
      expect(
        ws.commands().some(message => message.type === "relay-register")
      ).toBe(true);
      expect(
        result.current.items.find(item => item.name === "small.zip")?.status
      ).toBe("done");
    });

    it("allows a PNG larger than the ordinary-file limit", async () => {
      const { result, ws } = connectHook();
      const { file } = makeFile(
        RELAY_MAX_FILE_BYTES + 1,
        "photo.png",
        "image/png"
      );
      await act(async () => {
        await result.current.sendFile(file);
      });
      expect(ws.binary().length).toBeGreaterThan(1);
      expect(
        result.current.items.find(item => item.name === "photo.png")?.status
      ).toBe("done");
    });

    it("checks the sum of ordinary files in a folder before sending any child", async () => {
      const { result, ws } = connectHook();
      const first = makeFile(6 * 1024 * 1024, "a.zip");
      const second = makeFile(6 * 1024 * 1024, "b.zip");
      await act(async () => {
        await expect(
          result.current.sendFolder([
            { file: first.file, relativePath: "Bundle/a.zip" },
            { file: second.file, relativePath: "Bundle/b.zip" },
          ])
        ).rejects.toMatchObject({ code: "RELAY_FILE_TOO_LARGE" });
      });
      expect(first.read).not.toHaveBeenCalled();
      expect(second.read).not.toHaveBeenCalled();
      expect(ws.binary()).toHaveLength(0);
    });

    it("exempts folder images and registers only real member files", async () => {
      const { result, ws } = connectHook();
      const ordinary = makeFile(6 * 1024 * 1024, "a.zip");
      const image = makeFile(11 * 1024 * 1024, "photo.png", "image/png");
      await act(async () => {
        await result.current.sendFolder([
          { file: ordinary.file, relativePath: "Mixed/a.zip" },
          { file: image.file, relativePath: "Mixed/photo.png" },
        ]);
      });
      const registrations = ws
        .commands()
        .filter(message => message.type === "relay-register");
      expect(registrations).toHaveLength(2);
      expect(
        registrations.every(
          message => message.meta.folderRestrictedSize === 6 * 1024 * 1024
        )
      ).toBe(true);
      expect(
        result.current.items.find(item => item.type === "folder")
      ).toMatchObject({ status: "done", folderFileCount: 2 });
    });

    it("stops on a server rejection, marks the file failed, and keeps chat connected", async () => {
      const { result, ws } = connectHook();
      const { file } = makeFile(FILE_CHUNK_BYTES * 3, "cancelled.zip");
      ws.rejectNextBinary = true;
      await act(async () => {
        await expect(result.current.sendFile(file)).rejects.toMatchObject({
          code: "RELAY_FILE_TOO_LARGE",
        });
      });
      expect(ws.binary()).toHaveLength(1);
      expect(
        result.current.items.find(item => item.name === "cancelled.zip")
      ).toMatchObject({ status: "error", errorCode: "RELAY_FILE_TOO_LARGE" });
      expect(result.current.status).toBe("connected");
      act(() => result.current.sendText("文字仍能发送"));
      expect(
        ws
          .commands()
          .some(
            message =>
              message.type === "text" && message.content === "文字仍能发送"
          )
      ).toBe(true);
    });
  });
}
