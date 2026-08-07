# coturn setup (TURN/STUN) — optional fallback

**Not needed for the current setup.** TURN is provided by metered.ca's free
tier instead — see `docs/turn-metered.md`. Keep this doc around only for if
you outgrow metered's free 20GB/month and want to self-host TURN instead.

Public STUN (`stun.l.google.com:19302`) is enough for devices on the same
network or with permissive NAT. Office Wi-Fi/firewalls often block direct P2P
though — coturn is the free, self-hosted fallback that relays media when a
direct connection can't be established. It should run once, near your
signaling server, not per-device.

## Install (Ubuntu/Debian droplet or office server)

```bash
sudo apt update && sudo apt install -y coturn
```

Edit `/etc/turnserver.conf`:

```
listening-port=3478
fingerprint
lt-cred-mech
user=monitor:CHANGE_ME_STRONG_PASSWORD
realm=screenmonitor.local
# Restrict to your office's public IP range if possible instead of 0.0.0.0
listening-ip=0.0.0.0
external-ip=YOUR_SERVER_PUBLIC_IP
min-port=49152
max-port=65535
```

Enable and start:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl restart coturn
sudo systemctl enable coturn
```

Open firewall ports: `3478/udp`, `3478/tcp`, and the relay range
`49152-65535/udp`.

## Wire it into the frontend

In `web/lib/webrtcConfig.js`, uncomment the TURN entry and set:

```
NEXT_PUBLIC_TURN_USERNAME=monitor
NEXT_PUBLIC_TURN_CREDENTIAL=CHANGE_ME_STRONG_PASSWORD
```

(Static long-term credentials are fine for an internal office tool; rotate
the password periodically. If this ever gets exposed to the public internet,
switch to coturn's REST API short-lived credential mechanism instead.)

## Verify

After deploying, test from a device on a *different* network than the
signaling server (e.g. phone hotspot) — that's the scenario that actually
needs TURN. If the video connects there, NAT traversal is working.
