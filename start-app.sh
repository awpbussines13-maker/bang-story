#!/bin/bash
set -e

echo "Waiting for Xvfb on display :99..."
for i in {1..30}; do
    if [ -e /tmp/.X11-unix/X99 ]; then
        break
    fi
    sleep 0.5
done

sleep 1
echo "Starting Bang Story..."
exec ./node_modules/electron/dist/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage
