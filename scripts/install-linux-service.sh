#!/usr/bin/env bash
# Install (or reinstall) AI Usage Tracker as a systemd user service on Linux,
# for the server or a collector. Run it from the checkout, as the user whose
# ~/.codex and ~/.claude should be read, after `npm install && npm run build`
# and after creating .env:
#
#   bash scripts/install-linux-service.sh
#
# The unit points at this checkout and at the Node.js binary found now (set
# NODE_BIN to choose another), so rerun this after moving the checkout or
# switching Node versions. Settings (role, HOST, PORT, ...) live in .env.
#
# Logs:     journalctl --user -u ai-usage-tracker -f
# Restart:  systemctl --user restart ai-usage-tracker   (after `npm run build`)
set -euo pipefail

cd "$(dirname "$0")/.."
project_dir="$(pwd)"
service_name="ai-usage-tracker"

node_bin="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$node_bin" ]; then
  echo "node was not found on PATH; set NODE_BIN to its absolute path." >&2
  exit 1
fi
node_bin="$(readlink -f "$node_bin")"
if ! "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)'; then
  echo "$node_bin is Node $("$node_bin" -v); the tracker needs 22.5 or newer. Set NODE_BIN (for nvm: NODE_BIN=\$(nvm which default))." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "No .env in $project_dir. Copy .env.example to .env and set TRACKER_ROLE first." >&2
  exit 1
fi
if [ ! -f dist-server/index.js ]; then
  echo "dist-server/index.js is missing. Run: npm install && npm run build" >&2
  exit 1
fi

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
cat > "$unit_dir/$service_name.service" <<EOF
[Unit]
Description=AI Usage Tracker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$project_dir
# systemd starts services with a short PATH; include Node's folder and
# ~/.local/bin so the tracker can launch codex.
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin $project_dir/dist-server/index.js
# Always restart: at boot the tracker exits if its HOST address (for example
# the Tailscale IP) is not up yet, and comes back once it is.
Restart=always
RestartSec=10
# Stop cleanly: the tracker commits every write before it acknowledges anything.
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$service_name.service" >/dev/null
systemctl --user restart "$service_name.service"

# Without lingering, user services only run while the user is logged in.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" || echo "Could not enable lingering; run: sudo loginctl enable-linger $USER" >&2
fi

echo "Installed $unit_dir/$service_name.service (node: $node_bin)."
systemctl --user --no-pager --lines=5 status "$service_name.service" || true
