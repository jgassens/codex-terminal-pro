FROM ghcr.io/home-assistant/base:3.22-2026.04.0@sha256:eed9b5eff1441d4db22d5036b7802610e7fc94af8c0448439ae6dda9942d5230

LABEL \
    io.hass.version="2.13.3" \
    io.hass.type="addon" \
    io.hass.arch="aarch64|amd64" \
    org.opencontainers.image.title="Home Assistant Add-on: Codex Terminal Pro" \
    org.opencontainers.image.description="Unofficial OpenAI Codex CLI terminal for Home Assistant" \
    org.opencontainers.image.source="https://github.com/jgassens/codex-terminal-pro" \
    org.opencontainers.image.licenses="MIT"

# Install packages in a single layer to minimize image size.
# Node.js and npm are kept for Codex CLI and the image-service dependency.
RUN apk add --no-cache \
    nodejs \
    npm \
    bash \
    curl \
    nano \
    python3 \
    py3-pip \
    py3-pyserial \
    py3-requests \
    py3-aiohttp \
    py3-yaml \
    py3-beautifulsoup4 \
    jq \
    yq \
    git \
    ripgrep \
    nmap-ncat \
    socat \
    tcpdump \
    libmodbus \
    sqlite \
    mosquitto-clients \
    bind-tools \
    iputils \
    openssl \
    openssh-client \
    rsync \
    vim \
    wget \
    tree \
    tmux \
    bubblewrap \
    procps-ng \
    ttyd

# Install Codex CLI.
ARG CODEX_CLI_VERSION=0.160.0
# Codex's background app server records its start time with
# `ps -p PID -o stat=,lstart=`, which BusyBox ps rejects; procps-ng provides it.
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && codex --version \
    && ps -p 1 -o stat=,lstart= >/dev/null \
    && rm -rf /root/.npm

# Install the optional consultant CLIs. They are inert without credentials:
# Codex remains this add-on's agent, and these are only reachable through the
# `consult` command, which runs each provider read-only as its own unprivileged
# user.
ARG CLAUDE_CODE_VERSION=2.1.287
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && DISABLE_AUTOUPDATER=1 claude --version \
    && rm -rf /root/.npm

ARG KIMI_CODE_VERSION=2.1.1
RUN npm install -g "@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}" \
    && kimi --version \
    && rm -rf /root/.npm

# Never self-update inside a pinned image, and use the apk ripgrep because the
# vendored one is glibc-linked.
ENV DISABLE_AUTOUPDATER=1 \
    USE_BUILTIN_RIPGREP=0

# Install read-only Modbus Python tooling into an isolated import path.
RUN PIP_ROOT_USER_ACTION=ignore python3 -m pip install --no-cache-dir --target /opt/modbus-python \
        'pymodbus[serial]==3.13.0' \
        'minimalmodbus==2.1.1' \
        'pyserial==3.5' \
    && PYTHONPATH=/opt/modbus-python python3 -c "import minimalmodbus, pymodbus, serial; print('Modbus Python tooling installed')"

ENV PYTHONPATH="/opt/modbus-python"

# Install Home Assistant CLI (ha command).
# Download appropriate binary based on build architecture.
ARG TARGETARCH
ARG BUILD_ARCH
ARG HA_CLI_VERSION=5.5.0
ARG HA_CLI_SHA256_AMD64=fb2e2177bd7bc014f029b807cd1cc7d74484ecfed1e90d5f9b2a61d65ff5393d
ARG HA_CLI_SHA256_ARM64=af390ab7f91a8135668ace7b1425d8e53800b6a1fc3b36fc588df701d2ab3db5
RUN RESOLVED_ARCH="${TARGETARCH:-${BUILD_ARCH:-$(apk --print-arch)}}" && \
    case "${RESOLVED_ARCH}" in \
        amd64|x86_64) HA_ARCH="amd64"; HA_SHA256="${HA_CLI_SHA256_AMD64}" ;; \
        arm64|aarch64) HA_ARCH="aarch64"; HA_SHA256="${HA_CLI_SHA256_ARM64}" ;; \
        *)       echo "Unsupported architecture: ${RESOLVED_ARCH}" && exit 1 ;; \
    esac && \
    echo "Installing Home Assistant CLI ${HA_CLI_VERSION} for ${HA_ARCH}..." && \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --output /usr/bin/ha \
        "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/ha_${HA_ARCH}" && \
    printf '%s  %s\n' "${HA_SHA256}" /usr/bin/ha | sha256sum -c - && \
    chmod +x /usr/bin/ha && \
    /usr/bin/ha --help >/dev/null && \
    echo "Home Assistant CLI ${HA_CLI_VERSION} installed successfully"

# Install GitHub CLI (gh command).
ARG GH_CLI_VERSION=2.102.0
ARG GH_CLI_SHA256_AMD64=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG GH_CLI_SHA256_ARM64=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484
RUN RESOLVED_ARCH="${TARGETARCH:-${BUILD_ARCH:-$(apk --print-arch)}}" && \
    case "${RESOLVED_ARCH}" in \
        amd64|x86_64) GH_ARCH="amd64"; GH_SHA256="${GH_CLI_SHA256_AMD64}" ;; \
        arm64|aarch64) GH_ARCH="arm64"; GH_SHA256="${GH_CLI_SHA256_ARM64}" ;; \
        *)       echo "Unsupported architecture for gh: ${RESOLVED_ARCH}" && exit 1 ;; \
    esac && \
    echo "Installing GitHub CLI v${GH_CLI_VERSION} for ${GH_ARCH}..." && \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
        --output /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz" && \
    printf '%s  %s\n' "${GH_SHA256}" /tmp/gh.tar.gz | sha256sum -c - && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}/bin/gh /usr/bin/gh && \
    chmod +x /usr/bin/gh && \
    /usr/bin/gh --version && \
    rm -rf /tmp/gh* && \
    echo "GitHub CLI v${GH_CLI_VERSION} installed successfully"

# Each optional consultant gets a fixed, non-login kernel identity. Disposable
# homes are mode 0700 and the process also receives a Landlock filesystem rule.
RUN addgroup -S -g 61001 ctp-claude \
    && adduser -S -D -H -h /nonexistent -u 61001 -G ctp-claude -s /sbin/nologin ctp-claude \
    && addgroup -S -g 61002 ctp-kimi \
    && adduser -S -D -H -h /nonexistent -u 61002 -G ctp-kimi -s /sbin/nologin ctp-kimi \
    && addgroup -S -g 61003 ctp-codex \
    && adduser -S -D -H -h /nonexistent -u 61003 -G ctp-codex -s /sbin/nologin ctp-codex

WORKDIR /config

RUN mkdir -p /opt/modbus /opt/solar /opt/home-assistant
COPY MODBUS.md /opt/modbus/MODBUS.md
COPY modbus/ /opt/modbus/
COPY SOLAR.md /opt/solar/SOLAR.md
COPY HA.md /opt/home-assistant/HA.md
COPY skills/ /opt/skills/
COPY config.yaml /opt/codex-terminal/config.yaml

# Copy and install image service.
COPY image-service/ /opt/image-service/
RUN cd /opt/image-service \
    && npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /root/.npm \
    && chmod +x server.js

# Run the real parser against the real procps-ng `ps`: the sign-in trust check
# in server.js compares these user names, so a parser that stops matching
# (or a truncated name such as `ctp-cla+`) must fail the build.
RUN su -s /bin/sh ctp-claude -c 'exec sleep 30' & \
    probe=$! \
    && for _ in 1 2 3 4 5 6 7 8 9 10; do \
        [ "$(ps -o user:32= -p "$probe" | tr -d ' ')" = ctp-claude ] && break; sleep 0.3; \
    done \
    && status=0 \
    && node -e ' \
        const { readProcessSnapshot } = require("/opt/image-service/process-snapshot.js"); \
        const fail = (reason) => { console.error("process-snapshot build check failed: " + reason); process.exit(1); }; \
        const probe = Number(process.argv[1]); \
        readProcessSnapshot((err, snapshot) => { \
            if (err) fail(err.message); \
            const own = (pid) => JSON.stringify([snapshot.userByPid.get(pid), snapshot.argsByPid.get(pid)]); \
            if (!(snapshot.children.get(process.ppid) || []).includes(process.pid)) fail("node " + process.pid + " is not listed under ppid " + process.ppid); \
            if (snapshot.userByPid.get(process.pid) !== "root" || !/node/.test(snapshot.argsByPid.get(process.pid) || "")) fail("this node process parsed as " + own(process.pid)); \
            if (snapshot.userByPid.get(probe) !== "ctp-claude" || !/sleep 30/.test(snapshot.argsByPid.get(probe) || "")) fail("ctp-claude process " + probe + " parsed as " + own(probe)); \
        });' "$probe" || status=$? ; \
    kill "$probe" 2>/dev/null; \
    exit "$status"

# Copy startup script and modular scripts.
COPY run.sh /run.sh
COPY scripts/ /opt/scripts/
RUN mkdir -p /usr/libexec/codex-terminal \
    && mv /usr/bin/ha /usr/libexec/codex-terminal/ha-real \
    && cp /opt/scripts/ha-guard.sh /usr/bin/ha \
    && chmod +x /usr/bin/ha /usr/libexec/codex-terminal/ha-real \
    && chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh \
    && chmod +x /opt/scripts/codex-disable-heygen-plugin \
    && chmod +x /opt/scripts/codex-disable-github-mcp \
    && chmod +x /opt/scripts/codex-disable-codex-security-mcp \
    && chmod +x /opt/scripts/codex-config-set \
    && chmod +x /opt/scripts/claude-config-set \
    && chmod +x /opt/scripts/consult \
    && chmod +x /opt/scripts/codex-config-tui \
    && chmod +x /opt/scripts/codex-terminal-config-files.py \
    && chmod +x /opt/scripts/persist-install \
    && chmod +x /opt/scripts/update-apk-manifest \
    && chmod +x /opt/scripts/codex-terminal-ssh-mailbox.py \
    && chmod +x /opt/scripts/codex-terminal-port-owner.py \
    && chmod +x /opt/scripts/codex-prune-plugins \
    && chmod +x /opt/scripts/codex-shell-dispatch \
    && chmod +x /opt/scripts/codex-terminal-briefing \
    && chmod +x /opt/scripts/ha-toolbox \
    && chmod +x /opt/scripts/ha-api \
    && chmod +x /opt/scripts/ha-ws \
    && chmod +x /opt/scripts/ha-mcp-status \
    && chmod +x /opt/scripts/ha-monitor \
    && chmod +x /opt/scripts/ha-site-memory \
    && chmod +x /opt/scripts/modbus-* \
    && chmod +x /opt/scripts/solar-* \
    && ln -sf /opt/scripts/consult /usr/local/bin/consult \
    && ln -sf /opt/scripts/codex-shell-dispatch /usr/local/bin/codex-shell-dispatch \
    && ln -sf /opt/scripts/codex-terminal-briefing /usr/local/bin/codex-terminal-briefing \
    && ln -sf /opt/scripts/ha-toolbox /usr/local/bin/ha-toolbox \
    && ln -sf /opt/scripts/ha-api /usr/local/bin/ha-api \
    && ln -sf /opt/scripts/ha-ws /usr/local/bin/ha-ws \
    && ln -sf /opt/scripts/ha-mcp-status /usr/local/bin/ha-mcp-status \
    && ln -sf /opt/scripts/ha-monitor /usr/local/bin/ha-monitor \
    && ln -sf /opt/scripts/ha-site-memory /usr/local/bin/ha-site-memory \
    && ln -sf /opt/scripts/modbus-read /usr/local/bin/modbus-read \
    && ln -sf /opt/scripts/modbus-scan /usr/local/bin/modbus-scan \
    && ln -sf /opt/scripts/modbus-toolbox /usr/local/bin/modbus-toolbox \
    && ln -sf /opt/scripts/solar-toolbox /usr/local/bin/solar-toolbox

# Use exec form for better signal handling.
CMD ["/run.sh"]
