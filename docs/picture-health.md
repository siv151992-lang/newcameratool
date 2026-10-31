# Picture health

A camera that answers and records can still record nothing useful: a covered lens, a failed sensor,
a camera knocked off its view. The picture check finds these from a snapshot, every 30 minutes by
default (**Settings → Monitoring → Check each camera's picture every**; 0 turns it off).

| State | What it means | Usual causes |
|---|---|---|
| **Black** | The picture is almost all black | Failed sensor or image, infrared off at night |
| **Blank or covered** | The picture is one flat colour | Lens covered, taped or painted; facing a wall |
| **Blurred** | Much less detail than this camera usually has | Out of focus, dirty, wet or misted lens |
| **Frozen** | The very same picture at consecutive checks | Frozen image; a live camera never sends the same bytes twice |
| **View has moved** | The view no longer matches this camera's reference view | Turned, knocked or obstructed |

**How false alarms are kept rare**

- Blur and view are judged against **the camera's own** usual picture, learnt from its first good
  snapshots, separately for day (colour) and night (infrared), which look very different.
- A problem must be seen at **two checks in a row** before it counts, so a passing person or a
  headlight raises nothing.
- Scenes that are dark by nature (an unlit yard at night) can be excluded per camera: untick
  **Check the picture** when editing it.
- After a camera was moved or refocused on purpose, press **Use the current view as the reference**
  on its page: it learns the new view, and its picture alert closes.

**Where it shows**: an alert (*Picture is black*, *… blank or covered*, *… blurred*, *… frozen*,
*Camera view has moved*; critical for critical-area cameras) that closes by itself when the picture
is fine again; on the **Cameras** page, the **Picture** column, the **Picture problems** button (shows only those cameras) and the filter *Picture problem*;
and the **Picture** line on the camera's page, with what was found.

**What it costs**: one snapshot per camera per check, the small sub-stream picture where the camera
has one (Hikvision / Prama), about 70 ms of server time each. Only a few numbers and a 32 × 18 grey
thumbnail are kept, never the snapshot. NVRs are not checked themselves (their cameras can be added
directly to be checked). Brands that give no picture show why on the camera's page.
