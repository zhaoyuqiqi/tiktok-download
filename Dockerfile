FROM oven/bun:1-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    ffmpeg \
    tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY docker/entrypoint.sh /app/docker/entrypoint.sh
COPY docker/update-ytdlp.sh /app/scripts/update-ytdlp.sh

RUN chmod +x /app/docker/entrypoint.sh /app/scripts/update-ytdlp.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_DATA_DIR=/app/data \
    TZ=Asia/Shanghai

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const port=process.env.PORT||3000; const r=await fetch('http://127.0.0.1:'+port+'/health'); if(!r.ok) process.exit(1);" || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
