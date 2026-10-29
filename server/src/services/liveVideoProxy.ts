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
  // Every refusal is logged with its reason: the browser only sees that the connection closed.
  const refuse = (status: string, reason: string) => {
    logger.warn({ path: req.url?.split("?")[0], status, reason, origin: req.headers.origin, host: req.headers.host }, `Live video connection refused: ${reason}`);
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  const match = PATH.exec(url.pathname);
  // An NVR channel (live view of one of its cameras).
  const channelParam = url.searchParams.get("channel");
  const channel = channelParam && /^\d{1,3}$/.test(channelParam) && Number(channelParam) >= 1 ? Number(channelParam) : undefined;
  if (!match) return refuse("404 Not Found", "not a video address");
  if (!config.LIVE_VIDEO_URL) return refuse("404 Not Found", "LIVE_VIDEO_URL is not set");
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return refuse("400 Bad Request", "not a WebSocket request");
  if (!sameOrigin(req)) return refuse("403 Forbidden", "the page's address (Origin) is not the address it was sent to (Host): a proxy in between may rewrite the Host header");
  const token = cookie(req.headers.cookie, SESSION_COOKIE);
  const auth = token ? await getSession(token) : null;
  if (!auth) return refuse("401 Unauthorized", token ? "the session has expired or was signed out" : "no session cookie came with the connection");
  if (!auth.user.organizationId || !auth.user.permissions.includes("cameras:live")) return refuse("403 Forbidden", "the user may not view live video");
  let name: string;
  try {
    if (match[2]!.toLowerCase() === "live") {
      name = await prepareStream(auth.user.organizationId, match[1]!, channel);
    } else {
      // Playback was pointed at its start time by POST .../playback/prepare for this session.
      await getCameraRow(match[1]!, auth.user.organizationId);
      name = playbackStreamName(match[1]!, auth.sessionId);
    }
  } catch (err) {
    return refuse("502 Bad Gateway", `the stream could not be prepared: ${(err as Error).message}`);
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
  upstream.once("error", (err) => logger.warn({ err: err.message, target: target.host }, "Live video: the video service (go2rtc) cannot be reached"));
  // go2rtc's answer to the handshake: 101 when it takes the viewer.
  upstream.once("data", (chunk: Buffer) => {
    const status = chunk.toString("latin1", 0, Math.min(chunk.length, 80)).split("\r\n")[0];
    if (!/^HTTP\/1\.1 101\b/.test(status ?? "")) logger.warn({ status, stream: name }, "Live video: the video service (go2rtc) did not take the viewer");
    else logger.info({ stream: name }, "Live video: viewer connected to the video service");
  });
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
