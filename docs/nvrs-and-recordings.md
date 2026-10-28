# Live view, recordings and NVRs

## Live view

Every camera page has **Live view**. With the live video service (go2rtc, included in Docker
Compose — see [operations.md](operations.md#live-view)) it plays smooth video; without it, a picture
about once a second.

The app asks the camera whether it serves each of the brand's stream addresses (the second stream
first, which is usually H.264) and uses the first that answers, then the address the camera gives
over ONVIF. If none works, the message says why (login refused, or no such stream).

**Download a clip** (the download button by Full screen) saves part of a recording as an MP4 file
for evidence: choose the start (camera time; the current position by default) and the length (30
seconds to 30 minutes). The camera sends recordings at normal speed, so the download takes about as
long as the clip and shows in the browser's downloads as it comes in; closing it stops it. The file
plays in VLC, Windows Media Player and browsers, starts at the camera's first full picture from that
time, and is named after the camera, the start and the length. Each download is in the audit log
(`camera.recording_exported`); Operators and Org Admins can download clips, Viewers cannot.

**Save picture** downloads what is on screen as a PNG at the camera's full resolution (whatever
the zoom), named after the camera and the time, e.g. `Lobby_2026-10-27_14-05-09.png`. In
recordings it is the camera's time of the moment being played (the camera button by the zoom).
A strip under the picture names the camera, the date and time, and (in recordings) shows the
timeline as it was on screen, with the saved moment marked.

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
- **Buffer** (Small 2 s, Normal 5 s, Large 10 s): video kept in hand so playback does not freeze on a
  slow or uneven network; the seconds in hand show beside it. Playback starts with half a second in hand (Large: 3 s)
  and builds the rest by playing slightly slower than real time (0.9–0.96×) until it is full. Use
  Large over VPN or mobile links. The choice is remembered in the browser.

A line under the player says where the time to start went: our server, each step of the camera's
answer, and the wait for the picture. A picture can only start at a full frame (I-frame), and cameras
send recordings at real-time pace, so a long "picture … after the video arrived" is the camera's
I-frame interval: set **I Frame Interval** to the frame rate (e.g. 25 at 25 fps, one per second) and
turn off **H.264+ / Smart Codec** in the camera's video settings (Hikvision: Configuration →
Video/Audio → Video). Recordings then start within about a second; they take roughly 10–30% more
space.

Times are the camera's own clock. The app reads each camera's clock about once an hour and shows
how far off it is on the camera page; a clock wrong by more than 5 minutes (Settings → Problem
detection) raises an alert. Set the camera to take its time from an NTP server.

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
