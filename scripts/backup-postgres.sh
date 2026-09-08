#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"
OUTPUT_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$OUTPUT_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT_FILE="$OUTPUT_DIR/otp-gateway-${TIMESTAMP}.sql.gz"

pg_dump "$DATABASE_URL" | gzip > "$OUTPUT_FILE"
printf 'Created %s\n' "$OUTPUT_FILE"
