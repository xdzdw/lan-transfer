import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { setupSignalingServer } from "../signaling";

// IP blacklist for blocking spam/malicious traffic
const ipBlacklist = new Set<string>([
  "103.101.221.72", // Blocked due to high-frequency spam
]);

// Middleware to check IP blacklist
function ipBlacklistMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const ipAddress =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";

  if (ipBlacklist.has(ipAddress)) {
    console.warn(`[IPBlacklist] Blocking request from blacklisted IP: ${ipAddress}`);
    return res.status(403).json({
      error: "Forbidden",
      message: "Your IP address has been blocked",
    });
  }

  next();
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  
  // Apply IP blacklist middleware FIRST (before any other middleware)
  app.use(ipBlacklistMiddleware);
  
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // WebSocket signaling server for WebRTC peer connection
  setupSignalingServer(server);

  // Serve debug-collector stub in development (prevents SyntaxError from SPA fallback)
  if (process.env.NODE_ENV === "development") {
    app.get("/__manus__/debug-collector.js", (_req, res) => {
      res.set("Content-Type", "application/javascript");
      res.send("// manus debug collector stub");
    });
  }

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
