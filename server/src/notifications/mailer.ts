import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * Account emails (invitations, email verification, password reset) through the SMTP server in the
 * environment. Links need PUBLIC_URL, the address people open the dashboard at; it comes from
 * configuration, never from request headers, so a forged Host header cannot redirect a link.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

type Sender = (m: MailMessage) => Promise<void>;
let transporter: Transporter | undefined;
let override: Sender | undefined;

/** Tests capture messages instead of sending them. Pass undefined to restore SMTP. */
export function setMailSender(sender: Sender | undefined) {
  override = sender;
}

/** Whether account emails can be sent at all. */
export function mailConfigured(): boolean {
  return Boolean(override || (config.SMTP_HOST && config.PUBLIC_URL));
}

/** Absolute link to a dashboard page, or null without PUBLIC_URL. */
export function publicLink(path: string): string | null {
  const base = config.PUBLIC_URL ?? (override ? "http://dashboard.test" : undefined);
  return base ? `${base.replace(/\/$/, "")}${path}` : null;
}

export async function sendMail(message: MailMessage): Promise<void> {
  if (override) return override(message);
  if (!config.SMTP_HOST) throw new Error("Email is not configured on the server (SMTP_HOST)");
  transporter ??= nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  });
  await transporter.sendMail({ from: config.SMTP_FROM, to: message.to, subject: message.subject, text: message.text });
}

/** Sends without failing the caller; returns the reason when it could not be sent. */
export async function trySendMail(message: MailMessage): Promise<{ sent: boolean; error?: string }> {
  if (!mailConfigured()) return { sent: false, error: "Email is not configured on the server (SMTP_HOST and PUBLIC_URL)" };
  try {
    await sendMail(message);
    return { sent: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Account email could not be sent");
    return { sent: false, error: (err as Error).message.slice(0, 300) };
  }
}
