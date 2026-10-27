import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NotificationChannel } from "../../src/notifications/types.js";
import { isPublicAddress, WebhookDriver, webhookBody } from "../../src/notifications/webhookDriver.js";

const fixture = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const tls = { cert: fixture("camera-self-signed.pem"), key: fixture("camera-self-signed.key") }; // CN=IPC

const received: { path?: string; body: unknown; contentType?: string }[] = [];
let reply = { status: 200, body: "ok" };
const server = https.createServer(tls, (req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    received.push({ path: req.url, body: JSON.parse(body), contentType: req.headers["content-type"] });
    res.statusCode = reply.status;
    res.end(reply.body);
  });
});
const port = () => (server.address() as AddressInfo).port;
const local = new WebhookDriver({ resolve: async () => ["127.0.0.1"], ca: tls.cert, allowNonPublic: true });
const channel = (format: string, url: string): NotificationChannel => ({
  id: "c", type: "webhook", name: "Chat", enabled: true, config: { format, host: "ipc" }, min_severity: "warning",
  cooldown_minutes: 0, notify_on_recovery: true, secret: url,
});
const message = { subject: "[CCTV CRITICAL] Camera offline – Lobby (10.0.0.5)", text: "No answer for 3 checks" };

beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", r)));
afterAll(() => server.close());

describe("webhook driver", () => {
  it("posts each service's format as JSON to the stored address", async () => {
    received.length = 0;
    reply = { status: 200, body: "ok" };
    await local.send(channel("generic", `https://ipc:${port()}/hooks/abc?key=s3cret`), message);
    await local.send(channel("teams", `https://ipc:${port()}/workflows/x`), message);
    expect(received[0]).toEqual({ path: "/hooks/abc?key=s3cret", body: { subject: message.subject, text: message.text }, contentType: "application/json" });
    expect((received[1]!.body as { attachments: { content: { body: { text: string }[] } }[] }).attachments[0]!.content.body[0]!.text).toBe(message.subject);
  });

  it("explains a refusal without revealing the secret address", async () => {
    reply = { status: 404, body: "no such hook" };
    const err = await local.send(channel("generic", `https://ipc:${port()}/hooks/SECRET-TOKEN`), message).catch((e: Error) => e);
    expect((err as Error).message).toBe("The webhook answered HTTP 404 (the webhook was deleted or its address is wrong): no such hook");
    expect((err as Error).message).not.toContain("SECRET-TOKEN");
  });

  it("refuses addresses on the server's own network, and plain http", async () => {
    const strict = new WebhookDriver({ resolve: async () => ["10.0.0.7"] });
    await expect(strict.send(channel("generic", "https://intranet.example/hook"), message)).rejects.toThrow(/not a public internet address/);
    await expect(strict.send(channel("generic", "https://127.0.0.1/hook"), message)).rejects.toThrow(/not a public internet address/);
    expect(() => strict.validateConfig({ format: "generic", url: "http://example.com/hook" })).toThrow(/must start with https:\/\//);
    expect(() => strict.validateConfig({ format: "slack", url: "https://example.com/services/x" })).toThrow(/https:\/\/hooks\.slack\.com\//);
    expect(strict.validateConfig({ format: "slack", url: "https://hooks.slack.com/services/T/B/x" })).toMatchObject({ format: "slack" });
  });

  it("knows public from private addresses", () => {
    for (const a of ["8.8.8.8", "2606:4700::1111", "52.1.2.3"]) expect(isPublicAddress(a)).toBe(true);
    for (const a of ["10.1.1.1", "172.20.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPublicAddress(a)).toBe(false);
    }
  });

  it("formats Slack and Google Chat as text", () => {
    expect(webhookBody("slack", message)).toEqual({ text: `*${message.subject}*\n${message.text}` });
    expect(webhookBody("google_chat", message)).toEqual({ text: `*${message.subject}*\n${message.text}` });
  });
});
