FROM ghcr.io/home-assistant/base:3.22-2026.04.0@sha256:eed9b5eff1441d4db22d5036b7802610e7fc94af8c0448439ae6dda9942d5230

LABEL \
    io.hass.version="2.6.8" \
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
    ttyd

# Install Codex CLI.
ARG CODEX_CLI_VERSION=0.147.0
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && codex --version \
    && CODEX_NATIVE="$(find /usr/local/lib/node_modules/@openai/codex -path '*/vendor/*/bin/codex' -type f -perm -0100 | head -n 1)" \
    && test -n "${CODEX_NATIVE}" \
    && install -d -m 0755 /opt/mall-cop-jail/bin /opt/mall-cop-jail/etc/ssl /opt/mall-cop-jail/proc/self /opt/mall-cop-jail/work \
    && ln "${CODEX_NATIVE}" /opt/mall-cop-jail/bin/codex \
    && ln -s /bin/codex /opt/mall-cop-jail/proc/self/exe \
    && cp -a /etc/ssl/. /opt/mall-cop-jail/etc/ssl/ \
    && cp /etc/resolv.conf /opt/mall-cop-jail/etc/resolv.conf \
    && cp /etc/hosts /opt/mall-cop-jail/etc/hosts \
    && chmod 0755 /opt/mall-cop-jail /opt/mall-cop-jail/bin /opt/mall-cop-jail/work \
    && chmod 0555 /opt/mall-cop-jail/bin/codex \
    && chmod -R go-w /opt/mall-cop-jail/etc \
    && rm -rf /root/.npm

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
ARG HA_CLI_VERSION=5.2.0
ARG HA_CLI_SHA256_AMD64=701be67aee9f1e092254097a40d006b450d1578641a262258b182237987e7479
ARG HA_CLI_SHA256_ARM64=af8c03ccddb65d223d7b7dab1570197b8a2ff8fc7139c1db054d08a91a4f8073
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
ARG GH_CLI_VERSION=2.96.0
ARG GH_CLI_SHA256_AMD64=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60
ARG GH_CLI_SHA256_ARM64=06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909
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

WORKDIR /config

RUN mkdir -p /opt/modbus /opt/solar /opt/home-assistant
COPY MODBUS.md /opt/modbus/MODBUS.md
COPY modbus/ /opt/modbus/
COPY SOLAR.md /opt/solar/SOLAR.md
COPY HA.md /opt/home-assistant/HA.md

# Copy and install image service.
COPY image-service/ /opt/image-service/
RUN cd /opt/image-service \
    && npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /root/.npm \
    && chmod +x server.js

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
    && chmod +x /opt/scripts/codex-config-tui \
    && chmod +x /opt/scripts/codex-terminal-config-files.py \
    && chmod +x /opt/scripts/persist-install \
    && chmod +x /opt/scripts/update-apk-manifest \
    && chmod +x /opt/scripts/codex-terminal-ssh-mailbox.py \
    && chmod +x /opt/scripts/codex-terminal-mall-cop-jail.py \
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
