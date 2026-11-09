#!/usr/bin/env bash
# Builds cctv-monitor-windows.zip: CCTV Storage Monitor for Windows WITHOUT Docker and without any
# download on the target PC. It bundles Node.js, PostgreSQL, Caddy, go2rtc and the Visual C++ runtime
# DLLs PostgreSQL needs, each pinned to a version and checked against its checksum.
#
# Usage (from the repository root, on Linux or macOS, after `npm ci`):
#   windows/build-package.sh [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-windows}"
CACHE="${CACHE_DIR:-$OUT/cache}"
STAGE="$OUT/cctv-monitor"
mkdir -p "$CACHE"

NODE_VERSION=22.23.3
fetch() { # url file sha256
  local url="$1" file="$CACHE/$2" sum="$3"
  if [ ! -f "$file" ] || ! echo "$sum  $file" | sha256sum -c --quiet - 2>/dev/null; then
    echo "Downloading $2"
    curl -fsSL --retry 3 -o "$file" "$url"
  fi
  echo "$sum  $file" | sha256sum -c --quiet - || { echo "Checksum mismatch: $2" >&2; exit 1; }
}
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" node-win.zip 2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71
fetch "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-16.15.0-beta.19.tgz" pg-win.tgz 7f338e7eb0e892000e10ec09ac95e005f453a9db24d11c9ed0b83c71f51667ff
fetch "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_windows_amd64.zip" caddy-win.zip 2631fbe1c4f6fb08783ed6dc6ac238d6655b4c923abe2bce1433dbd7fd079630
fetch "https://github.com/AlexxIT/go2rtc/releases/download/v1.9.4/go2rtc_win64.zip" go2rtc-win.zip 167b64f12cf0ecb3714d2911a4a92c2809c37d43d9f1dd02a0575b6488107816
fetch "https://files.pythonhosted.org/packages/98/33/be9ef68901200813fc174a06758b4ae48ca4eb58fa783280dd879d5fd048/msvc_runtime-14.51.36231-cp312-cp312-win_amd64.whl" msvc-runtime.whl 89f70d1a37bb64164cdb09d02dd82d6b1400e1310be2995b4ed5a9f23efe2222

echo "Building the app"
(cd "$ROOT" && npm run build >/dev/null)

rm -rf "$STAGE"
mkdir -p "$STAGE/app/server" "$STAGE/app/web" "$STAGE/runtime/node" "$STAGE/runtime/pgsql" "$STAGE/licenses" "$OUT/tmp"
TMP="$(mktemp -d "$OUT/tmp/XXXX")"

# The app: built server and web pages, and the server's production libraries (plain JavaScript).
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/app/"
cp "$ROOT/server/package.json" "$STAGE/app/server/"
cp "$ROOT/web/package.json" "$STAGE/app/web/"
cp -r "$ROOT/server/dist" "$ROOT/server/migrations" "$STAGE/app/server/"
cp -r "$ROOT/web/dist" "$STAGE/app/web/"
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace server >/dev/null)
# No links (Windows zip tools do not restore them; the app does not import itself) and no empty folders.
rm -rf "$STAGE/app/node_modules/.bin"
find "$STAGE/app/node_modules" -type l -delete
find "$STAGE/app/node_modules" -type d -empty -delete

# Node.js (node.exe alone is all the app needs).
unzip -q -o "$CACHE/node-win.zip" -d "$TMP"
cp "$TMP/node-v$NODE_VERSION-win-x64/node.exe" "$STAGE/runtime/node/"
cp "$TMP/node-v$NODE_VERSION-win-x64/LICENSE" "$STAGE/licenses/node.txt"

# PostgreSQL (without the GUI libraries of its installer), with the Visual C++ runtime beside it.
tar -xzf "$CACHE/pg-win.tgz" -C "$TMP"
cp -r "$TMP/package/native/bin" "$TMP/package/native/lib" "$TMP/package/native/share" "$STAGE/runtime/pgsql/"
rm -f "$STAGE/runtime/pgsql/bin/"wx*.dll
cp "$TMP/package/LICENSE.md" "$STAGE/licenses/embedded-postgres.md"
python3 -I -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$CACHE/msvc-runtime.whl" "$TMP/vc"
for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do
  cp "$(find "$TMP/vc" -path '*Scripts*' -iname "$dll" | head -1)" "$STAGE/runtime/pgsql/bin/"
done

# Caddy (HTTPS) and go2rtc (live video).
unzip -q -o "$CACHE/caddy-win.zip" caddy.exe LICENSE -d "$TMP/caddy"
cp "$TMP/caddy/caddy.exe" "$STAGE/runtime/"
cp "$TMP/caddy/LICENSE" "$STAGE/licenses/caddy.txt"
unzip -q -o "$CACHE/go2rtc-win.zip" -d "$TMP/go2rtc"
cp "$(find "$TMP/go2rtc" -iname 'go2rtc*.exe' | head -1)" "$STAGE/runtime/go2rtc.exe"

# Launch scripts and instructions.
cp -r "$ROOT/windows/service" "$STAGE/"
cp "$ROOT/windows/"*.bat "$ROOT/windows/README-WINDOWS.txt" "$STAGE/"
cp "$ROOT/LICENSE"* "$STAGE/licenses/" 2>/dev/null || true

rm -rf "$OUT/tmp"
rm -f "$OUT/cctv-monitor-windows.zip"
(cd "$OUT" && zip -qr -9 cctv-monitor-windows.zip cctv-monitor)
echo "Built $OUT/cctv-monitor-windows.zip ($(du -h "$OUT/cctv-monitor-windows.zip" | cut -f1))"
