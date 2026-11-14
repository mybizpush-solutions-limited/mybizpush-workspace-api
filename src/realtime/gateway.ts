import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { env } from "../config/env";
import { verifyAccessToken } from "../lib/jwt";
import { userRoom } from "./events";

// Live updates over Socket.IO (API-CHANGES A004). Clients connect with the same
// access token they use for HTTP:
//   io(API_URL, { path: "/api/socket", auth: { token: accessToken } })
// Each connection joins `user:<id>`, the only room this gateway manages; the
// server pushes to it (notifications, badge counts, messages, sync hints). The one
// event clients send is `typing`, which the server checks and relays itself.

let io: Server | null = null;
let pub: Redis | null = null;
let sub: Redis | null = null;

export function attachRealtime(server: HttpServer): Server {
  if (io) return io;
  pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  sub = pub.duplicate();

  io = new Server(server, {
    path: "/api/socket",
    cors: { origin: env.CORS_ORIGINS, credentials: true },
    // Mobile networks drop idle sockets; keep pings frequent enough to notice.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });
  // Lets every API instance (and the emitter used by workers) reach every socket.
  io.adapter(createAdapter(pub, sub));

  io.use((socket, next) => {
    const raw = socket.handshake.auth?.token ?? socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (typeof raw !== "string" || !raw) return next(new Error("unauthorized"));
    try {
      socket.data.auth = verifyAccessToken(raw);
      next();
    } catch {
      // The app refreshes its access token and reconnects on this error.
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId: string = socket.data.auth.sub;
    void socket.join(userRoom(userId));
    socket.emit("ready", { userId });
    // Membership is checked by the service. Loaded lazily to keep the gateway
    // free of the domain code at startup.
    socket.on("typing", (payload: { conversationId?: unknown; isTyping?: unknown }) => {
      if (typeof payload?.conversationId !== "string") return;
      const { conversationId, isTyping } = payload;
      void import("../modules/chat/chat.service")
        .then(({ chatService }) => chatService.typing(conversationId, isTyping === true, userId))
        .catch(() => undefined); // not a member, or the conversation is gone
    });
  });

  console.info("✓ Realtime gateway on /api/socket");
  return io;
}

export async function closeRealtime(): Promise<void> {
  if (io) {
    await new Promise<void>((resolve) => io!.close(() => resolve()));
    io = null;
  }
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
  pub = sub = null;
}
