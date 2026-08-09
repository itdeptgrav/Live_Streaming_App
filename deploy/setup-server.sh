#!/usr/bin/env bash
# One-shot provisioning for a fresh Ubuntu 22.04/24.04 VPS (Oracle Ampere ARM,
# Hetzner, DigitalOcean — anything with a public IP and root).
#
#   curl -fsSL <raw-url>/setup-server.sh -o setup.sh && bash setup.sh
# or just run it after uploading the repo.
set -euo pipefail

MIN_PORT="${MEDIASOUP_MIN_PORT:-40000}"
MAX_PORT="${MEDIASOUP_MAX_PORT:-40100}"

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y curl git python3 python3-pip build-essential \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> meson + ninja (needed to compile the mediasoup worker)"
pip3 install --break-system-packages --quiet meson ninja || pip3 install --quiet meson ninja

echo "==> Caddy (automatic HTTPS for the signalling WebSocket)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> Host firewall (iptables)"
# Oracle's Ubuntu images ship a restrictive ruleset that silently drops
# everything. Opening the cloud Security List alone is NOT enough — this is the
# single most common cause of "ICE stuck at new" on Oracle Cloud.
sudo iptables -I INPUT -p tcp --dport 80   -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443  -j ACCEPT
sudo iptables -I INPUT -p udp --dport "${MIN_PORT}:${MAX_PORT}" -j ACCEPT
sudo iptables -I INPUT -p tcp --dport "${MIN_PORT}:${MAX_PORT}" -j ACCEPT
sudo netfilter-persistent save

echo
echo "==> Done. Remaining manual steps:"
echo "  1. Open the SAME ports in your cloud firewall (OCI Security List /"
echo "     Hetzner firewall): TCP 80, TCP 443, UDP ${MIN_PORT}-${MAX_PORT}, TCP ${MIN_PORT}-${MAX_PORT}"
echo "  2. Point a DNS A record at this box's public IP"
echo "  3. cd signaling-server && cp .env.example .env && edit it"
echo "  4. npm install            # compiles the mediasoup worker (~3-5 min)"
echo "  5. sudo cp ../deploy/kumkum-signaling.service /etc/systemd/system/"
echo "     sudo systemctl daemon-reload && sudo systemctl enable --now kumkum-signaling"
echo "  6. Edit /etc/caddy/Caddyfile with your domain, then: sudo systemctl reload caddy"
