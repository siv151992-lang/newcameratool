import { promises as dns } from "node:dns";

/**
 * Works out the outgoing mail server for a mailbox from its domain's MX records, the way mail apps
 * do: Zoho Mail (every data centre), Google Workspace / Gmail and Microsoft 365 are recognised.
 */

export interface DetectedMailServer {
  provider: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** Where to create the app password the mailbox needs. */
  passwordHint: string;
}

type ResolveMx = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

/** Zoho data centres by MX suffix: the SMTP server follows the same suffix. */
const ZOHO_DC: [RegExp, string, string][] = [
  [/\.zoho\.com$/, "zoho.com", ""],
  [/\.zoho\.in$/, "zoho.in", " India"],
  [/\.zoho\.eu$/, "zoho.eu", " Europe"],
  [/\.zoho\.com\.au$/, "zoho.com.au", " Australia"],
  [/\.zoho\.jp$/, "zoho.jp", " Japan"],
  [/\.zohocloud\.ca$/, "zohocloud.ca", " Canada"],
  [/\.zoho\.sa$/, "zoho.sa", " Saudi Arabia"],
  [/\.zoho\.uk$/, "zoho.uk", " UK"],
];
/** Addresses on Zoho's own domains use smtp.*; company domains hosted by Zoho use smtppro.*. */
const ZOHO_PERSONAL = /^(zoho|zohomail)\.(com|in|eu|com\.au|jp|sa|uk)$|^zohocloud\.ca$/;

const ZOHO_HINT = "In Zoho Mail: My Account → Security → App Passwords.";

export function fromMx(emailDomain: string, exchanges: string[]): DetectedMailServer | null {
  const mx = exchanges.map((e) => e.toLowerCase().replace(/\.$/, ""));
  for (const [suffix, dc, label] of ZOHO_DC) {
    if (mx.some((h) => suffix.test(h))) {
      const personal = ZOHO_PERSONAL.test(emailDomain);
      return { provider: `Zoho Mail${label}`, smtpHost: `${personal ? "smtp" : "smtppro"}.${dc}`, smtpPort: 465, smtpSecure: true, passwordHint: ZOHO_HINT };
    }
  }
  if (mx.some((h) => /(^|\.)(google\.com|googlemail\.com)$/.test(h))) {
    return { provider: "Google Workspace / Gmail", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true, passwordHint: "In your Google Account: Security → 2-Step Verification → App passwords." };
  }
  if (mx.some((h) => /\.mail\.protection\.outlook\.com$|(^|\.)outlook\.com$|hotmail\.com$/.test(h))) {
    return { provider: "Microsoft 365 / Outlook", smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false, passwordHint: "Your Microsoft 365 admin must allow SMTP sending (SMTP AUTH) for this mailbox." };
  }
  return null;
}

export async function detectMailServer(email: string, resolveMx: ResolveMx = dns.resolveMx): Promise<DetectedMailServer | null> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return null;
  // Well-known domains need no lookup.
  const known = fromMx(domain, ZOHO_PERSONAL.test(domain) ? [`mx.${domain.replace(/^zohomail\./, "zoho.")}`] : domain === "gmail.com" ? ["gmail-smtp-in.l.google.com"] : /^(outlook|hotmail|live)\.com$/.test(domain) ? ["outlook.com"] : []);
  if (known) return known;
  try {
    const records = await resolveMx(domain);
    return fromMx(domain, records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange));
  } catch {
    return null; // no MX records, or DNS unreachable
  }
}
