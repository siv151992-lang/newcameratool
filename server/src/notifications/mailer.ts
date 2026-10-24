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
  try {
    await t.sendMail({ from: s.smtpFrom, to: message.to, subject: message.subject, text: message.text });
  } catch (err) {
    throw new Error(explainMailError(err as Error & { code?: string; responseCode?: number }, s));
  }
}

/** Turns SMTP and TLS errors into what to change in Settings → Email & sign-in. */
export function explainMailError(err: Error & { code?: string; responseCode?: number }, s: Pick<EmailSettings, "smtpHost" | "smtpPort" | "smtpSecure">): string {
  const m = err.message;
  const at = `${s.smtpHost}:${s.smtpPort}`;
  if (/wrong version number|ssl3_get_record|tls_validate_record_header/i.test(m)) {
    return s.smtpSecure
      ? `${at} does not start with SSL. For port 587, turn off "Use SSL/TLS from the start"; for Zoho or Gmail use port 465 with it on. If the port is already 465, a firewall or antivirus on this network is intercepting the connection.`
      : `${at} answered in an unexpected way. Check the port: 465 with SSL/TLS on, or 587 with it off.`;
  }
  if (s.smtpSecure === false && s.smtpPort === 465 && /greeting|ETIMEDOUT|timeout|ECONNRESET/i.test(`${err.code} ${m}`)) {
    return `Port 465 needs "Use SSL/TLS from the start" turned on.`;
  }
  if (err.code === "EAUTH" || err.responseCode === 535) {
    return "The mail server refused the username or password. Use the full mailbox address and an app password (Zoho: accounts.zoho.com → Security → App Passwords), and check SMTP access is allowed for the mailbox.";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(`${err.code} ${m}`)) return `The server name ${s.smtpHost} could not be found. Check the spelling, and that this server can resolve internet names (DNS).`;
  if (/ECONNREFUSED/.test(`${err.code} ${m}`)) return `${at} refused the connection. Check the port (465 or 587).`;
  if (/ETIMEDOUT|ESOCKET|timeout/i.test(`${err.code} ${m}`)) return `Could not reach ${at}: a firewall may block outgoing mail ports. Ask IT to allow outbound port ${s.smtpPort} from this server.`;
  if (err.responseCode === 553 || err.responseCode === 550 || /sender|not allowed|relay/i.test(m)) {
    return `The mail server refused the sender. Set "Send as (From address)" to the same mailbox as the username. (${m.slice(0, 120)})`;
  }
  return m.slice(0, 300);
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
