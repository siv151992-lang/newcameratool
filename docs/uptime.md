# Uptime report

**Uptime** in the sidebar shows how much of the time cameras were online over the last 24 hours, 7,
30 or 90 days: overall, per location and per camera (lowest first), with the number of outages,
the downtime and the longest outage. **Download CSV** has every camera (the page lists the lowest
500). Everyone who can see cameras can open it.

How it is worked out: the checks record each time a camera goes offline or comes back. A camera
counts as offline from the check that marked it offline (after the number of failed checks set in
**Settings → Problem detection**) until it answered again, so an outage shorter than that is not
counted. Time before a camera was first checked is left out, and so are cameras with monitoring off.
Location and overall figures are weighted by time (a camera added yesterday weighs less than one
watched all month). Time in maintenance counts like any other time.

The figures go back as far as the monitoring history is kept (**Settings → Retention**, 90 days by
default). With 20 000 cameras and 220 000 status changes the report takes about half a second.
