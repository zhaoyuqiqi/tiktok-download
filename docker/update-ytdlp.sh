#!/usr/bin/env sh
set -eu

echo "[$(date -Iseconds)] checking yt-dlp update"

if [ -n "${APP_PROXY_URL:-}" ]; then
  bun run src/ytdlp-manager/update.ts --proxy "${APP_PROXY_URL}"
else
  bun run src/ytdlp-manager/update.ts
fi
