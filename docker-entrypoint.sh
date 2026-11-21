#!/bin/sh
# CoreFeed v3.0 — Non-root privilege-dropping container entrypoint
# When started as UID 0 (default docker run / docker compose up), ensures mounted
# /app/data and /app/logs directories are writable by UID 1000 (`node`), then drops
# privileges permanently via su-exec and runs the target command under dumb-init.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data /app/logs
  chown -R node:node /app/data /app/logs 2>/dev/null || true
  exec su-exec node dumb-init -- "$@"
fi

exec dumb-init -- "$@"
