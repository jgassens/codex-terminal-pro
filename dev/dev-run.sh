#!/bin/bash
# Local dev harness for the Codex Terminal Pro frontend (macOS, no docker):
# runs the real image-service against a real tmux session, a fake ttyd page,
# and consult fixtures, so the web UI can be exercised end to end.
#
#   bash dev/dev-run.sh          # serves http://localhost:7680
#
# Requires: node, tmux (brew install tmux), python3.11+ for consult
# (a Homebrew python3 is used via the consult-dev wrapper this script writes).
set -euo pipefail

DEV_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DEV_DIR/.." && pwd)/codex-terminal"
STATE="$DEV_DIR/.state"
TMUX_BIN="$(command -v tmux || echo /opt/homebrew/bin/tmux)"
PY3="$(command -v /opt/homebrew/bin/python3 || command -v python3)"

mkdir -p "$STATE"/{uploads,reports,monitor,config,codex-home,claude-home,kimi-home/credentials,bin,runtime}
chmod 700 "$STATE/runtime"
SHELL_DISPATCH_SOCKET_PATH="$STATE/runtime/shell-dispatch.sock"
if [ -S "$SHELL_DISPATCH_SOCKET_PATH" ]; then
    rm -f "$SHELL_DISPATCH_SOCKET_PATH"
elif [ -e "$SHELL_DISPATCH_SOCKET_PATH" ] || [ -L "$SHELL_DISPATCH_SOCKET_PATH" ]; then
    printf 'Refusing unsafe development socket path: %s\n' "$SHELL_DISPATCH_SOCKET_PATH" >&2
    exit 1
fi

# --- fixtures: a signed-in Claude and a Kimi with two models ---------------
[ -f "$STATE/claude-home/.credentials.json" ] || \
    printf '{"claudeAiOauth":{"accessToken":"fake-dev-access-token-0000000000000000","refreshToken":"fake-dev-refresh-token-000000000000000"}}\n' > "$STATE/claude-home/.credentials.json"
[ -f "$STATE/claude-home/.claude.json" ] || printf '{}\n' > "$STATE/claude-home/.claude.json"
[ -f "$STATE/kimi-home/credentials/account-1.json" ] || \
    printf '{"access_token":"fake-dev-access-token-0000000000000000","refresh_token":"fake-dev-refresh-token-000000000000000","token_type":"Bearer"}\n' > "$STATE/kimi-home/credentials/account-1.json"
[ -f "$STATE/kimi-home/device_id" ] || printf 'dev-device\n' > "$STATE/kimi-home/device_id"
if [ ! -f "$STATE/kimi-home/config.toml" ]; then
    cat > "$STATE/kimi-home/config.toml" <<'EOF'
default_model = "kimi-code/k3"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 1048576
capabilities = ["thinking", "tool_use"]
display_name = "K3"
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."kimi-code/k2"]
provider = "managed:kimi-code"
model = "k2"
max_context_size = 262144
capabilities = ["tool_use"]
display_name = "K2"
support_efforts = ["low", "high"]
default_effort = "low"
EOF
fi
[ -f "$STATE/settings.json" ] || cat > "$STATE/settings.json" <<'EOF'
{
  "defaultConsultant": "claude",
  "consultTimeoutSeconds": 300,
  "consultants": {
    "kimi": {"model": "kimi-code/k3", "effort": "max"}
  }
}
EOF

# Fake kimi binary so consult treats Kimi as installed.
printf '#!/bin/sh\necho "fake kimi: $*"\n' > "$STATE/bin/kimi"
chmod +x "$STATE/bin/kimi"
# Fake codex: honours `-o FILE` the way `codex exec` does, so the answer-file
# path and Mall Cop narration can be exercised end to end without a login.
cat > "$STATE/bin/codex" <<'FAKE_CODEX'
#!/bin/sh
out=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out="$2"; shift 2 ;;
        *) shift ;;
    esac
done
echo "fake codex progress line on stdout"
if [ -n "$out" ]; then
    printf '## Bottom line\nFake Codex narration: the observation looks stable.\n\n## Acute state\nNothing acute.\n' > "$out"
fi
FAKE_CODEX
chmod +x "$STATE/bin/codex"
[ -f "$STATE/codex-home/auth.json" ] || \
    printf '{"tokens":{"access_token":"fake-dev-access-token-0000000000000000","refresh_token":"fake-dev-refresh-token-000000000000000"}}\n' > "$STATE/codex-home/auth.json"
# consult's shebang is /usr/bin/python3, which on macOS may predate tomllib
# (needs 3.11+); run it through a modern interpreter instead.
printf '#!/bin/bash\nexec "%s" "%s/scripts/consult" "$@"\n' "$PY3" "$REPO" > "$STATE/bin/consult-dev"
chmod +x "$STATE/bin/consult-dev"

# --- fake ttyd -------------------------------------------------------------
if [ ! -d "$DEV_DIR/fake-ttyd/node_modules" ]; then
    (cd "$DEV_DIR/fake-ttyd" && npm install --no-audit --no-fund)
fi

# A real tmux session so the sign-in / cancel / setup endpoints run for real.
"$TMUX_BIN" has-session -t codex-terminal 2>/dev/null || \
    "$TMUX_BIN" new-session -d -s codex-terminal -x 200 -y 50 -c "$STATE/config" /bin/bash

cleanup() {
    [ -n "${TTYD_PID:-}" ] && kill "$TTYD_PID" 2>/dev/null || true
    [ -S "$SHELL_DISPATCH_SOCKET_PATH" ] && rm -f "$SHELL_DISPATCH_SOCKET_PATH" || true
}
trap cleanup EXIT

FAKE_TTYD_PORT=7681 node "$DEV_DIR/fake-ttyd/server.js" &
TTYD_PID=$!

export IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT=true
export IMAGE_SERVICE_BIND_ADDRESS=127.0.0.1
export IMAGE_SERVICE_PORT=7680
export TTYD_PORT=7681
export UPLOAD_DIR="$STATE/uploads"
export HA_CONFIG_DIR="$STATE/config"
export HA_MONITOR_STATE_FILE="$STATE/monitor/ha-monitor.json"
export HA_MONITOR_HISTORY_FILE="$STATE/monitor/ha-monitor-history.jsonl"
export CHANGE_DESK_DISPATCH_FILE="$STATE/monitor/change-desk-dispatch.json"
export CHANGE_DESK_REPORT_DIR="$STATE/reports"
export CHANGE_DESK_MALL_COP_MEMORY_FILE="$STATE/monitor/mall-cop-memory.json"
export SETTINGS_FILE="$STATE/settings.json"
export CONSULT_BIN="$STATE/bin/consult-dev"
export CODEX_HOME="$STATE/codex-home"
export CONSULT_SETTINGS_FILE="$STATE/settings.json"
export CLAUDE_CONFIG_DIR="$STATE/claude-home"
export KIMI_CODE_HOME="$STATE/kimi-home"
export SHELL_DISPATCH_SOCKET_PATH
export PATH="$STATE/bin:/opt/homebrew/bin:$PATH"

node "$REPO/image-service/server.js"
