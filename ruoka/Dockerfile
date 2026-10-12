FROM oven/bun:1-debian

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl jq ca-certificates gnupg \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://tailscale.com/install.sh | sh

# The app folder is the build context, so the server source is cloned rather than copied.
# Bump "version" in config.yaml to make Home Assistant rebuild and pick up new commits.
ARG RUOKA_REF=claude/tender-einstein-qhzpmc
RUN git clone --depth 1 --branch "${RUOKA_REF}" https://github.com/Jameshooper/mcp-ruoka.git /app
WORKDIR /app
RUN bun install --frozen-lockfile --production \
 && bunx playwright install --with-deps chromium

COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
