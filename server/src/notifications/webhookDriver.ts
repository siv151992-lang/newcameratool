import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import type { NotificationChannel, NotificationDriver, NotificationMessage } from "./types.js";

export const WEBHOOK_FORMATS = ["teams", "slack", "google_chat", "generic"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** Where each chat service's incoming webhooks live (generic and Teams workflows: any HTTPS address). */
const REQUIRED_HOST: Partial<Record<WebhookFormat, string>> = { slack: "hooks.slack.com", google_chat: "chat.googleapis.com" };

export const webhookConfigSchema = z
  .object({
    format: z.enum(WEBHOOK_FORMATS),
    url: z.string().trim().max(2000).superRefine((value, ctx) => {
      let u: URL;
      try {
        u = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Enter the full webhook address, starting with https://" });
        return;
      }
      if (u.protocol !== "https:") ctx.addIssue({ code: "custom", message: "The webhook address must start with https://" });
      if (u.username || u.password) ctx.addIssue({ code: "custom", message: "The webhook address must not contain a user name or password" });
    }),
  })
  .superRefine((c, ctx) => {
    const host = REQUIRED_HOST[c.format];
    if (host && URL.canParse(c.url) && new URL(c.url).hostname !== host) {
      ctx.addIssue({ code: "custom", message: `A ${c.format === "slack" ? "Slack" : "Google Chat"} webhook address starts with https://${host}/` });
    }
  });

/** Only public internet addresses: a webhook must not reach the server's own network (SSRF). */
const NOT_PUBLIC = new BlockList();
for (const c of [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
]) {
  const [a, p] = c.split("/");
  NOT_PUBLIC.addSubnet(a!, Number(p), "ipv4");
}
for (const c of ["::/127", "fc00::/7", "fe80::/10", "ff00::/8", "64:ff9b::/96", "2001:db8::/32"]) {
  const [a, p] = c.split("/");
  NOT_PUBLIC.addSubnet(a!, Number(p), "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !NOT_PUBLIC.check(mapped[1]!, "ipv4");
  const family = isIP(address);
  if (!family) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** The body each service expects. */
export function webhookBody(format: WebhookFormat, m: NotificationMessage): unknown {
  switch (format) {
    case "slack":
      return { text: `*${m.subject}*\n${m.text}` };
    case "google_chat":
      return { text: `*${m.subject}*\n${m.text}` };
    case "teams":
      // A Teams "Workflows" webhook (and the older connectors) take an Adaptive Card message.
      return {
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: m.subject, weight: "Bolder", size: "Medium", wrap: true },
              { type: "TextBlock", text: m.text, wrap: true },
            ],
          },
        }],
      };
    case "generic":
      return { subject: m.subject, text: m.text, ...(m.event ? { alert: m.event } : {}) };
  }
}

export interface WebhookDriverOptions {
  /** Tests only: resolve hosts to a local server and trust its certificate. */
  resolve?: (host: string) => Promise<string[]>;
  ca?: string;
  allowNonPublic?: boolean;
  timeoutMs?: number;
}

/**
 * Posts alerts to a chat service's incoming webhook (Microsoft Teams, Slack, Google Chat) or any
 * HTTPS endpoint as JSON. The address is a secret (anyone holding it can post), so it is stored
 * encrypted and never shown or put in error messages. Only HTTPS to public addresses, connected to
 * the address that was checked (no DNS rebinding), and redirects are not followed.
 */
export class WebhookDriver implements NotificationDriver {
  readonly type = "webhook" as const;
  readonly secretField = "url";

  constructor(private readonly opts: WebhookDriverOptions = {}) {}

  validateConfig(input: unknown) {
    return webhookConfigSchema.parse(input);
  }

  private async address(host: string): Promise<{ address: string; family: 4 | 6 }> {
    const bare = host.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(bare)) addresses = [bare];
    else if (this.opts.resolve) addresses = await this.opts.resolve(bare);
    else {
      try {
        addresses = (await lookup(bare, { all: true })).map((a) => a.address);
      } catch {
        throw new Error(`Could not resolve the webhook's host name ${bare}`);
      }
    }
    if (!addresses.length) throw new Error(`Could not resolve the webhook's host name ${bare}`);
    if (!this.opts.allowNonPublic && addresses.some((a) => !isPublicAddress(a))) {
      throw new Error(`The webhook's host ${bare} is not a public internet address; webhooks may only reach the internet`);
    }
    return { address: addresses[0]!, family: isIP(addresses[0]!) === 6 ? 6 : 4 };
  }

  async send(channel: NotificationChannel, message: NotificationMessage) {
    const { format, url } = webhookConfigSchema.parse({ ...channel.config, url: channel.secret ?? "" });
    const u = new URL(url);
    const { address, family } = await this.address(u.hostname);
    const body = JSON.stringify(webhookBody(format, message));
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          host: address,
          family,
          servername: isIP(u.hostname.replace(/^\[|\]$/g, "")) ? undefined : u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Host: u.host, "User-Agent": "CCTV-Monitoring" },
          ca: this.opts.ca,
          timeout: this.opts.timeoutMs ?? 10_000,
          agent: false,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d: string) => {
            if (text.length < 300) text += d;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve();
            const hint = status === 404 || status === 410 ? " (the webhook was deleted or its address is wrong)"
              : status === 401 || status === 403 ? " (the webhook refused the message; check it is still allowed to post)"
              : status >= 300 && status < 400 ? " (it redirects elsewhere; enter the final address)" : "";
            const said = text.replace(/\s+/g, " ").trim().slice(0, 200);
            reject(new Error(`The webhook answered HTTP ${status}${hint}${said ? `: ${said}` : ""}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("The webhook did not answer within 10 seconds")));
      req.on("error", (err) => {
        // Node's errors name the address, not the secret path; keep only the reason.
        const code = (err as NodeJS.ErrnoException).code;
        reject(new Error(code === "ECONNREFUSED" ? "The webhook's server refused the connection"
          : code?.startsWith("ERR_TLS") || code?.includes("CERT") ? `The webhook's HTTPS certificate is not valid (${code})`
          : err.message.startsWith("The webhook") ? err.message : `Could not reach the webhook: ${code ?? err.message}`));
      });
      req.end(body);
    });
  }
}
