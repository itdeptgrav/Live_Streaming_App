#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 DigitalOcean droplet.
# Run as root (or with sudo) over SSH: bash setup.sh YOUR_DOMAIN YOUR_GIT_REPO_URL
#
# What it does:
#   1. Installs Node.js 20, Nginx, Certbot, pm2
#   2. Clones the repo and installs signaling-server deps
#   3. Configures the Nginx reverse proxy + Let's Encrypt TLS cert
#   4. Opens the firewall for SSH/HTTP/HTTPS + mediasoup's UDP RTP range
#   5. Starts the signaling server under pm2 (auto-restarts on reboot/crash)
#
# You still need to do BEFORE running this:
#   - Point YOUR_DOMAIN's DNS A record at this droplet's public IP
#   - Have signaling-server/.env ready to fill in after cloning (see .env.example)
set -euo pipefail

DOMAIN="${1:?Usage: setup.sh <domain> <git-repo-url>}"
REPO_URL="${2:?Usage: setup.sh <domain> <git-repo-url>}"
APP_DIR="/opt/live-streaming-app"

echo "==> Installing base packages"
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw

echo "==> Installing Node.js 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2

echo "==> Cloning repo"
if [ -d "$APP_DIR" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> Installing signaling-server dependencies"
cd "$APP_DIR/signaling-server"
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  PUBLIC_IP=$(curl -4 -s ifconfig.me)
  sed -i "s/^MEDIASOUP_ANNOUNCED_IP=.*/MEDIASOUP_ANNOUNCED_IP=${PUBLIC_IP}/" .env
  echo "!! Wrote .env with detected public IP ${PUBLIC_IP}."
  echo "!! Now edit $APP_DIR/signaling-server/.env and set ALLOWED_ORIGINS to your frontend's URL."
fi

echo "==> Configuring Nginx"
sed "s/YOUR_DOMAIN/${DOMAIN}/" deploy/nginx.conf.template > /etc/nginx/sites-available/signaling
ln -sf /etc/nginx/sites-available/signaling /etc/nginx/sites-enabled/signaling
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
echo "  1. Double-check ALLOWED_ORIGINS in $APP_DIR/signaling-server/.env matches your frontend domain, then: pm2 restart signaling-server"
echo "  2. Set NEXT_PUBLIC_SIGNALING_URL=wss://${DOMAIN} in your frontend's env (e.g. Vercel project settings) and redeploy"
