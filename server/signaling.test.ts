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
    ws.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
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

describe("Signaling Server", () => {
  let clients: WebSocket[] = [];

  afterEach(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
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

  it("should allow client to join an existing room", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host, client);

    // Host registers
    const registerPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "5678" }));
    await registerPromise;

    // Client joins
    const hostMsgPromise = waitForMessage(host);
    const clientMsgPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "5678" }));

    const hostMsg = await hostMsgPromise;
    const clientMsg = await clientMsgPromise;

    expect(hostMsg.type).toBe("client-joined");
    expect(clientMsg.type).toBe("joined");
    expect(clientMsg.token).toBe("5678");
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

  it("should relay signaling messages between host and client", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host, client);

    // Host registers
    const registerPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "4321" }));
    await registerPromise;

    // Client joins
    const hostJoinPromise = waitForMessage(host);
    const clientJoinPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "4321" }));
    await hostJoinPromise;
    await clientJoinPromise;

    // Host sends offer → client should receive it
    const clientOfferPromise = waitForMessage(client);
    host.send(JSON.stringify({ type: "offer", sdp: { type: "offer", sdp: "test-offer" } }));
    const offerMsg = await clientOfferPromise;

    expect(offerMsg.type).toBe("offer");
    expect(offerMsg.sdp.sdp).toBe("test-offer");

    // Client sends answer → host should receive it
    const hostAnswerPromise = waitForMessage(host);
    client.send(JSON.stringify({ type: "answer", sdp: { type: "answer", sdp: "test-answer" } }));
    const answerMsg = await hostAnswerPromise;

    expect(answerMsg.type).toBe("answer");
    expect(answerMsg.sdp.sdp).toBe("test-answer");
  });

  it("should notify host when client disconnects", async () => {
    const host = await createWsClient();
    const client = await createWsClient();
    clients.push(host);

    // Host registers
    const registerPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "7777" }));
    await registerPromise;

    // Client joins
    const hostJoinPromise = waitForMessage(host);
    const clientJoinPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "7777" }));
    await hostJoinPromise;
    await clientJoinPromise;

    // Client disconnects
    const hostDisconnectPromise = waitForMessage(host);
    client.close();
    const disconnectMsg = await hostDisconnectPromise;

    expect(disconnectMsg.type).toBe("client-disconnected");
  });
});
