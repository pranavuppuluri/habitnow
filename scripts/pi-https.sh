#!/usr/bin/env bash
# Put HabitNow on the Pi behind HTTPS with Tailscale Serve, so phones can
# install it and allow reminders.
#
#   scripts/pi-https.sh                     # default Pi over Tailscale
#   PI=pranav@192.168.137.253 scripts/pi-https.sh
#   scripts/pi-https.sh off                 # stop serving HTTPS
#
# Tailscale gets a real certificate for the Pi's tailnet name, for example
# https://raspberrypi.your-tailnet.ts.net, and forwards to the server on
# 127.0.0.1:8080. Only devices on your tailnet can reach it; nothing is opened
# to the internet. Turn on MagicDNS and HTTPS Certificates once, under DNS in
# the Tailscale admin console (https://login.tailscale.com/admin/dns).
set -euo pipefail

PI="${PI:-pranav@100.103.79.120}"
ACTION="${1:-on}"

if [ "$ACTION" = "off" ]; then
  ssh -t "$PI" 'sudo tailscale serve --https=443 off && tailscale serve status || true'
  exit 0
fi

ssh -t "$PI" 'set -e
  if ! tailscale status >/dev/null 2>&1; then
    echo "Tailscale is not running on the Pi. Start it with: sudo tailscale up" >&2
    exit 1
  fi
  if ! systemctl is-active --quiet habitnow; then
    echo "The habitnow service is not running. Deploy first: scripts/deploy-pi.sh" >&2
    exit 1
  fi
  name=$(tailscale status --json | python3 -c "import json, sys; print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))")
  # --bg keeps serving across reboots; Tailscale renews the certificate itself.
  sudo tailscale serve --bg --https=443 http://127.0.0.1:8080
  echo
  if curl -fsS -o /dev/null --max-time 20 "https://$name/"; then
    echo "HabitNow is on https://$name/"
  else
    echo "Serve is set up, but https://$name/ did not answer yet." >&2
    echo "If Tailscale printed a link above, turn on HTTPS Certificates there and run this again." >&2
    exit 1
  fi'
