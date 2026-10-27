# Alert notifications

Alerts always appear on the dashboard and the Alerts page. **Settings → Notifications** (Org Admin)
also sends them to people, through one or more channels:

| Send to | Set up |
|---|---|
| **Email** | The mail server under Settings → Email & sign-in (system administrator); enter the recipients |
| **Microsoft Teams** | In the Teams channel: **⋯ → Workflows → "Post to a channel when a webhook request is received"**; copy the address it gives |
| **Slack** | A Slack app with **Incoming Webhooks** on → **Add New Webhook to Workspace**; the address starts with `https://hooks.slack.com/` |
| **Google Chat** | In the space: **Apps & integrations → Webhooks → Add webhook**; the address starts with `https://chat.googleapis.com/` |
| **Webhook (JSON)** | Any HTTPS address; it receives a POST with `subject`, `text` and `alert` (type, severity, camera, link) |

Each channel has a minimum severity, a cooldown per camera and alert type (no repeats while a
problem flaps; escalations to critical always go out), and optional recovery messages. **Send
test** checks a channel at once; failed deliveries show their reason.

## Webhook security

- A webhook address works like a password (anyone holding it can post), so it is stored
  encrypted, never shown again, and never put in error messages or the audit log. To change it,
  edit the channel and paste the new one; left blank, the saved address is kept.
- Only `https://` addresses on the **public internet** are contacted: addresses on the server's own
  network (10.x, 192.168.x, 172.16–31.x, loopback, link-local, cloud metadata) are refused, the
  checked address is the one connected to, and redirects are not followed.
- The server needs outbound HTTPS (port 443) to the chat service.
