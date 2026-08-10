#!/usr/bin/env bash
# Run on the droplet after re-uploading changed source files.
# Installs any new dependencies and restarts the service.
#
#   bash /opt/live-streaming-app/signaling-server/deploy/update.sh
set -euo pipefail

APP_DIR="/opt/live-streaming-app/signaling-server"
cd "$APP_DIR"

echo "==> Installing dependencies"
npm install --omit=dev

# DATA_DIR lives outside APP_DIR precisely so this script can never touch it,
# but create it here too in case this is the first deploy after the DB landed.
mkdir -p /var/lib/grav-stream

if ! grep -q '^TOKEN_SECRET=.\+' .env 2>/dev/null; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if grep -q '^TOKEN_SECRET=' .env; then
    sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=${SECRET}|" .env
  else
    echo "TOKEN_SECRET=${SECRET}" >> .env
  fi
  echo "!! Generated a TOKEN_SECRET (room tokens are now stable across restarts)"
fi

if ! grep -q '^DATA_DIR=' .env 2>/dev/null; then
  echo "DATA_DIR=/var/lib/grav-stream" >> .env
  echo "!! Added DATA_DIR=/var/lib/grav-stream"
fi

echo "==> Restarting"
pm2 restart signaling-server --update-env
pm2 save

sleep 2
pm2 logs signaling-server --lines 20 --nostream
