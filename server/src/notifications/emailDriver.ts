import type { Transporter } from "nodemailer";
import { z } from "zod";
import { sendMail } from "./mailer.js";
import type { NotificationChannel, NotificationDriver } from "./types.js";

const emailConfigSchema = z.object({
  recipients: z.array(z.string().email()).min(1, "At least one recipient is required").max(20),
});

/** Email alerts through the mail server in Settings → Email & sign-in. */
export class EmailDriver implements NotificationDriver {
  readonly type = "email" as const;
  private transporter?: Transporter;

  constructor(private readonly transportFactory?: () => Transporter) {}

  validateConfig(input: unknown) {
    return emailConfigSchema.parse(input);
  }

  async send(channel: NotificationChannel, message: { subject: string; text: string }) {
    const { recipients } = emailConfigSchema.parse(channel.config);
    if (this.transportFactory) {
      this.transporter ??= this.transportFactory();
      await this.transporter.sendMail({ to: recipients.join(", "), subject: message.subject, text: message.text });
      return;
    }
    // The mail server from Settings → Email & sign-in.
    await sendMail({ to: recipients.join(", "), subject: message.subject, text: message.text });
  }
}
