import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { config } from "../config.js";
import type { NotificationChannel, NotificationDriver } from "./types.js";

const emailConfigSchema = z.object({
  recipients: z.array(z.string().email()).min(1, "At least one recipient is required").max(20),
});

/** Email via SMTP. SMTP credentials come from environment variables, never from the database. */
export class EmailDriver implements NotificationDriver {
  readonly type = "email" as const;
  private transporter?: Transporter;

  constructor(private readonly transportFactory?: () => Transporter) {}

  validateConfig(input: unknown) {
    return emailConfigSchema.parse(input);
  }

  private getTransport(): Transporter {
    if (this.transporter) return this.transporter;
    if (this.transportFactory) return (this.transporter = this.transportFactory());
    if (!config.SMTP_HOST) throw new Error("SMTP is not configured (set SMTP_HOST and related variables)");
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    });
    return this.transporter;
  }

  async send(channel: NotificationChannel, message: { subject: string; text: string }) {
    const { recipients } = emailConfigSchema.parse(channel.config);
    await this.getTransport().sendMail({ from: config.SMTP_FROM, to: recipients.join(", "), subject: message.subject, text: message.text });
  }
}
