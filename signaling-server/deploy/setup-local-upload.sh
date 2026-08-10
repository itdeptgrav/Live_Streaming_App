#!/usr/bin/env bash
# Variant of setup.sh for when the code is uploaded via scp instead of
# cloned from git. Run as root on the droplet AFTER you've scp'd the
# signaling-server folder to /opt/live-streaming-app/signaling-server.
#
# Usage: bash setup-local-upload.sh YOUR_DOMAIN
set -euo pipefail

DOMAIN="${1:?Usage: setup-local-upload.sh <domain>}"
APP_DIR="/opt/live-streaming-app/signaling-server"

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "!! $APP_DIR/server.js not found. Upload the signaling-server folder there first (see scp command)." >&2
  exit 1
fi

echo "==> Installing base packages"
apt-get update -y
# build-essential/python3 are the fallback toolchain for better-sqlite3 on the
# rare occasion no prebuilt binary matches this Node ABI.
apt-get install -y curl nginx certbot python3-certbot-nginx ufw build-essential python3

echo "==> Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2

echo "==> Installing signaling-server dependencies"
cd "$APP_DIR"
npm install --omit=dev

# The database lives outside APP_DIR so re-uploading the app cannot destroy it.
mkdir -p /var/lib/grav-stream

if [ ! -f .env ]; then
  cp .env.example .env
  PUBLIC_IP=$(curl -4 -s ifconfig.me)
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s|^MEDIASOUP_ANNOUNCED_IP=.*|MEDIASOUP_ANNOUNCED_IP=${PUBLIC_IP}|" .env
  sed -i "s|^TOKEN_SECRET=.*|TOKEN_SECRET=${SECRET}|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=wss://${DOMAIN}|" .env
  echo "!! Wrote .env: public IP ${PUBLIC_IP}, generated TOKEN_SECRET, PUBLIC_URL=wss://${DOMAIN}"
  echo "!! Now edit $APP_DIR/.env and set ALLOWED_ORIGINS to your dashboard's URL."
else
  echo "==> .env already exists, leaving it untouched"
fi

echo "==> Configuring Nginx"
sed "s/YOUR_DOMAIN/${DOMAIN}/" deploy/nginx.conf.template > /etc/nginx/sites-available/signaling
ln -sf /etc/nginx/sites-available/signaling /etc/nginx/sites-enabled/signaling
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Requesting TLS certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN}" --redirect

echo "==> Configuring firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw allow 40000:49999/udp
ufw allow 40000:49999/tcp
ufw --force enable

echo "==> Starting signaling server under pm2"
pm2 delete signaling-server 2>/dev/null || true
pm2 start npm --name signaling-server -- start
pm2 save
pm2 startup systemd -u root --hp /root | tail -n1 | bash || true

echo ""
echo "Done. Signaling server should be live at: wss://${DOMAIN}"
echo "Next steps:"
echo "  1. Double-check ALLOWED_ORIGINS in $APP_DIR/.env matches your frontend domain, then: pm2 restart signaling-server"
echo "  2. Set NEXT_PUBLIC_SIGNALING_URL=wss://${DOMAIN} in your frontend's env (e.g. Vercel project settings) and redeploy"
