# Live view, recordings and NVRs

## Live view

Every camera page has **Live view**. With the live video service (go2rtc, included in Docker
Compose — see [operations.md](operations.md#live-view)) it plays smooth video; without it, a picture
about once a second.

The app asks the camera whether it serves each of the brand's stream addresses (the second stream
first, which is usually H.264) and uses the first that answers, then the address the camera gives
over ONVIF. If none works, the message says why (login refused, or no such stream).

Browsers cannot play **H.265**. If live view says the format is not supported, set the camera's
second stream to H.264 in the camera's own video settings.

## Recordings (the camera's own SD card or disk)

**Recordings** opens a player for what the camera has recorded:

- The **calendar** marks the days that have recordings.
- The **timeline** shows the recorded periods; drag it, scroll it, or click a time to play from it.
  A time with no recording plays from the next recording. Playing past midnight moves on to the
  next day.
- **From start** plays the oldest recording on the camera; **Latest** the newest.
- **Speed**: slower plays at once; faster asks the camera to send faster (where it supports it).

Times are the camera's own clock.

### How playback finds the recording

1. The brand's playback address is checked with the camera first.
2. If the camera refuses it, the brand's other addresses are tried (Hikvision / Prama and Dahua /
   CP Plus: the second stream's recordings, which play in browsers on most models).
3. Then the camera's standard ONVIF replay (Profile G).

The address that worked is remembered for that camera. If a stream drops while playing (the
camera closed it, or the network blinked), the player carries on by itself from where it was.

### When recordings will not play

| Message says | Do |
|---|---|
| login refused / playback permission | Give the camera user the **playback** permission in the camera, or use the camera's admin account |
| the camera has no stream at this address | Turn on RTSP (port 554) in the camera, or turn on ONVIF |
| the browser cannot play the video format | Set the camera's recording / second stream to **H.264** |
| recordings are read over ONVIF, which failed | Turn on ONVIF in the camera and add an ONVIF user with the same password |

Viewers cannot open live view or recordings; Operators and Org Admins can. Every live view and
playback is in the audit log.

## NVRs

Add an NVR like a camera and tick **This is an NVR** (brands: Hikvision / Prama, Dahua / CP Plus,
Uniview, Hanwha). The app then monitors:

- the NVR's **hard disks** (health and space), like a camera's SD card;
- each **channel**: its camera's name, whether it has video, and whether it is recording.

A channel with no video raises a **critical** alert; a channel that is not recording raises a
**warning** (one alert per NVR, listing the channels). The dashboard has NVR tiles (NVRs offline,
disk errors, channels without video or not recording), and the cameras list can be filtered to NVRs
or to **channel problems**.

The NVR's page lists its channels, each with **Live** and **Recordings**, which work as above for
that channel.
