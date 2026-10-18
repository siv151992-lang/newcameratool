# Camera SD Card Dashboard

One web page that shows the SD card status of all your IP cameras, whatever the brand.
It only needs Python 3, with nothing extra to install.

## Setup (2 steps)

1. Copy `cameras.example.csv` to `cameras.csv` and list your cameras:

   ```csv
   name,ip,brand,username,password
   Gate Camera,10.10.15.57,hikvision,admin,Fantasiz_345
   Parking,10.10.15.60,dahua,admin,secret
   ```

2. Run it:

   ```bash
   python3 camera_dashboard.py            # open http://localhost:8080
   python3 camera_dashboard.py --once     # or just print a table in the terminal
   ```

The page refreshes itself every 5 minutes and also has a **Refresh** button.

## Supported brands (`brand` column)

| brand value                                   | API used                                                   |
|-----------------------------------------------|------------------------------------------------------------|
| `hikvision` (also `hik`, `prama`)             | `GET /ISAPI/ContentMgmt/Storage`                           |
| `dahua` (also `cpplus`, `amcrest`, `lorex`)   | `GET /cgi-bin/storageDevice.cgi?action=getDeviceAllInfo`   |
| `axis`                                        | `GET /axis-cgi/disks/list.cgi?diskid=all`                  |
| `auto` or empty                               | tries each of the above until one answers                  |

Digest and Basic authentication are both handled automatically.

## Status meanings

- **OK**: the card is present and healthy
- **FULL**: the card is more than 95% used (most cameras overwrite old footage, so treat this as a warning)
- **FAULT**: the camera reports a card error (for example "abnormal" or "unformatted")
- **NO CARD**: the camera answered but reported no SD card
- **OFFLINE**: the camera can't be reached, or the login was wrong (see the Detail column)

## Adding another brand

Write a `read_<brand>(ip, user, password)` function in `camera_dashboard.py` that returns
`[{name, status, total_mb, free_mb}]`, then add it to `READERS`.

`cameras.csv` is git-ignored, so the passwords never get committed.
