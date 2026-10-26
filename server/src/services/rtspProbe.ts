import net from "node:net";
import { digestAuthorization, parseChallenge } from "../integrations/http/cameraHttpClient.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { readRtsp } from "./rtspReplayRelay.js";

export interface ProbeTarget {
  host: string;
  port: number;
  /** Path and query of the stream. */
  path: string;
  username: string;
  password: string;
}

/**
 * Asks the camera for a stream's description (RTSP DESCRIBE, logging in when asked) and returns
 * the camera's status: 200 when the stream exists and the login is accepted, 401 when the login is
 * refused, 404 when there is no such stream; 0 when the camera did not answer.
 */
export async function probeRtsp(t: ProbeTarget, timeoutMs = 5000): Promise<number> {
  const { address } = await hostGuard.resolve(t.host);
  const host = net.isIP(t.host) === 6 ? `[${t.host}]` : t.host;
  const uri = `rtsp://${host}:${t.port}${t.path.startsWith("/") ? "" : "/"}${t.path}`;
  return new Promise<number>((resolve) => {
    const socket = net.connect({ host: address, port: t.port });
    let buf: Buffer = Buffer.alloc(0);
    let cseq = 0;
    let authorized = false;
    const done = (status: number) => {
      socket.destroy();
      resolve(status);
    };
    const describe = (authorization?: string) => {
      cseq += 1;
      socket.write(
        [`DESCRIBE ${uri} RTSP/1.0`, `CSeq: ${cseq}`, "Accept: application/sdp", "User-Agent: cctv-monitor", ...(authorization ? [`Authorization: ${authorization}`] : []), "", ""].join("\r\n"),
      );
    };
    socket.setTimeout(timeoutMs, () => done(0));
    socket.on("error", () => done(0));
    socket.on("connect", () => describe());
    socket.on("data", (chunk) => {
      try {
        buf = readRtsp(
          Buffer.concat([buf, chunk]),
          (m) => {
            const status = Number(/^RTSP\/\S+\s+(\d{3})/.exec(m.first)?.[1] ?? 0);
            if (status === 401 && !authorized) {
              authorized = true;
              const offered = m.headers.filter(([k]) => k.toLowerCase() === "www-authenticate").map(([, v]) => v);
              const digest = offered.find((v) => /^digest\s/i.test(v));
              if (digest) return describe(digestAuthorization(parseChallenge(digest), t.username, t.password, "DESCRIBE", uri));
              if (offered.some((v) => /^basic\b/i.test(v))) return describe(`Basic ${Buffer.from(`${t.username}:${t.password}`).toString("base64")}`);
            }
            done(status);
          },
          () => undefined,
        );
      } catch {
        done(0);
      }
    });
  });
}

/** What a probe status means, for messages. */
export function probeReason(status: number): string {
  if (status === 401 || status === 403) return "the camera refused the login (check the camera user's password and its permission to view video)";
  if (status === 404) return "the camera has no stream at this address (the stream may be turned off, or set to another video format)";
  if (status === 0) return "the camera did not answer on its RTSP port";
  return `the camera answered ${status}`;
}
