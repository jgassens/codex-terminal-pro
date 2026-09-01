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

smoke_agent_identities() {
    local name="$1"
    docker exec "$name" sh -euc '
        [ "$(id -u ctp-claude)" = 61001 ]
        [ "$(id -g ctp-claude)" = 61001 ]
        [ "$(id -u ctp-kimi)" = 61002 ]
        [ "$(id -g ctp-kimi)" = 61002 ]
        [ "$(getent passwd ctp-claude | cut -d: -f7)" = /sbin/nologin ]
        [ "$(getent passwd ctp-kimi | cut -d: -f7)" = /sbin/nologin ]
        [ "$(id -u ctp-codex)" = 61003 ]
        [ "$(id -g ctp-codex)" = 61003 ]
        [ "$(getent passwd ctp-codex | cut -d: -f7)" = /sbin/nologin ]

        python3 - <<PY
import os
import runpy
import stat

consult = runpy.run_path("/opt/scripts/consult")
base = consult["ensure_sandbox_base"]()
info = base.lstat()
assert (info.st_uid, info.st_gid) == (0, 0)
assert stat.S_IMODE(info.st_mode) == 0o711

abi = consult["_landlock_syscall"](
    consult["LANDLOCK_CREATE_RULESET"], None, 0,
    consult["LANDLOCK_CREATE_RULESET_VERSION"],
)
assert abi >= 1
PY

        identity_root=/tmp/ctp-agent-identity-smoke
        rm -rf "${identity_root}"
        install -d -m 0700 -o 61001 -g 61001 "${identity_root}/claude"
        install -d -m 0700 -o 61002 -g 61002 "${identity_root}/kimi"
        printf claude > "${identity_root}/claude/auth"
        printf kimi > "${identity_root}/kimi/auth"
        chown 61001:61001 "${identity_root}/claude/auth"
        chown 61002:61002 "${identity_root}/kimi/auth"
        chmod 0600 "${identity_root}"/*/auth

        ! su ctp-claude -s /bin/sh -c "cat ${identity_root}/kimi/auth" >/dev/null 2>&1
        ! su ctp-kimi -s /bin/sh -c "cat ${identity_root}/claude/auth" >/dev/null 2>&1
        rm -rf "${identity_root}"

        # Prove the actual consultant process can read its filtered projection
        # but not the live config, manager token, or a write target.
        printf "safe: visible\n" > /config/consult-safe.yaml
        printf "password: do-not-expose\n" > /config/secrets.yaml
        install -d -m 0700 /data/.supervisor
        printf "smoke-manager-token\n" > /data/.supervisor/token
        chmod 0600 /data/.supervisor/token
        printf "world-readable-live-data\n" > /data/consult-public-probe
        chmod 0644 /data/consult-public-probe
        install -d -m 0700 /data/.claude
        # consult reads the token rather than just stat-ing the file, so the
        # stand-in credential has to carry one to count as a signed-in account.
        printf "{\"claudeAiOauth\":{\"accessToken\":\"smoke-access-token-0000000000000000\",\"refreshToken\":\"smoke-refresh-token-000000000000000\"}}\n" > /data/.claude/.credentials.json
        chmod 0600 /data/.claude/.credentials.json
        mv /usr/local/bin/claude /usr/local/bin/claude.real
        cat > /usr/local/bin/claude <<FAKE_CLAUDE
#!/bin/sh
set -eu
[ "\$(cat consult-safe.yaml)" = "safe: visible" ]
! cat /config/secrets.yaml >/dev/null 2>&1
! cat /data/.supervisor/token >/dev/null 2>&1
! cat /data/consult-public-probe >/dev/null 2>&1
! printf "changed\n" >> consult-safe.yaml 2>/dev/null
printf "consult-isolation-ok\n"
FAKE_CLAUDE
        chmod 0755 /usr/local/bin/claude
        consult_output="$(consult --agent claude "verify isolation")"
        [ "${consult_output}" = "consult-isolation-ok" ]
        rm -f /usr/local/bin/claude
        mv /usr/local/bin/claude.real /usr/local/bin/claude

        # Codex consults through the same path, as its own identity, and hands
        # its answer back through the -o file rather than stdout. The stand-in
        # proves the file is what gets printed, that it ran as ctp-codex, and
        # that the live auth.json never changes.
        install -d -m 0700 /data/.codex
        printf "{\"tokens\":{\"access_token\":\"smoke-access-token-0000000000000000\",\"refresh_token\":\"smoke-refresh-token-000000000000000\"}}\n" > /data/.codex/auth.json
        chmod 0600 /data/.codex/auth.json
        auth_before="$(md5sum /data/.codex/auth.json)"
        mv /usr/local/bin/codex /usr/local/bin/codex.real
        cat > /usr/local/bin/codex <<FAKE_CODEX
#!/bin/sh
set -eu
[ "\$(id -u)" = 61003 ]
out=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) out="\$2"; shift 2 ;;
        *) shift ;;
    esac
done
! cat /config/secrets.yaml >/dev/null 2>&1
printf "planted\n" > "\$CODEX_HOME/auth.json"
printf "progress noise on stdout\n"
printf "codex-answer-file-ok\n" > "\$out"
FAKE_CODEX
        chmod 0755 /usr/local/bin/codex
        codex_output="$(consult --agent codex "verify the answer file")"
        [ "${codex_output}" = "codex-answer-file-ok" ]
        [ "$(md5sum /data/.codex/auth.json)" = "${auth_before}" ]
        rm -f /usr/local/bin/codex
        mv /usr/local/bin/codex.real /usr/local/bin/codex
        rm -f /config/consult-safe.yaml /config/secrets.yaml \
            /data/.supervisor/token /data/consult-public-probe \
            /data/.claude/.credentials.json /data/.codex/auth.json

        python3 -m http.server 1455 --bind 127.0.0.1 >/dev/null 2>&1 &
        listener_pid=$!
        sleep 30 &
        unrelated_pid=$!
        owner_ready=false
        for attempt in $(seq 1 40); do
            if /opt/scripts/codex-terminal-port-owner.py "${listener_pid}" 1455; then
                owner_ready=true
                break
            fi
            sleep 0.05
        done
        [ "${owner_ready}" = true ]
        ! /opt/scripts/codex-terminal-port-owner.py "${unrelated_pid}" 1455
        kill "${listener_pid}" "${unrelated_pid}"
        wait "${listener_pid}" "${unrelated_pid}" 2>/dev/null || true
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

echo "container startup, consultant Landlock isolation, human terminal broker routing, normal shutdown, and child-failure supervision: ok"
