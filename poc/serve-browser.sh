#!/bin/bash
set -e

CDP_PORT=${CDP_PORT:-9222}
PROXY_PORT=${PROXY_PORT:-9223}
SHARE_MOUNT=/mnt/share

# Mount shared VVFAT drive if not already mounted (via fstab/9p)
if ! mountpoint -q "$SHARE_MOUNT" 2>/dev/null; then
  mkdir -p "$SHARE_MOUNT"
  for dev in /dev/vdb1 /dev/vdb /dev/vdc1 /dev/vdc; do
    [ -b "$dev" ] && mount -o ro "$dev" "$SHARE_MOUNT" 2>/dev/null && break
  done
fi

# Read browser path from config
if [ ! -f "$SHARE_MOUNT/browser-path" ]; then
  echo "ERROR: $SHARE_MOUNT/browser-path not found" > /dev/ttyS0
  exit 1
fi

BROWSER_PATH=$(cat "$SHARE_MOUNT/browser-path")

# Detect browser type from path
if echo "$BROWSER_PATH" | grep -q "firefox"; then
  $BROWSER_PATH --headless --no-sandbox --remote-debugging-port $CDP_PORT &
else
  $BROWSER_PATH --headless --no-sandbox --disable-gpu --remote-debugging-port=$CDP_PORT &
fi
BROWSER_PID=$!

# Wait for CDP to be ready
for i in $(seq 1 60); do
  if ss -tlnp | grep -q ":$CDP_PORT"; then
    break
  fi
  sleep 0.5
done

# Proxy 127.0.0.1 -> 0.0.0.0 for hostfwd access
socat TCP-LISTEN:$PROXY_PORT,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:$CDP_PORT &

echo "SERVE_BROWSER_READY $PROXY_PORT" > /dev/ttyS0

wait $BROWSER_PID
