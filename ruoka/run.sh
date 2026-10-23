#!/usr/bin/env bash
set -euo pipefail

OPTIONS=/data/options.json

# Shows which code this image really contains (compare with the latest commit on GitHub)
echo "Ruoka source: $(git -C /app log -1 --format='%h %s')"
opt() { jq -r --arg k "$1" '.[$k] // ""' "$OPTIONS"; }

MCP_AUTH_TOKEN="$(opt mcp_auth_token)"
OAUTH_CLIENT_ID="$(opt oauth_client_id)"
OAUTH_CLIENT_SECRET="$(opt oauth_client_secret)"
# Pasted keys often carry stray whitespace or quotes
TS_AUTH_KEY="$(opt tailscale_auth_key | tr -d '[:space:]"' | tr -d "'")"
TS_HOSTNAME="$(opt tailscale_hostname)"
UI_ALLOWED_LOGINS="$(opt ui_allowed_logins | tr -d '[:space:]')"
RUOKA_DEFAULT_STORE_ID="$(opt default_store_id | tr -d '[:space:]')"
RUOKA_DEFAULT_STORE_NAME="$(opt default_store_name)"
RUOKA_CLAUDE_NOTE="$(opt claude_prompt_note)"
MCP_ALLOWED_IPS="$(opt mcp_allowed_ips | tr -d '[:space:]')"
RUOKA_NOTIFY_SERVICE="$(opt notify_service | tr -d '[:space:]')"

# The MCP endpoint is public through Funnel (or local without it), so never run it open
if [ -z "$MCP_AUTH_TOKEN" ] && { [ -z "$OAUTH_CLIENT_ID" ] || [ -z "$OAUTH_CLIENT_SECRET" ]; }; then
  echo "Set mcp_auth_token, or both oauth_client_id and oauth_client_secret, in the app configuration" >&2
  exit 1
fi

if [ -n "$TS_AUTH_KEY" ]; then
  case "$TS_AUTH_KEY" in
    tskey-auth-*) ;;
    *)
      echo "tailscale_auth_key must be an auth key starting with tskey-auth- (Tailscale admin: Settings > Keys > Generate auth key). API access tokens (tskey-api-) will not work." >&2
      exit 1
      ;;
  esac
  mkdir -p /data/tailscale /var/run/tailscale
  tailscaled --tun=userspace-networking \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock &

  until [ -S /var/run/tailscale/tailscaled.sock ]; do sleep 0.5; done

  tailscale up --auth-key="$TS_AUTH_KEY" --hostname="${TS_HOSTNAME:-ruoka}"
  # Userspace networking hands direct tailnet connections to 127.0.0.1:<port>, where they would
  # look like trusted proxy traffic. The servers listen on 127.0.0.2 instead, which only the
  # Funnel and serve proxies below are pointed at. Earlier versions pointed them at 127.0.0.1, so
  # the old configuration is cleared first.
  LISTEN_HOST=127.0.0.2
  tailscale serve reset || true
  tailscale funnel --bg "http://$LISTEN_HOST:3001"
  tailscale funnel status

  # The standalone recipe app: tailnet members only (plain serve, not Funnel), on port 8443. The
  # node's owner is allowed unless ui_allowed_logins lists others.
  # Failures here must not stop the MCP server itself, so they only warn.
  tailscale serve --bg --https=8443 "http://$LISTEN_HOST:3003" || echo "Could not publish the standalone recipe app on port 8443" >&2
  tailscale serve status || true
  if [ -z "$UI_ALLOWED_LOGINS" ]; then
    UI_ALLOWED_LOGINS="$(tailscale status --json | jq -r '.User[(.Self.UserID | tostring)].LoginName // empty' || true)"
  fi
  TS_DNS_NAME="$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")' || true)"
  echo "Standalone recipe app: https://$TS_DNS_NAME:8443 (allowed: ${UI_ALLOWED_LOGINS:-nobody})"

  # Funnel only gets a public address when the tailnet policy grants this node the "funnel" attribute
  echo "Tailscale node: $(tailscale status --json | jq -c '{DNSName: .Self.DNSName, Online: .Self.Online, Attributes: ((.Self.CapMap // {}) | keys)}')"
else
  echo "No tailscale_auth_key set: not using Funnel; map port 3001 under the app's Network tab to reach it" >&2
fi

export MCP_AUTH_TOKEN OAUTH_CLIENT_ID OAUTH_CLIENT_SECRET MCP_ALLOWED_IPS RUOKA_NOTIFY_SERVICE
export BROWSER_DATA_DIR=/data/browser
export RUOKA_DATA_DIR=/data
export RUOKA_DEFAULT_STORE_ID RUOKA_DEFAULT_STORE_NAME RUOKA_CLAUDE_NOTE
# Served only through Home Assistant ingress, which the server checks by the proxy's address
export RUOKA_UI_PORT=3002
if [ -n "$TS_AUTH_KEY" ]; then
  export MCP_HOST="$LISTEN_HOST"
  export RUOKA_UI_STANDALONE_HOST="$LISTEN_HOST"
  export RUOKA_UI_STANDALONE_PORT=3003
  export RUOKA_UI_ALLOWED_LOGINS="$UI_ALLOWED_LOGINS"
  # OAuth discovery advertises this address instead of trusting the request's Host header
  if [ -n "$TS_DNS_NAME" ]; then export RUOKA_PUBLIC_URL="https://$TS_DNS_NAME"; fi
fi
if [ -n "$MCP_AUTH_TOKEN" ] && [ -n "$TS_AUTH_KEY" ]; then
  echo "Note: mcp_auth_token only works for local clients; requests through Funnel must use OAuth" >&2
fi
cd /app
exec bun run src/index.ts
