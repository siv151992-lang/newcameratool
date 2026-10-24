import { z } from "zod";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import { publicLink, trySendMail } from "../notifications/mailer.js";
import { getEmailSettings } from "./emailSettings.js";
import { hashLinkToken, isLinkToken, newLinkToken } from "../security/tokens.js";
import { type Actor, audit } from "./auditService.js";
import { addMember, ROLES, type Role } from "./organizationService.js";

/**
 * Invitations into an organization. An Org Admin invites an email address with a role; the person
 * joins only when they accept, signed in with an account that has that (verified) email address.
 * A link works until it expires (INVITATION_EXPIRY_HOURS), is accepted, or is revoked; re-sending
 * replaces it with a new link, so an older link stops working.
 */

export const inviteSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email("Enter a valid email address"),
    role: z.enum(ROLES),
  })
  .strict();

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

const STATUS_SQL = `CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                         WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END`;

/** The link people open; only its hash is stored. */
export const invitationPath = (token: string) => `/invite/${token}`;

interface Sent {
  id: string;
  /** Path of the new link, for the Org Admin to copy (shown once). */
  link: string;
  emailSent: boolean;
  emailError?: string;
  /** "created", or "resent" when an open invitation to this address already existed. */
  outcome: "created" | "resent";
}

export async function listInvitations(orgId: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.email, i.role, ${STATUS_SQL} AS status, i.created_at AS "createdAt", i.sent_at AS "sentAt",
            i.send_count AS "sendCount", i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", i.revoked_at AS "revokedAt",
            inv.username AS "invitedBy", acc.username AS "acceptedBy"
     FROM invitations i
     LEFT JOIN users inv ON inv.id = i.invited_by
     LEFT JOIN users acc ON acc.id = i.accepted_by
     WHERE i.organization_id = $1 AND (i.accepted_at IS NULL AND i.revoked_at IS NULL OR i.created_at > now() - interval '30 days')
     ORDER BY (i.accepted_at IS NULL AND i.revoked_at IS NULL) DESC, i.sent_at DESC`,
    [orgId],
  );
  return rows;
}

async function deliver(orgId: string, email: string, role: Role, token: string, inviter: string) {
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]);
  const link = await publicLink(invitationPath(token));
  if (!link) return { sent: false, error: "The dashboard address is not set, so the link could not be emailed. A system administrator can set it in Settings → Email & sign-in" };
  const roleName = role === "admin" ? "Org Admin" : role === "operator" ? "Operator" : "Viewer";
  return trySendMail({
    to: email,
    subject: `You're invited to ${rows[0]!.name} on Zoho IBMS CCTV Monitoring`,
    text: [
      `${inviter} invited you to join ${rows[0]!.name} as ${roleName}.`,
      "",
      `Accept the invitation: ${link}`,
      "",
      `Sign in, or create an account, with this email address (${email}). The link works once and expires in ${(await getEmailSettings()).invitationExpiryHours} hours.`,
      "If you were not expecting this, ignore this email.",
    ].join("\n"),
  });
}

/** Invites an address, or re-sends (with a new link and expiry) the open invitation it already has. */
export async function invite(orgId: string, input: z.infer<typeof inviteSchema>, actor: Actor, ip?: string | null): Promise<Sent> {
  const member = await pool.query(
    "SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND lower(u.email) = $2",
    [orgId, input.email],
  );
  if (member.rowCount) throw new HttpError(409, "ALREADY_MEMBER", `${input.email} is already a member of this organization`);

  const { token, hash } = newLinkToken();
  const expiryHours = (await getEmailSettings()).invitationExpiryHours;
  const { id, outcome } = await withTransaction(async (db) => {
    const open = await db.query<{ id: string }>(
      "SELECT id FROM invitations WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE",
      [orgId, input.email],
    );
    let id: string;
    let outcome: Sent["outcome"];
    if (open.rows[0]) {
      id = open.rows[0].id;
      outcome = "resent";
      await db.query(
        `UPDATE invitations SET token_hash = $2, role = $3, invited_by = $4, sent_at = now(), send_count = send_count + 1,
                expires_at = now() + make_interval(hours => $5) WHERE id = $1`,
        [id, hash, input.role, actor.id, expiryHours],
      );
    } else {
      outcome = "created";
      id = (await db.query<{ id: string }>(
        `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING id`,
        [orgId, input.email, input.role, hash, actor.id, expiryHours],
      )).rows[0]!.id;
    }
    await audit({ actor, ip, action: outcome === "created" ? "invitation.created" : "invitation.resent", entityType: "invitation", entityId: id, details: { email: input.email, role: input.role } }, db);
    return { id, outcome };
  });
  const mail = await deliver(orgId, input.email, input.role, token, actor.username);
  return { id, link: invitationPath(token), emailSent: mail.sent, emailError: mail.error, outcome };
}

async function getOwn(orgId: string, id: string, db: Queryable = pool) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Invitation");
  const { rows } = await db.query(`SELECT i.*, ${STATUS_SQL} AS status FROM invitations i WHERE i.id = $1 AND i.organization_id = $2`, [id, orgId]);
  if (!rows[0]) throw notFound("Invitation");
  return rows[0] as { id: string; email: string; role: Role; status: InvitationStatus };
}

/** Sends a pending or expired invitation again with a new link. Accepted and revoked ones are final. */
export async function resend(orgId: string, id: string, actor: Actor, ip?: string | null): Promise<Sent> {
  const inv = await getOwn(orgId, id);
  if (inv.status === "accepted") throw new HttpError(409, "INVITATION_ACCEPTED", "This invitation has already been accepted");
  if (inv.status === "revoked") throw new HttpError(409, "INVITATION_REVOKED", "This invitation was revoked. Invite the person again.");
  return invite(orgId, { email: inv.email, role: inv.role }, actor, ip);
}

export async function revoke(orgId: string, id: string, actor: Actor, ip?: string | null) {
  const inv = await getOwn(orgId, id);
  if (inv.status === "accepted") throw new HttpError(409, "INVITATION_ACCEPTED", "This invitation has already been accepted. Remove the member instead.");
  if (inv.status === "revoked") return;
  await pool.query("UPDATE invitations SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [id, actor.id]);
  await audit({ actor, ip, action: "invitation.revoked", entityType: "invitation", entityId: id, details: { email: inv.email } });
}

// ------------------------------------------------------------------ the invited person

interface InvitationRow {
  id: string;
  organization_id: string;
  organization_name: string;
  organization_active: boolean;
  email: string;
  role: Role;
  status: InvitationStatus;
  expires_at: Date;
  invited_by_name: string | null;
}

/** By link token, or by id for an invitation listed to its (verified) recipient. */
type InvitationRef = { token: string } | { id: string };

async function byToken(token: string, db: Queryable = pool, lock = false): Promise<InvitationRow> {
  return find({ token }, db, lock);
}

async function find(ref: InvitationRef, db: Queryable, lock: boolean): Promise<InvitationRow> {
  if ("token" in ref ? !isLinkToken(ref.token) : !z.string().uuid().safeParse(ref.id).success) throw invalidLink();
  const { rows } = await db.query<InvitationRow>(
    `SELECT i.id, i.organization_id, o.name AS organization_name, o.is_active AS organization_active, i.email, i.role,
            ${STATUS_SQL} AS status, i.expires_at, coalesce(u.display_name, u.username) AS invited_by_name
     FROM invitations i JOIN organizations o ON o.id = i.organization_id LEFT JOIN users u ON u.id = i.invited_by
     WHERE ${"token" in ref ? "i.token_hash" : "i.id::text"} = $1 ${lock ? "FOR UPDATE OF i" : ""}`,
    ["token" in ref ? hashLinkToken(ref.token) : ref.id],
  );
  if (!rows[0]) throw invalidLink();
  return rows[0];
}

const invalidLink = () =>
  new HttpError(404, "INVITATION_INVALID", "This invitation link is not valid. It may have been replaced by a newer invitation; check your email for the latest one.");

function assertUsable(inv: InvitationRow) {
  if (!inv.organization_active) throw new HttpError(410, "INVITATION_INVALID", "This organization is no longer active.");
  if (inv.status === "accepted") throw new HttpError(410, "INVITATION_ACCEPTED", "This invitation has already been used.");
  if (inv.status === "revoked") throw new HttpError(410, "INVITATION_REVOKED", "This invitation was withdrawn by the organization.");
  if (inv.status === "expired") throw new HttpError(410, "INVITATION_EXPIRED", "This invitation has expired. Ask the organization's administrator to send a new one.");
}

/** What the invitation page shows before anyone signs in. */
export async function previewInvitation(token: string) {
  const inv = await byToken(token);
  const account = await pool.query("SELECT 1 FROM users WHERE lower(email) = $1 AND is_active", [inv.email]);
  return {
    organizationName: inv.organization_name,
    role: inv.role,
    email: inv.email,
    invitedBy: inv.invited_by_name,
    expiresAt: inv.expires_at,
    status: inv.organization_active ? inv.status : ("revoked" as InvitationStatus),
    /** An account already uses this address: sign in rather than create one. */
    accountExists: Boolean(account.rowCount),
  };
}

/**
 * Accepts an invitation for a signed-in user. Their account must have the invited address. With the
 * emailed link, an account without an email address takes it on (the link proves they receive mail
 * there); without the link (accepting from the list), the address must already be verified.
 */
export async function acceptInvitation(ref: InvitationRef, user: { id: string; username: string }, ip?: string | null, db?: Queryable) {
  const run = async (client: Queryable) => {
    const inv = await find(ref, client, true);
    const { rows } = await client.query<{ email: string | null; verified: boolean }>(
      "SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1 FOR UPDATE",
      [user.id],
    );
    const email = rows[0]?.email?.toLowerCase() ?? null;
    if ("id" in ref && (email !== inv.email || !rows[0]?.verified)) throw invalidLink();
    assertUsable(inv);
    if (email && email !== inv.email) {
      throw new HttpError(403, "EMAIL_MISMATCH", `This invitation is for ${inv.email}, but you are signed in as ${email}. Sign in with the invited address.`);
    }
    if (!email) {
      const taken = await client.query("SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2", [inv.email, user.id]);
      if (taken.rowCount) throw new HttpError(409, "EMAIL_MISMATCH", `Another account uses ${inv.email}. Sign in with that account to accept.`);
    }
    // Following the emailed link proves the address.
    await client.query(
      "UPDATE users SET email = $2, email_verified_at = coalesce(email_verified_at, now()), pending_verification = false WHERE id = $1",
      [user.id, inv.email],
    );
    await addMember(inv.organization_id, user.id, inv.role, null, client);
    await client.query("UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1", [inv.id, user.id]);
    await audit(
      { actor: { ...user, organizationId: inv.organization_id }, ip, action: "invitation.accepted", entityType: "invitation", entityId: inv.id, details: { email: inv.email, role: inv.role } },
      client,
    );
    return { organizationId: inv.organization_id, organizationName: inv.organization_name, role: inv.role };
  };
  return db ? run(db) : withTransaction(run);
}

/** Checks a link is usable for creating an account with `email` (before the account exists). */
export async function invitationForSignup(token: string, email: string) {
  const inv = await byToken(token);
  assertUsable(inv);
  if (inv.email !== email.toLowerCase()) {
    throw new HttpError(400, "EMAIL_MISMATCH", `This invitation is for ${inv.email}. Create the account with that address.`);
  }
  return inv;
}

/** Open invitations for an address, shown to someone signed in who is not yet in those organizations. */
export async function pendingInvitationsFor(email: string | null) {
  if (!email) return [];
  const { rows } = await pool.query(
    `SELECT i.id, o.name AS "organizationName", i.role, i.expires_at AS "expiresAt"
     FROM invitations i JOIN organizations o ON o.id = i.organization_id AND o.is_active
     WHERE i.email = lower($1) AND i.accepted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = i.organization_id AND lower(u.email) = i.email) AND i.revoked_at IS NULL AND i.expires_at > now()
     ORDER BY i.sent_at DESC`,
    [email],
  );
  return rows;
}
