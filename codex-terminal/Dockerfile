FROM ghcr.io/home-assistant/base:latest

LABEL \
    io.hass.version="1.44" \
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
RUN npm install -g @openai/codex \
    && npm cache clean --force

# Install read-only Modbus Python tooling into an isolated import path.
RUN python3 -m pip install --no-cache-dir --target /opt/modbus-python \
        'pymodbus[serial]==3.13.0' \
        'minimalmodbus==2.1.1' \
        'pyserial==3.5' \
    && PYTHONPATH=/opt/modbus-python python3 -c "import minimalmodbus, pymodbus, serial; print('Modbus Python tooling installed')"

ENV PYTHONPATH="/opt/modbus-python"

# Install Home Assistant CLI (ha command).
# Download appropriate binary based on build architecture.
ARG TARGETARCH
RUN case "${TARGETARCH:-amd64}" in \
        amd64)   HA_ARCH="amd64" ;; \
        arm64)   HA_ARCH="aarch64" ;; \
        *)       echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Fetching latest Home Assistant CLI version..." && \
    HA_VERSION=$(curl -fsSL https://api.github.com/repos/home-assistant/cli/releases/latest | jq -r '.tag_name') && \
    echo "Installing Home Assistant CLI ${HA_VERSION} for ${HA_ARCH}..." && \
    curl -fsSL -o /usr/bin/ha \
        "https://github.com/home-assistant/cli/releases/download/${HA_VERSION}/ha_${HA_ARCH}" && \
    chmod +x /usr/bin/ha && \
    echo "Home Assistant CLI ${HA_VERSION} installed successfully"

# Install GitHub CLI (gh command).
RUN case "${TARGETARCH:-amd64}" in \
        amd64)   GH_ARCH="amd64" ;; \
        arm64)   GH_ARCH="arm64" ;; \
        *)       echo "Unsupported architecture for gh: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Fetching latest GitHub CLI version..." && \
    GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//') && \
    echo "Installing GitHub CLI v${GH_VERSION} for ${GH_ARCH}..." && \
    curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/bin/gh && \
    chmod +x /usr/bin/gh && \
    rm -rf /tmp/gh* && \
    echo "GitHub CLI v${GH_VERSION} installed successfully"

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
    && npm cache clean --force \
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
    && chmod +x /opt/scripts/persist-install \
    && chmod +x /opt/scripts/codex-shell-dispatch \
    && chmod +x /opt/scripts/codex-terminal-briefing \
    && chmod +x /opt/scripts/ha-toolbox \
    && chmod +x /opt/scripts/modbus-* \
    && chmod +x /opt/scripts/solar-* \
    && ln -sf /opt/scripts/codex-shell-dispatch /usr/local/bin/codex-shell-dispatch \
    && ln -sf /opt/scripts/codex-terminal-briefing /usr/local/bin/codex-terminal-briefing \
    && ln -sf /opt/scripts/ha-toolbox /usr/local/bin/ha-toolbox \
    && ln -sf /opt/scripts/modbus-read /usr/local/bin/modbus-read \
    && ln -sf /opt/scripts/modbus-scan /usr/local/bin/modbus-scan \
    && ln -sf /opt/scripts/modbus-toolbox /usr/local/bin/modbus-toolbox \
    && ln -sf /opt/scripts/solar-toolbox /usr/local/bin/solar-toolbox

# Use exec form for better signal handling.
CMD ["/run.sh"]
