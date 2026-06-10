#!/usr/bin/env bash
# Update NixBall on the server: pull latest code, rebuild, restart.
# Run on the server: bash /opt/nixball/deploy/update.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> pulling latest code"
git pull --ff-only

echo "==> installing deps + building"
npm ci
npm run build

echo "==> restarting"
if systemctl is-active --quiet nixball 2>/dev/null; then
  sudo systemctl restart nixball
  echo "systemd service restarted"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe nixball >/dev/null 2>&1; then
  pm2 restart nixball
  echo "pm2 process restarted"
else
  echo "NOTE: no running service found — start it with:"
  echo "  sudo systemctl start nixball    (or: pm2 start dist/server.cjs --name nixball)"
fi

sleep 1
curl -fsS "http://127.0.0.1:${PORT:-3001}/healthz" >/dev/null \
  && echo "==> healthz OK — deployed" \
  || echo "==> WARNING: healthz check failed, inspect: journalctl -u nixball -n 50"
