import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../lib/logger.js";
import { type EmailSettings, getEmailSettings } from "../services/emailSettings.js";

/**
 * Every email the server sends (alerts, invitations, email confirmation, password reset) goes
 * through the SMTP server in Settings → Email & sign-in. Links use the dashboard address saved there
 * (the public URL), never request headers, so a forged Host header cannot redirect a link.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

type Sender = (m: MailMessage) => Promise<void>;
let transport: { key: string; value: Transporter } | undefined;
let override: Sender | undefined;

/** Tests capture messages instead of sending them. Pass undefined to restore SMTP. */
export function setMailSender(sender: Sender | undefined) {
  override = sender;
}

/** Whether account emails can be sent at all: an SMTP server and the dashboard address. */
export async function mailConfigured(): Promise<boolean> {
  if (override) return true;
  const s = await getEmailSettings();
  return Boolean(s.smtpHost && s.publicUrl);
}

/** Absolute link to a dashboard page, or null without the dashboard address. */
export async function publicLink(path: string): Promise<string | null> {
  const base = (await getEmailSettings()).publicUrl ?? (override ? "http://dashboard.test" : null);
  return base ? `${base}${path}` : null;
}

const smtpOptions = (s: EmailSettings) => ({
  host: s.smtpHost!,
  port: s.smtpPort,
  secure: s.smtpSecure,
  auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword ?? "" } : undefined,
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
});

/** One transport, rebuilt when the settings change. */
function transportFor(s: EmailSettings): Transporter {
  const options = smtpOptions(s);
  const key = JSON.stringify(options);
  if (transport?.key !== key) transport = { key, value: nodemailer.createTransport(options) };
  return transport.value;
}

/** Sends with the saved settings, or with `settings` (a test from the settings page). */
export async function sendMail(message: MailMessage, settings?: EmailSettings): Promise<void> {
  if (override && !settings) return override(message);
  const s = settings ?? (await getEmailSettings());
  if (!s.smtpHost) throw new Error("Email is not set up. A system administrator can add the mail server in Settings → Email & sign-in.");
  const t = settings ? nodemailer.createTransport(smtpOptions(s)) : transportFor(s);
  await t.sendMail({ from: s.smtpFrom, to: message.to, subject: message.subject, text: message.text });
}

/** Sends without failing the caller; returns the reason when it could not be sent. */
export async function trySendMail(message: MailMessage): Promise<{ sent: boolean; error?: string }> {
  if (!(await mailConfigured())) {
    return { sent: false, error: "Email is not set up (mail server and dashboard address in Settings → Email & sign-in)" };
  }
  try {
    await sendMail(message);
    return { sent: true };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Email could not be sent");
    return { sent: false, error: (err as Error).message.slice(0, 300) };
  }
}
