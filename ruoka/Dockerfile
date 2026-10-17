FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl jq ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://tailscale.com/install.sh | sh

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
