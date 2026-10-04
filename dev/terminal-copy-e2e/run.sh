#!/bin/bash
# Real-browser regression test for terminal highlight-to-copy: the add-on's
# own tmux config, a real ttyd, the real image service, and Chromium driven
# by Playwright. It drags across known text and checks the clipboard, and
# that tmux never takes the drag (the path that copied a blank line in
# Safari).
#
#   TTYD_BIN=/path/to/ttyd bash dev/terminal-copy-e2e/run.sh
#
# Requires: tmux, node, a ttyd binary, and `playwright` resolvable from this
# directory (npm install --no-save playwright). CHROME may name a Chromium
# executable; otherwise Playwright's own is used.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SERVICE="$REPO/codex-terminal/image-service"
TTYD_BIN="${TTYD_BIN:-ttyd}"
WORK="$(mktemp -d)"
SOCKET_DIR="$(mktemp -d /tmp/ctp-e2e.XXXXXX)"
chmod 700 "$SOCKET_DIR"
SESSION=codex-terminal
SERVICE_PID=""
TTYD_PID=""

cleanup() {
    [ -n "$SERVICE_PID" ] && kill "$SERVICE_PID" 2>/dev/null || true
    [ -n "$TTYD_PID" ] && kill "$TTYD_PID" 2>/dev/null || true
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -rf "$WORK" "$SOCKET_DIR"
}
trap cleanup EXIT

# Use the exact tmux config run.sh writes, so the test follows it.
awk '/cat > "\$\{tmux_config\}" << TMUX_EOF/{on=1; next} /^TMUX_EOF/{on=0} on' \
    "$REPO/codex-terminal/run.sh" | sed 's/\${history_limit}/10000/' > "$WORK/tmux.conf"
grep -q 'set -g mouse on' "$WORK/tmux.conf"

tmux -f "$WORK/tmux.conf" new-session -d -s "$SESSION" -x 120 -y 30 bash
"$TTYD_BIN" --port 7681 --interface 127.0.0.1 --writable \
    --client-option macOptionClickForcesSelection=true \
    --client-option rightClickSelectsWord=true \
    tmux -f "$WORK/tmux.conf" attach-session -t "$SESSION" > "$WORK/ttyd.log" 2>&1 &
TTYD_PID=$!

mkdir -p "$WORK"/{uploads,config,monitor,reports}
IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT=true \
IMAGE_SERVICE_BIND_ADDRESS=127.0.0.1 \
IMAGE_SERVICE_PORT=7680 \
TTYD_PORT=7681 \
UPLOAD_DIR="$WORK/uploads" \
HA_CONFIG_DIR="$WORK/config" \
HA_MONITOR_STATE_FILE="$WORK/monitor/state.json" \
HA_MONITOR_HISTORY_FILE="$WORK/monitor/history.jsonl" \
CHANGE_DESK_DISPATCH_FILE="$WORK/monitor/dispatch.json" \
CHANGE_DESK_REPORT_DIR="$WORK/reports" \
CHANGE_DESK_MALL_COP_MEMORY_FILE="$WORK/monitor/mall-cop.json" \
SETTINGS_FILE="$WORK/settings.json" \
SHELL_DISPATCH_SOCKET_PATH="$SOCKET_DIR/shell-dispatch.sock" \
    node "$SERVICE/server.js" > "$WORK/service.log" 2>&1 &
SERVICE_PID=$!

for _ in $(seq 1 50); do
    curl -fsS -o /dev/null http://127.0.0.1:7680/ 2>/dev/null && break
    sleep 0.2
done

if ! TMUX_SESSION="$SESSION" node "$HERE/copy.e2e.js"; then
    echo "--- service.log"; tail -n 40 "$WORK/service.log" || true
    echo "--- ttyd.log"; tail -n 20 "$WORK/ttyd.log" || true
    exit 1
fi
