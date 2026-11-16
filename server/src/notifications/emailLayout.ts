import { BRAND_LOGO_PNG } from "./brandLogo.js";

/**
 * The look of every email: the IBMS mark and product name on a dark band, a white card for the
 * message, and a short footer. Table layout and inline styles, which every mail program (Outlook
 * included) shows the same way. The logo travels inline with the email (cid:ibms-logo), so it shows
 * without loading anything from the internet.
 */

export const LOGO_CID = "ibms-logo";
export const logoAttachment = () => ({ filename: "ibms.png", content: BRAND_LOGO_PNG, contentType: "image/png", cid: LOGO_CID });

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const COLORS = { brand: "#0f2a44", accent: "#1d6fd8", ink: "#1f2937", muted: "#6b7280", line: "#e5e7eb", good: "#15803d", warn: "#b45309", bad: "#b91c1c", page: "#f3f4f6" };

/** A full HTML email around `body` (already HTML). `preheader` is the line mail programs show in the list. */
export function brandedEmail({ title, body, preheader, footer }: { title: string; body: string; preheader?: string; footer?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};${FONT};color:${COLORS.ink}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px">
<tr><td style="background:${COLORS.brand};border-radius:10px 10px 0 0;padding:16px 24px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td style="padding-right:12px"><img src="cid:${LOGO_CID}" width="40" height="40" alt="IBMS" style="display:block;border-radius:6px"></td>
    <td style="${FONT};color:#ffffff"><div style="font-size:16px;font-weight:700;letter-spacing:.2px">Zoho IBMS</div><div style="font-size:11px;letter-spacing:1.5px;color:#a9c1dc">CCTV MONITORING</div></td>
  </tr></table>
</td></tr>
<tr><td style="background:#ffffff;padding:24px;border:1px solid ${COLORS.line};border-top:0;border-radius:0 0 10px 10px;${FONT};font-size:14px;line-height:1.55">
  <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${COLORS.ink}">${esc(title)}</h1>
  ${body}
</td></tr>
<tr><td style="padding:14px 8px;${FONT};font-size:12px;color:${COLORS.muted};text-align:center">
  ${footer ?? "Sent by Zoho IBMS CCTV Monitoring. You receive this because your address is set up to get these emails."}
</td></tr>
</table></td></tr></table></body></html>`;
}

/** A button link (a plain link under it for mail programs that block buttons). */
export function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px"><tr><td style="background:${COLORS.accent};border-radius:6px">
<a href="${esc(href)}" style="display:inline-block;padding:10px 18px;${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${esc(label)}</a></td></tr></table>
<p style="margin:0 0 4px;font-size:12px;color:${COLORS.muted}">Or copy this link: <a href="${esc(href)}" style="color:${COLORS.accent};word-break:break-all">${esc(href)}</a></p>`;
}

/** A label–value table (alert details, settings). */
export function detailsTable(rows: [string, string][]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0;border:1px solid ${COLORS.line};border-radius:6px;border-collapse:separate">${rows
    .map(([k, v], i) => `<tr><td style="padding:8px 12px;width:34%;color:${COLORS.muted};font-size:13px;${i ? `border-top:1px solid ${COLORS.line}` : ""}">${esc(k)}</td><td style="padding:8px 12px;font-size:13px;${i ? `border-top:1px solid ${COLORS.line}` : ""}">${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

/** A coloured label (severity, status). */
export function pill(text: string, color: string): string {
  return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${color};color:#ffffff;font-size:12px;font-weight:600;letter-spacing:.3px">${esc(text)}</span>`;
}

const URL_LINE = /^https?:\/\/\S+$/;

/**
 * A plain-text email (account emails) in the branded layout: paragraphs as written, and a line
 * that is only a link becomes a button labelled `actionLabel`.
 */
export function textEmail(subject: string, text: string, actionLabel = "Open"): string {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const body = blocks
    .map((b) => (URL_LINE.test(b) ? button(b, actionLabel) : `<p style="margin:0 0 12px">${esc(b).replace(/\n/g, "<br>")}</p>`))
    .join("\n");
  return brandedEmail({ title: subject.replace(/^\[[^\]]*\]\s*/, ""), body, preheader: blocks[0]?.slice(0, 140) });
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const SEVERITY_COLOR: Record<string, string> = { critical: COLORS.bad, warning: COLORS.warn, info: COLORS.accent };

/** An alert email: what happened, on which camera, how serious, and a button to the camera. */
export function alertEmail(m: {
  subject: string;
  text: string;
  event?: { kind: string; severity: string; title: string; description: string; cameraName: string; cameraHost: string; type: string; url?: string };
}): string {
  const e = m.event;
  if (!e) return textEmail(m.subject, m.text);
  const resolved = e.kind === "resolved";
  const label = resolved ? "Resolved" : e.kind === "escalated" ? `${e.severity} · escalated` : e.severity;
  const body = [
    `<p style="margin:0 0 10px">${pill(label.toUpperCase(), resolved ? COLORS.good : SEVERITY_COLOR[e.severity] ?? COLORS.muted)}</p>`,
    `<p style="margin:0 0 6px;font-size:16px;font-weight:600">${esc(e.title)}</p>`,
    `<p style="margin:0 0 4px;color:${COLORS.muted}">${esc(resolved ? "The problem has cleared and the alert is closed." : e.description)}</p>`,
    detailsTable([
      ["Camera", e.cameraName],
      ["Address", e.cameraHost],
      ["Problem type", cap(e.type.replace(/_/g, " "))],
      ["Severity", cap(e.severity)],
      ["Time", new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"],
    ]),
    e.url ? button(e.url, "Open camera") : "",
  ].join("\n");
  return brandedEmail({
    title: resolved ? "Alert resolved" : "Camera alert",
    body,
    preheader: `${e.title} – ${e.cameraName}`,
    footer: "Sent by Zoho IBMS CCTV Monitoring to this notification channel. Change what is sent in Settings → Notifications.",
  });
}
