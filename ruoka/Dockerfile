# Pinned so a rebuild cannot silently pick up a different runtime; Dependabot proposes updates
FROM oven/bun:1.4.4-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl jq ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*
# Docker caches a step by its command text, so without this the Tailscale layer would keep the
# version from the first build forever: bumping "version" in config.yaml (BUILD_VERSION) forces a
# fresh install of the latest Tailscale, which is how security fixes get picked up.
ARG BUILD_VERSION=dev
# Tailscale's signed apt repository, rather than piping a remote install script into a shell
RUN echo "Installing latest Tailscale for ${BUILD_VERSION}" \
 && . /etc/os-release \
 && curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.noarmor.gpg" \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.tailscale-keyring.list" \
      -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

# The app folder is the build context, so the server source is cloned rather than copied.
# Docker caches a step by its command text, not by what is on GitHub, so the clone step uses
# BUILD_VERSION (passed by Home Assistant from config.yaml): bumping "version" there forces a
# fresh clone instead of silently reusing the code from an earlier build.
ARG RUOKA_REF=claude/tender-einstein-qhzpmc
ARG BUILD_VERSION=dev
RUN echo "Building Ruoka MCP ${BUILD_VERSION} from ${RUOKA_REF}" \
 && git clone --depth 1 --branch "${RUOKA_REF}" https://github.com/Jameshooper/mcp-ruoka.git /app
WORKDIR /app
RUN bun install --frozen-lockfile --production \
 && bunx playwright install --with-deps chromium

COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
