#!/usr/bin/env bash
# Build the self-hosted variant and ship it to the Raspberry Pi.
#
#   scripts/deploy-pi.sh                    # default Pi over Tailscale
#   PI=pranav@192.168.137.253 scripts/deploy-pi.sh
#
# On the Pi everything lives in ~/habitnow: app/ (the build), server/ (the
# Node server and its unit file) and data/ (accounts, habits, backups). A
# deploy replaces app/ and server/ and never touches data/.
set -euo pipefail
cd "$(dirname "$0")/.."

PI="${PI:-pranav@100.103.79.120}"

npm run build:pi

echo "Uploading to $PI"
tar -czf - -C dist-pi . | ssh "$PI" 'rm -rf ~/habitnow/app.new && mkdir -p ~/habitnow/app.new && tar -xzf - -C ~/habitnow/app.new'
tar -czf - -C server habitnow-server.mjs habitnow.service | ssh "$PI" 'mkdir -p ~/habitnow/server ~/habitnow/data && tar -xzf - -C ~/habitnow/server'

ssh "$PI" 'set -e
  cd ~/habitnow
  rm -rf app.old
  [ -d app ] && mv app app.old
  mv app.new app
  rm -rf app.old
  if ! cmp -s server/habitnow.service /etc/systemd/system/habitnow.service; then
    sudo cp server/habitnow.service /etc/systemd/system/habitnow.service
    sudo systemctl daemon-reload
    sudo systemctl enable habitnow
  fi
  sudo systemctl restart habitnow
  sleep 1
  systemctl is-active habitnow'
