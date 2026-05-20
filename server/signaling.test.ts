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

/** Helper: register host + join client, return both connected */
async function setupRoom(token: string): Promise<{ host: WebSocket; client: WebSocket }> {
  const host = await createWsClient();
  const client = await createWsClient();

  const regPromise = waitForMessage(host);
  host.send(JSON.stringify({ type: "register", token }));
  await regPromise;

  const hostConnPromise = waitForMessage(host);
  const clientConnPromise = waitForMessage(client);
  client.send(JSON.stringify({ type: "join", token }));
  await hostConnPromise;
  await clientConnPromise;

  return { host, client };
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

describe("WebSocket Relay + WebRTC Signaling Server", () => {
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

    const registerPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "5678" }));
    await registerPromise;

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
    const { host, client } = await setupRoom("4321");
    clients.push(host, client);

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
    const { host, client } = await setupRoom("8888");
    clients.push(host, client);

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

    const regPromise = waitForMessage(host);
    host.send(JSON.stringify({ type: "register", token: "7777" }));
    await regPromise;

    const hostConnPromise = waitForMessage(host);
    const clientConnPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "join", token: "7777" }));
    await hostConnPromise;
    await clientConnPromise;

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

  // ===== WebRTC Signaling Tests =====

  it("should relay rtc-offer from host to client", async () => {
    const { host, client } = await setupRoom("2001");
    clients.push(host, client);

    const fakeSdp = { type: "offer", sdp: "v=0\r\nfake-sdp-offer" };
    const clientMsgPromise = waitForMessage(client);
    host.send(JSON.stringify({ type: "rtc-offer", sdp: fakeSdp }));
    const msg = await clientMsgPromise;

    expect(msg.type).toBe("rtc-offer");
    expect(msg.sdp).toEqual(fakeSdp);
  });

  it("should relay rtc-answer from client to host", async () => {
    const { host, client } = await setupRoom("2002");
    clients.push(host, client);

    const fakeSdp = { type: "answer", sdp: "v=0\r\nfake-sdp-answer" };
    const hostMsgPromise = waitForMessage(host);
    client.send(JSON.stringify({ type: "rtc-answer", sdp: fakeSdp }));
    const msg = await hostMsgPromise;

    expect(msg.type).toBe("rtc-answer");
    expect(msg.sdp).toEqual(fakeSdp);
  });

  it("should relay rtc-ice candidates in both directions", async () => {
    const { host, client } = await setupRoom("2003");
    clients.push(host, client);

    const fakeCandidate = {
      candidate: "candidate:1 1 udp 2130706431 192.168.1.100 12345 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };

    // Host → Client
    const clientIcePromise = waitForMessage(client);
    host.send(JSON.stringify({ type: "rtc-ice", candidate: fakeCandidate }));
    const clientIce = await clientIcePromise;

    expect(clientIce.type).toBe("rtc-ice");
    expect(clientIce.candidate).toEqual(fakeCandidate);

    // Client → Host
    const hostIcePromise = waitForMessage(host);
    client.send(JSON.stringify({ type: "rtc-ice", candidate: fakeCandidate }));
    const hostIce = await hostIcePromise;

    expect(hostIce.type).toBe("rtc-ice");
    expect(hostIce.candidate).toEqual(fakeCandidate);
  });

  it("should relay file-meta and file-complete messages", async () => {
    const { host, client } = await setupRoom("2004");
    clients.push(host, client);

    // file-meta from client → host
    const fileMeta = {
      type: "file-meta",
      meta: { id: "test-file-id", name: "photo.jpg", size: 1024, mimeType: "image/jpeg", totalChunks: 1 },
    };
    const hostMetaPromise = waitForMessage(host);
    client.send(JSON.stringify(fileMeta));
    const metaMsg = await hostMetaPromise;

    expect(metaMsg.type).toBe("file-meta");
    expect(metaMsg.meta.id).toBe("test-file-id");
    expect(metaMsg.meta.name).toBe("photo.jpg");

    // file-complete from client → host
    const hostCompletePromise = waitForMessage(host);
    client.send(JSON.stringify({ type: "file-complete", id: "test-file-id" }));
    const completeMsg = await hostCompletePromise;

    expect(completeMsg.type).toBe("file-complete");
    expect(completeMsg.id).toBe("test-file-id");
  });

  it("should reject joining a full room", async () => {
    const { host, client } = await setupRoom("2005");
    clients.push(host, client);

    // Third client tries to join
    const third = await createWsClient();
    clients.push(third);

    const thirdMsgPromise = waitForMessage(third);
    third.send(JSON.stringify({ type: "join", token: "2005" }));
    const msg = await thirdMsgPromise;

    expect(msg.type).toBe("error");
    expect(msg.message).toBe("Room is already full");
  });

  // ===== Reconnection Tests =====

  it("should notify host with permanent=false when client disconnects", async () => {
    const { host, client } = await setupRoom("3001");
    clients.push(host);

    const hostMsgPromise = waitForMessage(host);
    client.close();
    const msg = await hostMsgPromise;

    expect(msg.type).toBe("peer-disconnected");
    expect(msg.permanent).toBe(false);
  });

  it("should allow client to rejoin after disconnect", async () => {
    const host = await createWsClient();
    const client1 = await createWsClient();
    clients.push(host);

    // Register host
    host.send(JSON.stringify({ type: "register", token: "3002" }));
    await waitForMessage(host); // registered

    // Join client
    client1.send(JSON.stringify({ type: "join", token: "3002" }));
    await waitForMessage(host); // connected
    await waitForMessage(client1); // connected

    // Client disconnects
    client1.close();
    await waitForMessage(host); // peer-disconnected

    // Small delay to ensure server processes the close
    await new Promise(r => setTimeout(r, 50));

    // Collect all messages from host in background
    const hostMessages: any[] = [];
    const hostMsgHandler = (data: any) => { hostMessages.push(JSON.parse(data.toString())); };
    host.on("message", hostMsgHandler);

    // Client reconnects via rejoin
    const client2 = await createWsClient();
    clients.push(client2);

    const client2Messages: any[] = [];
    const client2MsgHandler = (data: any) => { client2Messages.push(JSON.parse(data.toString())); };
    client2.on("message", client2MsgHandler);

    client2.send(JSON.stringify({ type: "rejoin", token: "3002", role: "client" }));

    // Wait for messages to arrive
    await new Promise(r => setTimeout(r, 200));

    host.off("message", hostMsgHandler);
    client2.off("message", client2MsgHandler);

    // Verify client2 received rejoined + connected
    expect(client2Messages.some(m => m.type === "rejoined")).toBe(true);
    expect(client2Messages.some(m => m.type === "connected" && m.reconnected === true)).toBe(true);

    // Verify host received peer-reconnected
    expect(hostMessages.some(m => m.type === "peer-reconnected" && m.role === "client")).toBe(true);
  });

  it("should allow host to re-register after disconnect", async () => {
    const host1 = await createWsClient();
    const client = await createWsClient();
    clients.push(client);

    // Register host
    host1.send(JSON.stringify({ type: "register", token: "3003" }));
    await waitForMessage(host1); // registered

    // Join client
    client.send(JSON.stringify({ type: "join", token: "3003" }));
    await waitForMessage(host1); // connected
    await waitForMessage(client); // connected

    // Host disconnects
    host1.close();
    await waitForMessage(client); // peer-disconnected

    // Small delay
    await new Promise(r => setTimeout(r, 50));

    // Collect messages
    const clientMessages: any[] = [];
    const clientMsgHandler = (data: any) => { clientMessages.push(JSON.parse(data.toString())); };
    client.on("message", clientMsgHandler);

    // Host reconnects via register with same token
    const host2 = await createWsClient();
    clients.push(host2);

    const host2Messages: any[] = [];
    const host2MsgHandler = (data: any) => { host2Messages.push(JSON.parse(data.toString())); };
    host2.on("message", host2MsgHandler);

    host2.send(JSON.stringify({ type: "register", token: "3003" }));

    // Wait for messages
    await new Promise(r => setTimeout(r, 200));

    client.off("message", clientMsgHandler);
    host2.off("message", host2MsgHandler);

    // Verify host2 received registered + connected
    expect(host2Messages.some(m => m.type === "registered")).toBe(true);
    expect(host2Messages.some(m => m.type === "connected" && m.reconnected === true)).toBe(true);

    // Verify client received peer-reconnected
    expect(clientMessages.some(m => m.type === "peer-reconnected" && m.role === "host")).toBe(true);
  });

  it("should relay messages after client rejoin", async () => {
    const host = await createWsClient();
    const client1 = await createWsClient();
    clients.push(host);

    // Register host
    host.send(JSON.stringify({ type: "register", token: "3004" }));
    await waitForMessage(host); // registered

    // Join client
    client1.send(JSON.stringify({ type: "join", token: "3004" }));
    await waitForMessage(host); // connected
    await waitForMessage(client1); // connected

    // Client disconnects
    client1.close();
    await waitForMessage(host); // peer-disconnected

    await new Promise(r => setTimeout(r, 50));

    // Drain host messages during rejoin
    const drainHost: any[] = [];
    const drainHandler = (data: any) => { drainHost.push(JSON.parse(data.toString())); };
    host.on("message", drainHandler);

    // Client reconnects
    const client2 = await createWsClient();
    clients.push(client2);

    const client2Msgs: any[] = [];
    const c2Handler = (data: any) => { client2Msgs.push(JSON.parse(data.toString())); };
    client2.on("message", c2Handler);

    client2.send(JSON.stringify({ type: "rejoin", token: "3004", role: "client" }));

    // Wait for rejoin to complete
    await new Promise(r => setTimeout(r, 200));

    host.off("message", drainHandler);
    client2.off("message", c2Handler);

    // Verify rejoin succeeded
    expect(client2Msgs.some(m => m.type === "connected" && m.reconnected === true)).toBe(true);

    // Now verify relay still works
    const relayPromise = waitForMessage(client2);
    host.send(JSON.stringify({ type: "text", content: "after-reconnect" }));
    const msg = await relayPromise;
    expect(msg.type).toBe("text");
    expect(msg.content).toBe("after-reconnect");
  });

  it("should return error when rejoin to non-existent room", async () => {
    const ws = await createWsClient();
    clients.push(ws);

    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "rejoin", token: "9998", role: "client" }));
    const msg = await msgPromise;
    expect(msg.type).toBe("error");
    expect(msg.message).toContain("expired");
  });
});
