#!/usr/bin/env python3
"""SD card storage dashboard for mixed-brand IP cameras.

Reads cameras from cameras.csv, queries each camera's storage API and serves
a small web dashboard. Uses only the Python standard library.

    python3 camera_dashboard.py              # dashboard on http://localhost:8080
    python3 camera_dashboard.py --once       # print a table and exit
"""
import argparse
import csv
import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TIMEOUT = 8


def http_get(ip, user, password, path):
    url = f"http://{ip}{path}"
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    mgr.add_password(None, url, user, password)
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),  # cameras are on the LAN; skip system/office proxies
        urllib.request.HTTPDigestAuthHandler(mgr),
        urllib.request.HTTPBasicAuthHandler(mgr),
    )
    with opener.open(url, timeout=TIMEOUT) as resp:
        return resp.read().decode("utf-8", errors="replace")


def strip_ns(xml_text):
    root = ET.fromstring(xml_text)
    for el in root.iter():
        el.tag = el.tag.split("}", 1)[-1]
    return root


# Each reader returns a list of disks: {name, status, total_mb, free_mb}

def read_hikvision(ip, user, password):
    root = strip_ns(http_get(ip, user, password, "/ISAPI/ContentMgmt/Storage"))
    disks = []
    for hdd in root.iter("hdd"):
        disks.append({
            "name": hdd.findtext("hddName") or hdd.findtext("id") or "sd",
            "status": hdd.findtext("status") or "unknown",
            "total_mb": float(hdd.findtext("capacity") or 0),
            "free_mb": float(hdd.findtext("freeSpace") or 0),
        })
    return disks


def read_dahua(ip, user, password):
    # Also used by CP Plus, Amcrest, Lorex and other Dahua-based cameras.
    text = http_get(ip, user, password,
                    "/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo")
    info = {}
    for line in text.splitlines():
        m = re.match(r"list\.info\[(\d+)\]\.(.+?)=(.*)", line.strip())
        if m:
            info.setdefault(int(m[1]), {})[m[2]] = m[3]
    disks = []
    for idx in sorted(info):
        d = info[idx]
        total = sum(float(v) for k, v in d.items() if k.endswith(".TotalBytes"))
        used = sum(float(v) for k, v in d.items() if k.endswith(".UsedBytes"))
        errors = any(v.lower() == "true" for k, v in d.items() if k.endswith(".IsError"))
        state = d.get("State", "unknown")
        disks.append({
            "name": d.get("Name", f"disk{idx}"),
            "status": "error" if errors else state,
            "total_mb": total / 1048576,
            "free_mb": (total - used) / 1048576,
        })
    return disks


def read_axis(ip, user, password):
    root = strip_ns(http_get(ip, user, password, "/axis-cgi/disks/list.cgi?diskid=all"))
    disks = []
    for disk in root.iter("disk"):
        disks.append({
            "name": disk.get("diskid", "SD_DISK"),
            "status": disk.get("status", "unknown"),
            "total_mb": float(disk.get("totalsize") or 0) / 1024,
            "free_mb": float(disk.get("freesize") or 0) / 1024,
        })
    return disks


READERS = {"hikvision": read_hikvision, "dahua": read_dahua, "axis": read_axis}
ALIASES = {"hik": "hikvision", "cpplus": "dahua", "cp plus": "dahua",
           "amcrest": "dahua", "lorex": "dahua", "prama": "hikvision"}


def check_camera(cam):
    brand = cam["brand"].strip().lower()
    brand = ALIASES.get(brand, brand)
    order = list(READERS) if brand in ("", "auto") else [brand]
    result = {"name": cam["name"], "ip": cam["ip"], "brand": brand or "auto",
              "checked": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    last_error = "unsupported brand"
    for b in order:
        reader = READERS.get(b)
        if not reader:
            continue
        try:
            disks = reader(cam["ip"], cam["username"], cam["password"])
        except Exception as e:  # noqa: BLE001 - report any failure on the dashboard
            last_error = f"{type(e).__name__}: {e}"
            continue
        result["brand"] = b
        if not disks:
            result.update(state="NO CARD", detail="No SD card reported")
            return result
        d = disks[0]
        total, free = d["total_mb"], d["free_mb"]
        used_pct = round(100 * (total - free) / total, 1) if total else None
        healthy = d["status"].lower() in ("ok", "normal", "success", "rw")
        result.update(
            state="OK" if healthy else "FAULT",
            detail=d["status"],
            total_gb=round(total / 1024, 1),
            free_gb=round(free / 1024, 1),
            used_pct=used_pct,
        )
        return result
    result.update(state="OFFLINE", detail=last_error)
    return result


def load_cameras(path):
    if not Path(path).exists():
        raise ValueError(f"{path} not found. Copy cameras.example.csv to {path} "
                         "and add your cameras.")
    # utf-8-sig drops the BOM that Excel adds; Excel may also save with ';'
    with open(path, newline="", encoding="utf-8-sig") as f:
        text = f.read()
    delimiter = ";" if text.count(";") > text.count(",") else ","
    rows = [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(text.splitlines(), delimiter=delimiter)]
    missing = {"ip", "username", "password"} - set(rows[0] if rows else {})
    if missing:
        raise ValueError(f"{path} is missing column(s): {', '.join(sorted(missing))}. "
                         "First line must be: name,ip,brand,username,password")
    cams = [r for r in rows if r.get("ip")]
    for r in cams:
        r["name"] = r.get("name") or r["ip"]
        r.setdefault("brand", "auto")
    return cams


def check_all(path):
    cams = load_cameras(path)
    with ThreadPoolExecutor(max_workers=32) as pool:
        results = list(pool.map(check_camera, cams))
    for r in results:
        print(f"{r['checked']}  {r['name']:<20} {r['ip']:<16} {r['state']:<8} {r['detail']}")
    return results


PAGE = (Path(__file__).with_name("dashboard.html")).read_text(encoding="utf-8")


def serve(csv_path, port):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status = 200
            if self.path.startswith("/api/status"):
                try:
                    data = check_all(csv_path)
                except Exception as e:  # noqa: BLE001 - show the problem on the page
                    print(f"Error: {e}")
                    data, status = {"error": str(e)}, 500
                body = json.dumps(data).encode()
                ctype = "application/json"
            elif self.path in ("/", "/index.html"):
                body, ctype = PAGE.encode(), "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        raise SystemExit(f"Cannot start on port {port}: {e.strerror}. "
                         f"Try another port, e.g. --port {port + 10}")
    print(f"Dashboard running at http://localhost:{port}  (Ctrl+C to stop)")
    server.serve_forever()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cameras", default="cameras.csv")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--once", action="store_true", help="print status table and exit")
    args = ap.parse_args()
    if args.once:
        fmt = "{:<20} {:<16} {:<10} {:<8} {:>9} {:>9} {:>6}  {}"
        print(fmt.format("NAME", "IP", "BRAND", "STATE", "TOTAL GB", "FREE GB", "USED%", "DETAIL"))
        for r in check_all(args.cameras):
            print(fmt.format(r["name"], r["ip"], r["brand"], r["state"],
                             r.get("total_gb", "-"), r.get("free_gb", "-"),
                             r.get("used_pct", "-") if r.get("used_pct") is not None else "-",
                             r["detail"]))
    else:
        serve(args.cameras, args.port)


if __name__ == "__main__":
    main()
