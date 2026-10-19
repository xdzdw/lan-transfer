import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { WebSocket } from "ws";
import { FILE_CHUNK_BYTES, RELAY_MAX_FILE_BYTES } from "../shared/relayLimits";
import { setupSignalingServer } from "./signaling";

let server: Server;
let port: number;
let sequence = 0;
let clients: WebSocket[] = [];

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;
const nextToken = () => (7000 + sequence++).toString();

function wsUrl(): string {
  return `ws://localhost:${port}/api/ws-signaling`;
}

function createClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket, timeout = 1_500): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error("Timed out waiting for websocket message"));
    }, timeout);
    const listener = (data: WebSocket.RawData, isBinary: boolean) => {
      clearTimeout(timer);
      if (isBinary)
        resolve({ binary: true, data: Buffer.from(data as Buffer) });
      else resolve(JSON.parse(data.toString()));
    };
    ws.once("message", listener);
  });
}

async function expectNoMessage(ws: WebSocket, timeout = 120): Promise<void> {
  await expect(nextMessage(ws, timeout)).rejects.toThrow("Timed out");
}

async function room(): Promise<{ host: WebSocket; client: WebSocket }> {
  const host = await createClient();
  const client = await createClient();
  clients.push(host, client);
  const token = nextToken();
  const registered = nextMessage(host);
  host.send(JSON.stringify({ type: "register", token }));
  await registered;
  const hostConnected = nextMessage(host);
  const clientConnected = nextMessage(client);
  client.send(JSON.stringify({ type: "join", token }));
  await Promise.all([hostConnected, clientConnected]);
  return { host, client };
}

function metadata(
  id: string,
  size: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    name: "small.bin",
    size,
    mimeType: "application/octet-stream",
    totalChunks: Math.ceil(size / FILE_CHUNK_BYTES),
    ...overrides,
  };
}

function chunk(id: string, index: number, length: number): Buffer {
  const frame = Buffer.alloc(40 + length);
  frame.write(id, 0, "utf8");
  frame.writeUInt32BE(index, 36);
  for (let position = 0; position < length; position++)
    frame[40 + position] = position % 251;
  return frame;
}

beforeAll(async () => {
  server = createServer();
  setupSignalingServer(server);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterEach(() => {
  for (const client of clients)
    if (client.readyState === WebSocket.OPEN) client.close();
  clients = [];
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("guarded WebSocket file relay", () => {
  it("relays a registered small file and complete/ack closure in host-to-client direction", async () => {
    const { host, client } = await room();
    const id = uuid(1);
    host.send(
      JSON.stringify({ type: "relay-register", meta: metadata(id, 100) })
    );
    await expectNoMessage(host);
    await expectNoMessage(client);

    const clientMeta = nextMessage(client);
    host.send(JSON.stringify({ type: "file-meta", meta: metadata(id, 100) }));
    expect(await clientMeta).toMatchObject({ type: "file-meta", meta: { id } });

    const clientChunk = nextMessage(client);
    host.send(chunk(id, 0, 100));
    expect(await clientChunk).toMatchObject({
      binary: true,
      data: chunk(id, 0, 100),
    });

    const completed = nextMessage(client);
    host.send(JSON.stringify({ type: "file-complete", id }));
    expect(await completed).toMatchObject({ type: "file-complete", id });

    const ack = nextMessage(host);
    client.send(JSON.stringify({ type: "file-ack", fileId: id }));
    expect(await ack).toMatchObject({ type: "file-ack", fileId: id });
    await expectNoMessage(host);
    await expectNoMessage(client);
  });

  it("relays a registered small file and complete/ack closure in client-to-host direction", async () => {
    const { host, client } = await room();
    const id = uuid(2);
    client.send(
      JSON.stringify({ type: "relay-register", meta: metadata(id, 100) })
    );
    await expectNoMessage(host);

    const hostMeta = nextMessage(host);
    client.send(JSON.stringify({ type: "file-meta", meta: metadata(id, 100) }));
    expect(await hostMeta).toMatchObject({ type: "file-meta", meta: { id } });
    const hostChunk = nextMessage(host);
    client.send(chunk(id, 0, 100));
    expect(await hostChunk).toMatchObject({
      binary: true,
      data: chunk(id, 0, 100),
    });
    const hostComplete = nextMessage(host);
    client.send(JSON.stringify({ type: "file-complete", id }));
    expect(await hostComplete).toMatchObject({ type: "file-complete", id });
    const clientAck = nextMessage(client);
    host.send(JSON.stringify({ type: "file-ack", fileId: id }));
    expect(await clientAck).toMatchObject({ type: "file-ack", fileId: id });
  });

  it("does not proactively reject P2P registration but rejects large ordinary fallback meta/binary in both directions", async () => {
    for (const direction of ["host", "client"] as const) {
      const { host, client } = await room();
      const sender = direction === "host" ? host : client;
      const receiver = direction === "host" ? client : host;
      const id = uuid(direction === "host" ? 3 : 4);
      const large = metadata(id, RELAY_MAX_FILE_BYTES + 1);
      sender.send(JSON.stringify({ type: "relay-register", meta: large }));
      await expectNoMessage(sender);
      await expectNoMessage(receiver);
      const senderRejected = nextMessage(sender);
      const receiverRejected = nextMessage(receiver);
      sender.send(JSON.stringify({ type: "file-meta", meta: large }));
      await expect(senderRejected).resolves.toMatchObject({
        type: "file-rejected",
        fileId: id,
        code: "RELAY_FILE_TOO_LARGE",
        maxBytes: RELAY_MAX_FILE_BYTES,
      });
      await expect(receiverRejected).resolves.toMatchObject({
        type: "file-rejected",
        fileId: id,
      });
      await expectNoMessage(receiver);
      sender.send(chunk(id, 0, FILE_CHUNK_BYTES));
      await expectNoMessage(receiver);
      for (const item of [host, client])
        if (item.readyState === WebSocket.OPEN) item.close();
    }
  });

  it("allows a large PNG image and limits a folder's aggregate ordinary bytes", async () => {
    const { host, client } = await room();
    const imageId = uuid(5);
    const image = metadata(imageId, RELAY_MAX_FILE_BYTES + 1, {
      name: "capture.png",
      mimeType: "image/png",
    });
    host.send(JSON.stringify({ type: "relay-register", meta: image }));
    const imageMeta = nextMessage(client);
    host.send(JSON.stringify({ type: "file-meta", meta: image }));
    expect(await imageMeta).toMatchObject({
      type: "file-meta",
      meta: { id: imageId },
    });
    const imageChunk = nextMessage(client);
    const firstImageLength = FILE_CHUNK_BYTES;
    const png = chunk(imageId, 0, firstImageLength);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 40);
    host.send(png);
    expect(await imageChunk).toMatchObject({ binary: true });

    const first = metadata(uuid(6), 6 * 1024 * 1024, {
      folderId: "folder",
      folderRestrictedSize: 6 * 1024 * 1024,
    });
    const second = metadata(uuid(7), 6 * 1024 * 1024, {
      folderId: "folder",
      folderRestrictedSize: 6 * 1024 * 1024,
    });
    host.send(JSON.stringify({ type: "relay-register", meta: first }));
    host.send(JSON.stringify({ type: "relay-register", meta: second }));
    const rejection = nextMessage(host);
    host.send(JSON.stringify({ type: "file-meta", meta: second }));
    expect(await rejection).toMatchObject({
      type: "file-rejected",
      fileId: second.id,
      code: "RELAY_FILE_TOO_LARGE",
    });
  });

  it("blocks unknown, malformed, and cancelled file chunks but leaves text unrestricted", async () => {
    const { host, client } = await room();
    const unknown = uuid(8);
    const senderRejected = nextMessage(host);
    const receiverRejected = nextMessage(client);
    host.send(chunk(unknown, 0, 10));
    expect(await senderRejected).toMatchObject({
      type: "file-rejected",
      fileId: unknown,
      code: "RELAY_FILE_INVALID",
    });
    expect(await receiverRejected).toMatchObject({
      type: "file-rejected",
      fileId: unknown,
    });

    const text = nextMessage(client);
    host.send(
      JSON.stringify({ type: "text", content: "chat remains available" })
    );
    expect(await text).toMatchObject({
      type: "text",
      content: "chat remains available",
    });

    const id = uuid(9);
    host.send(
      JSON.stringify({ type: "relay-register", meta: metadata(id, 100) })
    );
    const cancel = nextMessage(client);
    host.send(
      JSON.stringify({
        type: "file-cancel",
        fileId: id,
        code: "RELAY_FILE_INVALID",
        maxBytes: RELAY_MAX_FILE_BYTES,
      })
    );
    expect(await cancel).toMatchObject({ type: "file-cancel", fileId: id });
    const cancelledSender = nextMessage(host);
    const cancelledReceiver = nextMessage(client);
    host.send(chunk(id, 0, 100));
    expect(await cancelledSender).toMatchObject({
      type: "file-rejected",
      fileId: id,
      code: "RELAY_FILE_INVALID",
    });
    expect(await cancelledReceiver).toMatchObject({
      type: "file-rejected",
      fileId: id,
      code: "RELAY_FILE_INVALID",
    });
  });
});
