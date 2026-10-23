import { type Request, Router } from "express";
import { z } from "zod";
import { actorOf, orgOf, requirePermission } from "../auth/middleware.js";
import { SYSTEM_PERMISSION } from "../auth/sessions.js";
import { HttpError } from "../lib/errors.js";
import { pool } from "../db/pool.js";
import { registry } from "../integrations/registry.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { param, parse } from "../lib/validate.js";
import { notifier } from "../notifications/notifier.js";
import { audit, exportAuditCsv, listAudit } from "../services/auditService.js";
import {
  channelInputSchema,
  channelUpdateSchema,
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannel,
} from "../services/notificationChannelService.js";
import { camerasOutside, getNetworkSettings, networkSettingsSchema, updateNetworkSettings } from "../services/networkSettings.js";
import { emailSettingsSchema, emailSettingsView, getEmailSettings, updateEmailSettings } from "../services/emailSettings.js";
import { sendMail } from "../notifications/mailer.js";
import { deviceLimiter } from "./limits.js";
import {
  createOrganization,
  createOrganizationSchema,
  listMembers,
  listOrganizations,
  removeMember,
  updateMember,
  updateMemberSchema,
  updateOrganization,
  updateOrganizationSchema,
} from "../services/organizationService.js";
import {
  getMonitoringSettings,
  monitoringSettingsSchema,
  ORGANIZATION_SETTING_KEYS,
  serverWideKeys,
  updateMonitoringSettings,
} from "../services/settingsService.js";
import { invite, inviteSchema, listInvitations, resend, revoke } from "../services/invitationService.js";

const isSystemAdmin = (req: Request) => req.auth!.user.isSystemAdmin;

export const brandsRouter = Router();
brandsRouter.get("/", requirePermission("cameras:read"), async (req, res) => {
  const { rows } = await pool.query<{ brand_key: string; n: number }>(
    "SELECT brand_key, count(*)::int AS n FROM cameras WHERE organization_id = $1 AND deleted_at IS NULL GROUP BY brand_key",
    [orgOf(req)],
  );
  const counts = new Map(rows.map((r) => [r.brand_key, r.n]));
  res.json(registry.list().map((b) => ({ ...b, cameraCount: counts.get(b.key) ?? 0 })));
});

export const settingsRouter = Router();
// Thresholds and detection are the organization's; worker capacity, timeouts and retention are server-wide.
settingsRouter.get("/monitoring", requirePermission("settings:read"), async (req, res) => {
  res.setHeader("X-Organization-Settings", ORGANIZATION_SETTING_KEYS.join(","));
  res.json(await getMonitoringSettings(orgOf(req)));
});
settingsRouter.patch("/monitoring", requirePermission("settings:write"), async (req, res) => {
  const patch = parse(monitoringSettingsSchema.partial(), req.body);
  const serverWide = serverWideKeys(patch);
  if (serverWide.length && !isSystemAdmin(req)) {
    throw new HttpError(403, "FORBIDDEN", `Only the system administrator can change server-wide settings (${serverWide.join(", ")})`);
  }
  const updated = await updateMonitoringSettings(orgOf(req), patch, req.auth!.user.id);
  await audit({ actor: actorOf(req), ip: req.ip, action: "settings.monitoring_updated", entityType: "settings", entityId: "monitoring", details: patch });
  res.json(updated);
});
// Camera networks protect the whole server: everyone may read them, only the system administrator changes them.
settingsRouter.get("/networks", requirePermission("settings:read"), async (req, res) => {
  const s = await getNetworkSettings();
  res.json({ ...s, camerasOutside: await camerasOutside(s.allowedNetworks, isSystemAdmin(req) ? null : orgOf(req)) });
});
settingsRouter.patch("/networks", requirePermission(SYSTEM_PERMISSION), async (req, res) => {
  const before = await getNetworkSettings();
  const updated = await updateNetworkSettings(parse(networkSettingsSchema, req.body), req.auth!.user.id);
  hostGuard.invalidate();
  await audit({
    actor: actorOf(req), ip: req.ip, action: "settings.networks_updated", entityType: "settings", entityId: "networks",
    details: { from: before.allowedNetworks, to: updated.allowedNetworks }, organizationId: null,
  });
  res.json({ ...updated, camerasOutside: await camerasOutside(updated.allowedNetworks) });
});
// The mail server, the dashboard address and sign-in options: server-wide, system administrator only.
settingsRouter.get("/email", requirePermission(SYSTEM_PERMISSION), async (_req, res) => {
  res.json(await emailSettingsView());
});
settingsRouter.patch("/email", requirePermission(SYSTEM_PERMISSION), async (req, res) => {
  const patch = parse(emailSettingsSchema, req.body);
  const updated = await updateEmailSettings(patch, req.auth!.user.id);
  const fields = Object.keys(patch).map((k) => (k === "smtpPassword" ? (patch.smtpPassword ? "smtpPassword (changed)" : "smtpPassword (removed)") : k));
  await audit({ actor: actorOf(req), ip: req.ip, action: "settings.email_updated", entityType: "settings", entityId: "email", details: { fields }, organizationId: null });
  res.json(updated);
});
/** Sends a test email with the saved settings, or with unsaved changes from the form (blank password keeps the saved one). */
settingsRouter.post("/email/test", requirePermission(SYSTEM_PERMISSION), deviceLimiter, async (req, res) => {
  const { to, settings } = parse(z.object({ to: z.string().trim().email(), settings: emailSettingsSchema.optional() }).strict(), req.body);
  const current = await getEmailSettings();
  const merged = { ...current, ...(settings ?? {}) };
  merged.smtpPassword = settings?.smtpPassword || current.smtpPassword;
  try {
    await sendMail(
      { to, subject: "Test email from Zoho IBMS CCTV Monitoring", text: `This is a test email. If you received it, email is set up.\n\nDashboard address: ${merged.publicUrl ?? "(not set)"}` },
      merged,
    );
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    res.json({ ok: false, message: (err as Error).message.slice(0, 300) });
  }
});
settingsRouter.get("/notifications", requirePermission("settings:read"), async (req, res) => {
  res.json(await listChannels(orgOf(req)));
});
settingsRouter.post("/notifications", requirePermission("settings:write"), async (req, res) => {
  res.status(201).json(await createChannel(orgOf(req), notifier, parse(channelInputSchema, req.body), actorOf(req), req.ip));
});
settingsRouter.patch("/notifications/:id", requirePermission("settings:write"), async (req, res) => {
  res.json(await updateChannel(orgOf(req), notifier, param(req), parse(channelUpdateSchema, req.body), actorOf(req), req.ip));
});
settingsRouter.delete("/notifications/:id", requirePermission("settings:write"), async (req, res) => {
  await deleteChannel(orgOf(req), param(req), actorOf(req), req.ip);
  res.status(204).end();
});
settingsRouter.post("/notifications/:id/test", requirePermission("settings:write"), async (req, res) => {
  res.json(await testChannel(orgOf(req), notifier, param(req)));
});

/** Members of the current organization, managed by its Org Admins. */
export const usersRouter = Router();
usersRouter.use(requirePermission("users:manage"));
usersRouter.get("/", async (req, res) => {
  res.json(await listMembers(orgOf(req)));
});
usersRouter.patch("/:id", async (req, res) => {
  await updateMember(orgOf(req), param(req), parse(updateMemberSchema, req.body), { ...actorOf(req), isSystemAdmin: isSystemAdmin(req) }, req.ip);
  res.status(204).end();
});
usersRouter.delete("/:id", async (req, res) => {
  await removeMember(orgOf(req), param(req), actorOf(req), req.ip);
  res.status(204).end();
});

/** Invitations into the current organization: people join only when they accept. */
export const invitationsRouter = Router();
invitationsRouter.use(requirePermission("users:manage"));
invitationsRouter.get("/", async (req, res) => {
  res.json(await listInvitations(orgOf(req)));
});
invitationsRouter.post("/", async (req, res) => {
  const sent = await invite(orgOf(req), parse(inviteSchema, req.body), actorOf(req), req.ip);
  res.status(sent.outcome === "created" ? 201 : 200).json(sent);
});
invitationsRouter.post("/:id/resend", async (req, res) => {
  res.json(await resend(orgOf(req), param(req), actorOf(req), req.ip));
});
invitationsRouter.post("/:id/revoke", async (req, res) => {
  await revoke(orgOf(req), param(req), actorOf(req), req.ip);
  res.status(204).end();
});

/** Organizations, managed by the system administrator. */
export const organizationsRouter = Router();
organizationsRouter.use(requirePermission(SYSTEM_PERMISSION));
organizationsRouter.get("/", async (_req, res) => {
  res.json(await listOrganizations());
});
organizationsRouter.post("/", async (req, res) => {
  res.status(201).json({ id: await createOrganization(parse(createOrganizationSchema, req.body), actorOf(req), req.ip) });
});
organizationsRouter.patch("/:id", async (req, res) => {
  await updateOrganization(param(req), parse(updateOrganizationSchema, req.body), actorOf(req), req.ip);
  res.status(204).end();
});

export const auditRouter = Router();
/** The organization's entries; the system administrator also sees server-wide ones. */
const auditScope = (req: Request) => ({ organizationId: orgOf(req), includeServerWide: isSystemAdmin(req) });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
auditRouter.get("/export", requirePermission("audit:read"), async (req, res) => {
  const q = parse(
    z.object({ from: day.optional(), to: day.optional(), timeZone: z.string().min(1).max(64).default("UTC") })
      .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "From must not be after To", path: ["from"] }),
    req.query,
  );
  const { csv, rows, truncated } = await exportAuditCsv(auditScope(req), q);
  await audit({ actor: actorOf(req), ip: req.ip, action: "audit.exported", entityType: "audit", details: { from: q.from ?? "start", to: q.to ?? "now", rows } });
  const name = `audit-log${q.from ? `-${q.from}` : ""}${q.to ? `-to-${q.to}` : ""}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  if (truncated) res.setHeader("X-Export-Truncated", "true");
  res.send(csv);
});
auditRouter.get("/", requirePermission("audit:read"), async (req, res) => {
  const q = parse(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      entityType: z.string().max(40).optional(),
      entityId: z.string().max(80).optional(),
    }),
    req.query,
  );
  res.json(await listAudit(auditScope(req), q));
});
