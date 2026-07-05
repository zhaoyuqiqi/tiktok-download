#!/usr/bin/env sh
set -eu

APP_DATA_DIR="${APP_DATA_DIR:-/app/data}"
mkdir -p "$APP_DATA_DIR"

# 容器内默认把 yt-dlp 工具目录放到可持久化目录下
export YT_DLP_TOOL_DIR="${YT_DLP_TOOL_DIR:-$APP_DATA_DIR/yt-dlp}"
mkdir -p "$YT_DLP_TOOL_DIR"

cat >/etc/cron.d/yt-dlp-update <<'CRON'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root /app/scripts/update-ytdlp.sh >> /proc/1/fd/1 2>> /proc/1/fd/2
CRON
chmod 0644 /etc/cron.d/yt-dlp-update

if [ "${DISABLE_YTDLP_BOOTSTRAP:-0}" != "1" ]; then
  echo "[entrypoint] bootstrap yt-dlp..."
  /app/scripts/update-ytdlp.sh
fi

echo "[entrypoint] start cron daemon"
cron

echo "[entrypoint] start app"
exec bun run src/index.ts
