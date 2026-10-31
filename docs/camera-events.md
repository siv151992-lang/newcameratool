# Camera events and firmware

## Camera events

Checks run every few minutes. Some problems need to be known sooner, and the camera itself notices
them first. With **camera events**, the monitoring worker keeps each camera's event stream open, and
the camera reports these problems the moment they happen:

| Alert | Raised when the camera reports | Severity | Closes |
|---|---|---|---|
| **Camera tampered with** | Video tampering (lens covered), out of focus, scene changed (camera moved) | Critical | When the camera says it ended, or stops repeating it for 2 minutes |
| **Video loss** | No video signal (an NVR's channel, or a camera's video input) | Critical | The same |
| **Camera reported a fault** | Storage full or failed, recording failed, network lost, IP address conflict | Warning | After an hour without another |
| **Failed logins on the camera** | Someone tried to sign in to the camera with a wrong user name or password | Warning | After an hour without another |

Critical-area cameras raise all of them as critical, and cameras in maintenance raise none (an alert
already open is kept up to date). Notifications (email, webhooks, the alert sound) are sent as for any
other alert. Motion, line crossing and other analytics events are ignored: they are what the cameras
are for, not problems.

**Where it shows**: the alerts; the **Camera events** line on the camera's page (connected, not
supported by this camera, or why it is not connected); and the **Camera events** list on the same
page, with each event and when it ended. Events are kept as long as the check history
(**Settings → Monitoring → History**).

**Which cameras**

- **Hikvision and Prama** (and brands that work like them): the ISAPI alert stream
  (`/ISAPI/Event/notification/alertStream`). On older firmware without it, the camera's page says so.
- **Dahua** and brands that work like it: `eventManager.cgi?action=attach` (*unverified* on real
  hardware).
- Other brands: no event stream yet; their problems are found by the checks as before.

The camera reports only the events enabled on it. For tampering, turn on **Video Tampering** (and,
where offered, *Defocus* and *Scene Change*) under **Configuration → Event** in the camera's own web page,
and tick **Notify Surveillance Center** (Hikvision) or the equivalent; exceptions (HDD full, HDD error,
network disconnected, IP conflict, illegal login) are under **Exception**.

**How the connection is kept**

- One connection per camera, opened by one monitoring worker (with several workers, one of them
  holds them all). It uses the camera's stored user name and password, with Digest login as the checks do.
- Opened only for cameras that are monitored, online and whose login works, so a wrong password is
  never retried in a loop (cameras lock their users out after a few failed logins). A login the camera
  refuses on the event stream is tried again after 30 minutes.
- A stream that drops is reopened after 10 seconds, then with a growing delay up to 5 minutes. A
  camera without an event stream is asked again after 6 hours (its firmware may have been updated).
- Turn it off per camera with **Receive camera events** when editing it (for cameras that allow very
  few connections). `CAMERA_EVENT_STREAMS_MAX` (default 5000) limits how many are kept open; `0` turns
  camera events off.

## Firmware inventory

**Firmware** in the sidebar lists every camera's model and firmware version, as the cameras report
them at their checks (read again every few hours), grouped by brand and model:

- the newest firmware version among this organization's cameras of each model, and every version in use;
- **On older firmware**: cameras running an older version than other cameras of the same model here.
  Those are the first to update: firmware updates fix security holes and bugs;
- the cameras of a model (open its row), oldest firmware first, with serial numbers;
- **Download CSV**: the whole inventory, one camera a row.

"Newest" is the newest *here*: the app does not know the manufacturers' releases, so check the
manufacturer's website for a newer version still. Versions are compared by their numbers and then
their build (`V5.7.3 build 220112`, `2.800.0000000.17.R, Build Date: 2022-03-01`). Cameras whose
firmware has not been read yet (new, or never reached) are counted as *not read yet*.
