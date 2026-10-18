#!/bin/sh
# Nightly database backup for the Docker Compose deployment.
# Usage: deploy/backup.sh [backup-dir]   (keeps 14 days)
# The encryption key (CREDENTIAL_ENCRYPTION_KEY) is NOT in the dump: back it up separately and securely.
set -eu
DIR="${1:-./backups}"
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$DIR/cctv-$STAMP.dump"
find "$DIR" -name 'cctv-*.dump' -mtime +14 -delete
echo "Backup written to $DIR/cctv-$STAMP.dump"
