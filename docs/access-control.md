# Access control

**Access control** in the sidebar watches access readers and doors, apart from the cameras: whether each reader
is online, whether doors are open, forced open or held open, tamper, and who was let in or refused.

An access system is added once, and all its readers and doors come with it:

| Your readers | What you add | Login |
|---|---|---|
| **Hikvision** access terminals and controllers (DS-K1T face / card terminals, DS-K2600 controllers) | Each terminal or controller, by its address | Its admin user (Digest login, like the cameras) |
| **Suprema** BioStation 3, BioEntry W2, BioEntry P2 and other Suprema devices | The **BioStar 2 server** they report to (its HTTPS address and port) | A BioStar 2 operator who may see devices, doors and events. **HTTPS only** (the login sends the password itself) |
| **Gallagher** T-series readers on Controller 6000 / 7000 | The **Command Centre server** (HTTPS, port 8904) | The API key of a REST client item (Configuration → Services and workstations → REST client). Needs the Command Centre REST API licence. **HTTPS only** |

Add it with **Access control → Add access system**. Test the connection: it shows how many readers and doors were
found. For a server with its own (self-signed) certificate, use **Get the certificate** and trust it; certificate
checks are never turned off.

## What is checked

At every check (5 minutes by default, or **Refresh now** on its page):

- **The system itself**: reachable and the login works (alerts *Access system offline* and *Authentication failing*,
  and its uptime on the Uptime page).
- **Readers and controllers**: online or not, tamper (from the controller's own status, or from BioStar 2's
  tamper events).
- **Doors**: open or closed, locked or unlocked, **forced open** or **held open too long** (from the door's
  status, or from its events while it stays open).
- **Access events** since the last check: granted, denied, door events, tamper, alarms and faults. The first check
  reads the last day's. Person names are kept as the system gives them; card numbers are never stored.

| Alert | When | Severity |
|---|---|---|
| **N readers offline** | Readers or controllers not connected | Warning |
| **Access reader tampered with** | A reader or controller reports tamper | Critical |
| **N doors forced open** | Doors opened without access | Critical |
| **N doors held open** | Doors open longer than allowed | Warning |

They close by themselves when it is over, are sent by email and webhooks like any other alert, are raised as
critical for systems marked *critical area*, and are silent during maintenance.

## Where it shows

- **Access control**: readers offline, doors forced or held open, tamper and refusals in the last 24 hours; each
  system with its readers, doors and events; all events with filters (problems only, granted, denied, doors …)
  and a search by person, door or reader.
- **A system's page**: its readers and controllers, doors (open, locked, forced, held open), open alerts, events,
  and Refresh now / Test connection / Edit / Remove.
- Access systems are not listed or counted with the cameras.

## Limits

- **Unverified on real hardware**: tested against simulated Hikvision access controllers, BioStar 2 and Command
  Centre servers. Use **Test connection** on yours; if something reads wrongly, the system's page says what was read.
- Events come at each check, not instantly (Refresh now reads at once).
- BioStar 2: door states come from door events (a door is shown as reported by its last event); readers' online
  state from the server's device list.
- Hikvision event codes beyond the common ones are kept as *Event major/minor*.
