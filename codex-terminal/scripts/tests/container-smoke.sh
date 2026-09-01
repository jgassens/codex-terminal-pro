#!/usr/bin/env bash

set -euo pipefail

image="${1:?usage: container-smoke.sh IMAGE}"
work_dir="$(mktemp -d)"
normal_name="ctp-normal-stop-$$"
failure_name="ctp-child-failure-$$"

cleanup() {
    docker rm -f "$normal_name" "$failure_name" >/dev/null 2>&1 || true
    if [ -d "$work_dir" ]; then
        docker run --rm \
            --entrypoint /bin/chown \
            --volume "$work_dir:/cleanup" \
            "$image" \
            -R "$(id -u):$(id -g)" /cleanup >/dev/null 2>&1 || true
    fi
    rm -rf "$work_dir"
}
trap cleanup EXIT

mkdir -p "$work_dir/config" "$work_dir/data"
cat > "$work_dir/data/options.json" <<'JSON'
{
  "auto_launch_codex": false,
  "terminal_transcript_enabled": false,
  "ha_monitor_enabled": false,
  "persistent_apk_packages": [],
  "persistent_pip_packages": []
}
JSON

start_container() {
    local name="$1"
    docker run --detach \
        --name "$name" \
        --volume "$work_dir/config:/config" \
        --volume "$work_dir/data:/data" \
        "$image" >/dev/null
}

wait_for_health() {
    local name="$1"
    local attempt
    for attempt in $(seq 1 120); do
        if docker exec "$name" curl -fsS http://127.0.0.1:7680/health >/dev/null 2>&1; then
            return 0
        fi
        if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then
            docker logs "$name" >&2 || true
            return 1
        fi
        sleep 0.25
    done
    docker logs "$name" >&2 || true
    return 1
}

smoke_mall_cop_jail() {
    local name="$1"
    docker exec "$name" sh -euc '
        run_name="run-container-smoke"
        host_work="/opt/mall-cop-jail/work/${run_name}"
        sandbox_work="/work/${run_name}"
        mkdir -p "${host_work}/home" "${host_work}/tmp" "${host_work}/codex-home"
        chown -R 65534:65534 "${host_work}"
        chmod 0700 "${host_work}" "${host_work}/home" "${host_work}/tmp" "${host_work}/codex-home"
        output="$(env -i \
            PATH=/bin \
            HOME="${sandbox_work}/home" \
            TMPDIR="${sandbox_work}/tmp" \
            CODEX_HOME="${sandbox_work}/codex-home" \
            TERM=dumb \
            NO_COLOR=1 \
            /opt/scripts/codex-terminal-mall-cop-jail.py \
                --cwd "${sandbox_work}" \
                /opt/mall-cop-jail \
                -- /bin/codex --version)"
        case "${output}" in
            "codex-cli 0.147.0"|"codex 0.147.0") ;;
            *) printf "unexpected jailed Codex version: %s\n" "${output}" >&2; exit 1 ;;
        esac

        set +e
        exec_output="$({ printf "Mall Cop container smoke.\n" | timeout 8 env -i \
            PATH=/bin \
            HOME="${sandbox_work}/home" \
            TMPDIR="${sandbox_work}/tmp" \
            CODEX_HOME="${sandbox_work}/codex-home" \
            OPENAI_API_KEY=invalid-container-smoke-key \
            TERM=dumb \
            NO_COLOR=1 \
            /opt/scripts/codex-terminal-mall-cop-jail.py \
                --cwd "${sandbox_work}" \
                /opt/mall-cop-jail \
                -- /bin/codex exec \
                    --ephemeral \
                    --ignore-user-config \
                    --ignore-rules \
                    --config "web_search=\"disabled\"" \
                    --config "mcp_servers={}" \
                    --config "openai_base_url=\"http://127.0.0.1:9\"" \
                    --disable shell_tool \
                    --disable unified_exec \
                    --sandbox read-only \
                    --cd "${sandbox_work}" \
                    --skip-git-repo-check \
                    -; } 2>&1)"
        exec_status=$?
        set -e
        [ "${exec_status}" -ne 126 ]
        printf "%s\n" "${exec_output}" | grep -q "OpenAI Codex v0.147.0"
        if printf "%s\n" "${exec_output}" | grep -Eq "Codex executable path is not configured|no /proc/self/exe available"; then
            printf "jailed Codex exec did not initialize correctly:\n%s\n" "${exec_output}" >&2
            exit 1
        fi
        [ ! -e /opt/mall-cop-jail/config ]
        [ ! -e /opt/mall-cop-jail/data ]
    '
}

smoke_human_terminal_broker() {
    local name="$1"
    docker exec "$name" bash -se <<'INNER'
set -euo pipefail

if ! response="$(codex-shell-dispatch /data/packages/guard/bin/supervisor-broker ha core restart 2>&1)"; then
    printf 'Codex shell dispatch failed:\n%s\n' "$response" >&2
    exit 1
fi
if grep -Eq 'Type exactly|Refusing non-interactive' <<< "$response"; then
    printf 'Codex shell dispatch received a duplicate broker prompt:\n%s\n' "$response" >&2
    exit 1
fi

[ -S /run/codex-terminal/shell-dispatch.sock ]
[ -S /run/codex-terminal/ttyd.sock ]
[ "$(stat -c '%a' /run/codex-terminal/shell-dispatch.sock)" = "600" ]
curl -fsS --unix-socket /run/codex-terminal/ttyd.sock http://localhost/ >/dev/null
if curl -fsS --max-time 1 http://127.0.0.1:7681/ >/dev/null 2>&1; then
    printf 'ttyd unexpectedly accepts TCP loopback connections\n' >&2
    exit 1
fi
python3 - <<'PY'
import os
import socket

os.setgroups([])
os.setgid(65534)
os.setuid(65534)
for path in (
    "/run/codex-terminal/shell-dispatch.sock",
    "/run/codex-terminal/ttyd.sock",
):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(path)
    except PermissionError:
        pass
    else:
        raise SystemExit(f"unprivileged user connected to {path}")
    finally:
        client.close()
PY

status_file="/tmp/human-broker-status"
stdout_file="/tmp/human-broker-stdout"
stderr_file="/tmp/human-broker-stderr"
rm -f "$status_file" "$stdout_file" "$stderr_file"
command='/data/packages/guard/bin/supervisor-broker ha core restart </dev/null >/tmp/human-broker-stdout 2>/tmp/human-broker-stderr; printf "%s\n" "$?" >/tmp/human-broker-status'
tmux send-keys -t codex-terminal:raw-shell.0 -l "$command"
tmux send-keys -t codex-terminal:raw-shell.0 Enter

for _ in $(seq 1 40); do
    [ -f "$status_file" ] && break
    sleep 0.1
done
[ -f "$status_file" ]
[ "$(cat "$status_file")" -eq 0 ]
if grep -Eq 'Type exactly|Refusing non-interactive' "$stderr_file"; then
    printf 'direct Shell command received a duplicate broker prompt:\n' >&2
    cat "$stderr_file" >&2
    exit 1
fi
[ "$(grep -c 'reason=human-terminal' /data/logs/supervisor-broker.log)" -ge 1 ]
[ "$(grep -c 'reason=codex-approval-policy' /data/logs/supervisor-broker.log)" -ge 1 ]
INNER
}

start_container "$normal_name"
wait_for_health "$normal_name"
smoke_agent_identities "$normal_name"
smoke_human_terminal_broker "$normal_name"
docker stop --time 10 "$normal_name" >/dev/null
normal_exit="$(docker inspect --format '{{.State.ExitCode}}' "$normal_name")"
[ "$normal_exit" -eq 0 ]
normal_logs="$(docker logs "$normal_name" 2>&1)"
if grep -Eq 'exited; stopping|supervisor woke' <<< "$normal_logs"; then
    echo "normal shutdown logged a false web-process failure" >&2
    exit 1
fi
docker rm "$normal_name" >/dev/null

start_container "$failure_name"
wait_for_health "$failure_name"
docker exec "$failure_name" sh -c 'pid="$(pidof node)"; [ -n "$pid" ]; kill -TERM ${pid%% *}'
for attempt in $(seq 1 80); do
    if [ "$(docker inspect --format '{{.State.Running}}' "$failure_name")" != "true" ]; then
        break
    fi
    sleep 0.25
done
if [ "$(docker inspect --format '{{.State.Running}}' "$failure_name")" = "true" ]; then
    echo "container did not stop after a required child exited" >&2
    docker logs "$failure_name" >&2 || true
    exit 1
fi
failure_exit="$(docker inspect --format '{{.State.ExitCode}}' "$failure_name")"
[ "$failure_exit" -ne 0 ]
failure_logs="$(docker logs "$failure_name" 2>&1)"
grep -q 'Image service exited; stopping ttyd' <<< "$failure_logs"

echo "container startup, human terminal broker routing, jailed Mall Cop, normal shutdown, and child-failure supervision: ok"
