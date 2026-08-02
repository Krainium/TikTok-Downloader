#!/bin/sh
# Start Xray, pin this instance to one exit, then run the web server.
set -e

BASE_PORT="${XRAY_BASE_PORT:-10809}"
mkdir -p /app/xray

POOL_SIZE=$(node /app/vless/build-xray-config.js /app/xray/config.json)

/usr/local/bin/xray -c /app/xray/config.json &
XRAY_PID=$!

i=0
until nc -z 127.0.0.1 "$BASE_PORT" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "xray did not open $BASE_PORT in time" >&2; exit 1; }
  kill -0 "$XRAY_PID" 2>/dev/null || { echo "xray exited during startup" >&2; exit 1; }
  sleep 0.25
done

# One exit for the whole instance, not per connection: extraction and the CDN
# download have to leave from the same IP, and the app carries a single global
# proxy. Different instances land on different exits, so the pool still rotates.
EXIT_INDEX=$(node -e "process.stdout.write(String(Math.floor(Math.random()*$POOL_SIZE)))")
export TIKTOK_PROXY_HOST=127.0.0.1
export TIKTOK_PROXY_PORT=$((BASE_PORT + EXIT_INDEX))
export TIKTOK_PROXY_USER="${XRAY_PROXY_USER:-ytdl}"
export TIKTOK_PROXY_PASS="${XRAY_PROXY_PASS:-local}"
echo "xray ready: $POOL_SIZE exits, this instance pinned to exit $EXIT_INDEX (port $TIKTOK_PROXY_PORT)"

trap 'kill -TERM "$XRAY_PID" "$APP_PID" 2>/dev/null; exit 0' TERM INT

npm run web:serve &
APP_PID=$!

while kill -0 "$XRAY_PID" 2>/dev/null && kill -0 "$APP_PID" 2>/dev/null; do
  sleep 2
done

kill -TERM "$XRAY_PID" "$APP_PID" 2>/dev/null || true
exit 1
