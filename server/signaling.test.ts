import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "http";
import { WebSocket } from "ws";
import { setupSignalingServer } from "./signaling";

let server: Server;
let port: number;

function getWsUrl(): string {
  return `ws://localhost:${port}/api/ws-signaling`;
}

function createWsClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(getWsUrl());
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once("message", (data, isBinary) => {
      if (isBinary) {
        resolve({ _binary: true, data: Buffer.from(data as Buffer) });
      } else {
        resolve(JSON.parse(data.toString()));
      }
    });
  });
}

beforeAll(async () => {
  server = createServer();
  setupSignalingServer(server);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("WebSocket Relay Server", () => {
  let clients: WebSocket[] = [];

  afterEach(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    clients = [];
  });

  it("should allow host to register with a 4-digit token", async () => {
    const host = await createWsClient();
    clients.push(host);

    const msgPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "1234" }));
    const response = await msgPromise;

    expect(response.type).toBe("registered");
    expect(response.token).toBe("1234");
  });

  it("should reject invalid token registration", async () => {
    const host = await createWsClient();
    clients.push(host);

    const msgPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "12" }));
    const response = await msgPromise;

    expect(response.type).toBe("error");
    expect(response.message).toBe("Invalid token");
  });

  it("should connect host and client when client joins", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host, client);

    // Host registers
    const registerPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "5678" }));
    await registerPromise;

    // Client joins — both should get "connected"
    const hostMsgPromise = waitForMessage(host);
    const clientMsgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "5678" }));

    const hostMsg = await hostMsgPromise;
    const clientMsg = await clientMsgPromise;

    expect(hostMsg.type).toBe("connected");
    expect(clientMsg.type).toBe("connected");
  });

  it("should return error when joining non-existent room", async () => {
    const client = await createWsClient();
    clients.push(client);

    const msgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "9999" }));
    const response = await msgPromise;

    expect(response.type).toBe("error");
    expect(response.message).toBe("No host found with this token");
  });

  it("should relay text messages between host and client", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host, client);

    // Register & join
    const regPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "4321" }));
    await regPromise;

    const hostConnPromise = waitForMessage(host);
    const clientConnPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "4321" }));
    await hostConnPromise;
    await clientConnPromise;

    // Host sends text → client should receive it
    const clientTextPromise = waitForMessage(client);
    host.send(JSON.stringify({ type: "text", content: "Hello from PC!" }));
    const textMsg = await clientTextPromise;

    expect(textMsg.type).toBe("text");
    expect(textMsg.content).toBe("Hello from PC!");

    // Client sends text → host should receive it
    const hostTextPromise = waitForMessage(host);
    client.send(JSON.stringify({ type: "text", content: "Hello from phone!" }));
    const textMsg2 = await hostTextPromise;

    expect(textMsg2.type).toBe("text");
    expect(textMsg2.content).toBe("Hello from phone!");
  });

  it("should relay binary data between host and client", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host, client);

    // Register & join
    const regPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "8888" }));
    await regPromise;

    const hostConnPromise = waitForMessage(host);
    const clientConnPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "8888" }));
    await hostConnPromise;
    await clientConnPromise;

    // Host sends binary → client should receive it
    const testData = Buffer.from("test-binary-data-12345");
    const clientBinaryPromise = waitForMessage(client);
    host.send(testData);
    const binaryMsg = await clientBinaryPromise;

    expect(binaryMsg._binary).toBe(true);
    expect(Buffer.from(binaryMsg.data).toString()).toBe("test-binary-data-12345");
  });

  it("should notify host when client disconnects", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host);

    // Register & join
    const regPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "7777" }));
    await regPromise;

    const hostConnPromise = waitForMessage(host);
    const clientConnPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "7777" }));
    await hostConnPromise;
    await clientConnPromise;

    // Client disconnects
    const hostDisconnectPromise = waitForMessage(host);
    client.close();
    const disconnectMsg = await hostDisconnectPromise;

    expect(disconnectMsg.type).toBe("peer-disconnected");
  });

  it("should respond to ping with pong", async () => {
    const host = await createWsClient();
    clients.push(host);

    const regPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "3333" }));
    await regPromise;

    const pongPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "ping" }));
    const pongMsg = await pongPromise;

    expect(pongMsg.type).toBe("pong");
  });
});
