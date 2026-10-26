# Accounts, organizations and sign-in

## Organizations

Every camera, alert, report, setting and audit entry belongs to one **organization**. People only see
the organizations they are members of; a person can belong to several and switches between them with
the organization picker at the top of every page.

The **system administrator** (the first account created on a new installation) manages the server
as a whole: **Settings → Organizations** (create, rename, deactivate), **Settings → Email & sign-in**,
and the server-wide monitoring settings. Everything else is per organization.

## Roles

Each membership has a role in that organization:

| Role | Can |
|---|---|
| **Org Admin** | Everything in the organization: cameras and their passwords, settings, users and invitations, the audit log |
| **Operator** | See cameras, run checks, live view and recordings, manage alerts, read settings |
| **Viewer** | See dashboards, cameras and alerts (no live view or recordings) |

Changing settings, users, invitations or organizations asks for the person's password again; the
settings stay unlocked for 15 minutes after the last change (**Lock now** locks them at once).

## The first account

On a new installation the sign-in page offers **Create account**. That first account becomes the
system administrator and the Org Admin of the first organization. From then on, accounts are
created through invitations, or by sign-up when it is turned on (below).

## Email & sign-in settings (system administrator)

**Settings → Email & sign-in** holds:

- **Mail server** (SMTP) for alerts, invitations, email confirmation and password resets. Use **Send
  test email** to check it. Without mail: no sign-up, no password reset by email, and invitations
  must be passed on by hand (the invitation link is always shown after inviting, to share in chat).
- **Dashboard address** (e.g. `https://cctv.example.com`): used in emailed links and required for
  Google / Zoho sign-in.
- **Who can create accounts**: off (invitation only) or anyone (with email confirmation).
- How long invitation, email confirmation and password reset links last.
- **Google** and **Zoho** sign-in credentials (below).

## Inviting people (Org Admin)

**Settings → Users → Invite**: enter the email address and role. The person gets an email with a
link that works once and expires (after 72 hours by default; set under Email & sign-in). The link is
also shown on screen, to share in chat. They
sign in, or create an account with that address, and join the organization. The link proves the
address, so no separate confirmation is needed. Pending invitations can be re-sent or revoked from
the same page; someone who already has an account also sees the invitation after signing in.

## Creating an account (when sign-up is on)

**Create account** asks for a username, name, email address and password. The account works after
the person clicks the confirmation link emailed to them (valid 24 hours by default). A new account that was not invited has no
organization until an Org Admin invites it.

**Forgot password** emails a reset link (when mail is set up). People can always sign in with their
username or email address.

## Sign in with Google or Zoho

1. Set the **Dashboard address** under Settings → Email & sign-in.
2. At the provider, create an OAuth / OpenID Connect web client:
   - Google: Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application).
   - Zoho: Zoho API Console (api-console.zoho.com) → Server-based Applications.
3. Register the **redirect URI** exactly as shown in the app:
   `https://<dashboard address>/api/auth/oauth/google/callback` (or `/zoho/callback`).
4. Paste the client ID and secret into Settings → Email & sign-in and save. The sign-in page then
   shows **Sign in with Google / Zoho**.

Who gets in: the account already linked to that Google / Zoho account; otherwise the account with
the same confirmed email address (which is then linked); otherwise a new account, but only for the
first account of a new installation, someone with an invitation to that address, or when sign-up is
on. All Zoho data centres (zoho.com, .eu, .in, …) work.

People connect or disconnect Google / Zoho under **Settings → Account & theme**. The last way an
account can sign in cannot be disconnected.

## Security notes

- Passwords are hashed; sessions are HTTP-only cookies with CSRF protection; sign-in and account
  pages are rate-limited.
- Google / Zoho sign-in uses the authorization code flow with PKCE and checks the ID token's
  signature, issuer, audience, expiry and nonce before trusting the email address.
- Every sign-in, sign-up, invitation, role change and settings change is in the **audit log**
  (Settings → Audit log, filterable by date and downloadable as CSV).
