#!/usr/bin/env bash
set -euo pipefail

OPTIONS=/data/options.json
opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

OAUTH_CLIENT_ID="$(opt oauth_client_id)"
OAUTH_CLIENT_SECRET="$(opt oauth_client_secret)"
TS_AUTH_KEY="$(opt tailscale_auth_key)"
TS_HOSTNAME="$(opt tailscale_hostname)"

if [ -z "$OAUTH_CLIENT_ID" ] || [ -z "$OAUTH_CLIENT_SECRET" ]; then
  echo "Set oauth_client_id and oauth_client_secret in the app configuration" >&2
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
  echo "No tailscale_auth_key set: serving on port 3001 inside the container only" >&2
fi

export OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET
export BROWSER_DATA_DIR=/data/browser
cd /app
exec bun run src/index.ts
