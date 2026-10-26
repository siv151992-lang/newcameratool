import type http from "node:http";
import net from "node:net";
import { SESSION_COOKIE, getSession } from "../auth/sessions.js";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { getCameraRow } from "./cameraService.js";
import { playbackStreamName, prepareStream } from "./liveVideoService.js";

/**
 * Passes a browser's live video or playback WebSocket (/api/cameras/:id/live/ws, /playback/ws) through to go2rtc after
 * checking the session, the cameras:live permission and that the camera is in the session's
 * organization. The bytes are relayed unchanged; nothing is stored.
 */

const PATH = /^\/api\/cameras\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(live|playback)\/ws$/i;
const MAX_VIEWING_MS = 60 * 60_000; // a forgotten window does not stream forever

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** A WebSocket from another site would carry the session cookie too: the Origin must be this dashboard. */
function sameOrigin(req: http.IncomingMessage): boolean {
  try {
    return new URL(req.headers.origin ?? "").host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachLiveVideo(server: http.Server) {
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    void relay(req, socket, head).catch((err) => {
      logger.warn({ err: (err as Error).message }, "Live video connection failed");
      socket.destroy();
    });
  });
}

async function relay(req: http.IncomingMessage, socket: net.Socket, head: Buffer) {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = PATH.exec(url.pathname);
  // An NVR channel (live view of one of its cameras).
  const channelParam = url.searchParams.get("channel");
  const channel = channelParam && /^\d{1,3}$/.test(channelParam) && Number(channelParam) >= 1 ? Number(channelParam) : undefined;
  if (!match || !config.LIVE_VIDEO_URL) return refuse("404 Not Found");
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return refuse("400 Bad Request");
  if (!sameOrigin(req)) return refuse("403 Forbidden");
  const token = cookie(req.headers.cookie, SESSION_COOKIE);
  const auth = token ? await getSession(token) : null;
  if (!auth) return refuse("401 Unauthorized");
  if (!auth.user.organizationId || !auth.user.permissions.includes("cameras:live")) return refuse("403 Forbidden");
  let name: string;
  try {
    if (match[2]!.toLowerCase() === "live") {
      name = await prepareStream(auth.user.organizationId, match[1]!, channel);
    } else {
      // Playback was pointed at its start time by POST .../playback/prepare for this session.
      await getCameraRow(match[1]!, auth.user.organizationId);
      name = playbackStreamName(match[1]!, auth.sessionId);
    }
  } catch {
    return refuse("502 Bad Gateway");
  }

  const target = new URL(config.LIVE_VIDEO_URL);
  const upstream = net.connect(Number(target.port) || 80, target.hostname);
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  const limit = setTimeout(close, MAX_VIEWING_MS);
  socket.on("close", () => clearTimeout(limit));
  for (const s of [socket, upstream]) {
    s.on("error", close);
    s.on("close", close);
  }
  upstream.on("connect", () => {
    const path = `${target.pathname.replace(/\/+$/, "")}/api/ws?src=${encodeURIComponent(name)}`;
    upstream.write(
      [`GET ${path} HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", "", ""].join("\r\n"),
    );
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}
