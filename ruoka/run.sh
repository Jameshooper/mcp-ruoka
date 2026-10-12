#!/usr/bin/env bash
set -euo pipefail

OPTIONS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

MCP_AUTH_TOKEN="$(opt mcp_auth_token)"
OAUTH_CLIENT_ID="$(opt oauth_client_id)"
OAUTH_CLIENT_SECRET="$(opt oauth_client_secret)"
TS_AUTH_KEY="$(opt tailscale_auth_key)"
TS_HOSTNAME="$(opt tailscale_hostname)"

# The published port is reachable from the whole LAN, so never run it open
if [ -z "$MCP_AUTH_TOKEN" ] && { [ -z "$OAUTH_CLIENT_ID" ] || [ -z "$OAUTH_CLIENT_SECRET" ]; }; then
  echo "Set mcp_auth_token, or both oauth_client_id and oauth_client_secret, in the app configuration" >&2
  exit 1
fi

if [ -n "$TS_AUTH_KEY" ]; then
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled --tun=userspace-networking \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock &

  until [ -S /var/run/tailscale/tailscaled.sock ]; do sleep 0.5; done

  tailscale up --auth-key="$TS_AUTH_KEY" --hostname="${TS_HOSTNAME:-ruoka}"
  tailscale funnel --bg 3001
  tailscale funnel status
else
  echo "No tailscale_auth_key set: not using Funnel; reachable on the host at port 3001" >&2
fi

export MCP_AUTH_TOKEN OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET
export BROWSER_DATA_DIR=/data/browser
cd /app
exec bun run src/index.ts
