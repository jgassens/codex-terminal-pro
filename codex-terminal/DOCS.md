# Codex Terminal Pro

Codex Terminal Pro is an unofficial OpenAI Codex CLI add-on for Home Assistant.
It opens a web terminal in `/config` and keeps persistent runtime state in
`/data`.

The add-on registers an admin-only sidebar panel titled **Codex Terminal Pro**.
It remains admin-only because the terminal can edit Home Assistant
configuration and call manager-level Home Assistant actions.

Interactive terminal state is kept in a named `tmux` session. Browser refreshes,
tab switches, and ingress reconnects should reattach to the same session.

Mouse wheel scrolling uses tmux scrollback. Keyboard fallback: press `Ctrl-b [`
to enter copy mode, use arrows/PageUp/PageDown, then press `q` to return.
Terminal output is mirrored to `/data/logs/codex-terminal.log` for warnings
that scroll away. Treat this log as sensitive terminal output. Redaction of
common token patterns is best-effort and is not a substitute for avoiding
secrets in terminal output.

Selecting text inside the embedded terminal copies it to the browser clipboard
when the selection finishes. tmux mouse selections are forwarded to the browser
clipboard through OSC 52 support.

On iOS and other restricted mobile browsers, clipboard APIs may require HTTPS.
Use the Nabu Casa/HTTPS URL for best results. Over plain HTTP LAN access, the
visible selection handles and manual paste/copy panels are the reliable
fallback.

Dropped or pasted images are uploaded to `/data/images`, and the saved path is
inserted directly into the Codex prompt through the persistent tmux session.

The toolbar **Paste** button reads text or images from the browser clipboard
when allowed. If the browser blocks clipboard reads, it opens a manual paste box
so text can still be inserted into the terminal. Touch devices also show a
native command bar below the terminal. Type or paste into that browser text
field, then tap **Send**; the ttyd iframe stays as the live terminal display.
The shortcut strip sends Ctrl-C, Ctrl-D, Ctrl-Z, Tab, Enter, command history,
clear, tmux page up/down, and return-to-prompt controls.

Use **Shell** mode for raw terminal commands. It switches the active tmux window
to a real interactive `/config` login shell while keeping ttyd as the display.
Use **Codex** mode to return to the Codex TUI. From Codex mode, prefix a line
with `,,` to send the rest directly to the Shell pane, for example
`,, ha store reload` or `,,ha store reload`. Completed commands stay in Codex
mode and return their output in the Codex view. Long-running commands switch to
Shell mode so they can be controlled interactively.

If Codex sees a `,,` prompt because browser interception missed it, the add-on
also ships `codex-shell-dispatch`. Codex should strip the `,,` prefix and run
the remaining command through that helper, not through normal Codex shell
execution.

The add-on includes read-only Home Assistant REST/WebSocket helpers, the bounded
`ha-monitor` observer, the `ha-site-memory` house dictionary, plus read-only
Modbus helpers for Home Assistant troubleshooting and Schneider Electric
discovery work. Run `ha-api`, `ha-ws`, `ha-mcp-status`, `ha-monitor status`,
`ha-site-memory status`, or `modbus-toolbox` in the terminal for examples.

The toolbar **Change Desk** button opens a read-only review panel for the
current `/config` workspace. It summarizes `ha-toolbox` YAML audit results,
`ha core check`, recent `ha core logs` issues, persistent `ha-monitor`
findings, the prepared dispatch delta packet, live `ha-api config` reachability,
and `ha-mcp-status`. It can copy the summary or insert a Codex review prompt,
but it does not reload, restart, apply changes, or call a model by itself.

For domestic and small commercial solar work, run `solar-toolbox`. It can print
a site-intake brief, inspect Home Assistant config/entity registry for
solar-like surfaces, perform read-only TCP discovery for likely gateways, and
produce a pre-change restore checklist. See `/opt/solar/SOLAR.md`.

## Install

1. Go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open **Repositories** from the three-dot menu.
3. Add:

   ```text
   https://github.com/jgassens/codex-terminal-pro
   ```

4. Install **Codex Terminal Pro**.
5. Start the add-on and open the web UI.

## Updates

To receive updates from GitHub, install Codex Terminal Pro from the custom
repository URL above. A local `/addons` copy is not GitHub-managed.

When publishing an update, bump `version` in `config.yaml`, push to GitHub, and
reload the Home Assistant add-on store. Home Assistant uses that version value
to offer updates.

## Home Assistant SSH Access

Codex Terminal Pro does not run its own SSH server. If you already SSH into
Home Assistant and that shell can see `/config`, the add-on writes a helper
there:

```bash
/config/codex-terminal-pro-attach
```

With Docker access, the default command can attach to the live `codex-terminal`
tmux session inside the running add-on container. Without Docker access, the
ordinary Home Assistant SSH add-on still supports these mailbox-backed commands:

```bash
/config/codex-terminal-pro-attach status
/config/codex-terminal-pro-attach send "say hello"
/config/codex-terminal-pro-attach capture 120
/config/codex-terminal-pro-attach transcript 120
/config/codex-terminal-pro-attach ask-file /config/codex-ssh-reply.txt "write a one-line status"
/config/codex-terminal-pro-attach logs
```

`capture` prints recent visible tmux pane output, while `transcript` prints the
tail of the add-on's internal `/data/logs/codex-terminal.log` through the Codex
Terminal Pro bridge. For reliable SSH-side request/response checks, use
`ask-file`; it sends Codex a file-backed request and tells you which `/config`
file to `cat`.

Interactive `attach`, direct `shell`, and `container` discovery still need
Docker or a Home Assistant OS host shell because they require another
container's TTY:

```bash
/config/codex-terminal-pro-attach
/config/codex-terminal-pro-attach shell
/config/codex-terminal-pro-attach container
```

From the raw HA OS host shell, run the same helper from the Home Assistant
config directory path, commonly
`/mnt/data/supervisor/homeassistant/codex-terminal-pro-attach`.

## First Login

Run:

```bash
codex-auth-helper
```

Use device-code login first:

```bash
codex login --device-auth
```

If that is not available for your account or workspace, authenticate on a
trusted machine and copy `~/.codex/auth.json` into:

```text
/data/.codex/auth.json
```

Then run `codex-auth-helper` again and fix permissions. The file must be mode
`600`. Do not print or share it.

Avoid plain browser login inside the add-on. A callback URL like
`http://localhost:1455/auth/callback?...` points at the browser machine, not the
Home Assistant container, so the OAuth completion usually cannot reach Codex.

ChatGPT subscriptions are used through Codex account auth. API-key auth would
use OpenAI API billing and is deferred until the add-on has a safe
secret-handling path.

## Session Menu

When auto-launch is disabled, or after Codex exits, the menu provides:

1. Start Codex in `/config`
2. Open regular shell in `/config`
3. Codex auth: check/login/import
4. Run Home Assistant config check, if available
5. Reload Home Assistant YAML, if available
6. Restart Home Assistant, only after confirmation
7. Exit

## Persistent State

- Codex home: `/data/.codex`
- Codex auth: `/data/.codex/auth.json`
- Codex config: `/data/.codex/config.toml`
- Shell home: `/data/home`
- GitHub CLI config: `/data/.config/gh`
- Uploaded images: `/data/images`
- Persistent packages: `/data/packages`
- Host SSH attach helper: `/config/codex-terminal-pro-attach`

Modbus helper docs are installed at `/opt/modbus/MODBUS.md`. Site-specific
register notes can live under `/config/modbus/` if you want them backed up with
Home Assistant configuration.

The add-on forces file credential storage with:

```toml
cli_auth_credentials_store = "file"
```

It also disables Codex CLI's own startup update prompt:

```toml
check_for_update_on_startup = false
```

Use Home Assistant add-on updates to pick up new bundled Codex CLI versions.
This release pins the bundled CLI package to `@openai/codex@0.134.0` during
the Docker build.

Managed Codex Terminal Pro TUI defaults use this footer:

```toml
[tui]
status_line = ["run-state", "model-with-reasoning", "fast-mode", "context-remaining", "five-hour-limit", "weekly-limit"]
```

When a status line is already present, the add-on preserves it. Startup only
removes unsupported `[tui].status_line` item IDs that Codex CLI `0.134.0`
warns about. `auto-review`, `permissions`, and `approval-mode` are valid Codex
permission concepts, but this pinned CLI does not accept those strings as
footer item IDs.

Startup removes the persisted HeyGen Codex plugin cache when it is present at
`/data/.codex/plugins/cache/openai-curated-remote/heygen`. HeyGen is not part
of the Home Assistant add-on workflow, and removing the stale cache prevents
repeated Codex skill-loader warnings about oversized HeyGen skill descriptions.
This cleanup does not read or modify `/data/.codex/auth.json`.

## Configuration

```yaml
auto_launch_codex: true
terminal_transcript_enabled: true
terminal_transcript_max_bytes: 1048576
terminal_transcript_backups: 2
terminal_history_limit: 50000
image_retention_days: 30
image_retention_max_bytes: 268435456
ha_monitor_enabled: true
ha_monitor_interval_seconds: 300
ha_monitor_log_lines: 500
ha_monitor_state_scan_enabled: true
ha_monitor_mcp_status_enabled: true
ha_monitor_max_issues: 20
ha_monitor_summary_interval_seconds: 3600
ha_monitor_reasoning_cooldown_seconds: 3600
ha_monitor_reasoning_daily_budget: 8
ha_monitor_dispatch_max_chars: 12000
supervisor_broker_enabled: true
supervisor_broker_t1_ttl_seconds: 120
supervisor_broker_comma_dispatch_enabled: true
persistent_apk_packages: []
persistent_pip_packages: []
```

Terminal transcript logging stays enabled by default for debugging, but the log
rotates under `/data/logs`. Uploaded images stay in `/data/images` long enough
for normal Codex workflows and are cleaned up by age and total size.

`terminal_history_limit` controls tmux scrollback lines. The default is lower
than older releases to reduce memory and redraw pressure while keeping practical
scrollback.

`ha-monitor` is enabled by default as a safe observer. It scans recent
`ha core logs`, collects bounded unavailable/unknown state samples through
`ha-api`, checks MCP status, writes `/data/monitor/ha-monitor.json`, writes a
compact `/data/monitor/change-desk-dispatch.json` delta packet, and appends a
small JSONL history. Dispatch packets record new/resolved/persistent issues,
config fingerprints, deterministic triage posture, and reasoning budget gates.
Modbus, Wi-Fi, socket, timeout, and unavailable-entity noise is treated as
localized connectivity trouble unless it matches safety/security/critical
wording; configuration, auth, and system-health patterns stay review findings.
The monitor does not call services, reload, restart, edit `/config`, execute
arbitrary user task files, or call an LLM. Change Desk can run the explicit
**Ask Mall Cop** action, which sends a chronic-condition packet to `codex exec`
in read-only mode and renders **Mall Cop: To Observe and Report** back in the
panel. `/data/monitor/tasks.d` is reserved for a future explicit task-manifest
design and is ignored by this release.

## Safe Home Assistant Workflow

1. Ask Codex to inspect configuration first.
2. Ask Codex to show diffs before edits.
3. Run `ha core check`.
4. Reload YAML only if the check passes.
5. Restart Home Assistant only after explicit confirmation.

## Codex Environment Briefing

The add-on installs `codex-terminal-briefing` and writes its output to
`/config/CODEX_TERMINAL_PRO.md` on startup. This is the durable briefing for
Codex Terminal Pro's wrapper behavior, tools, paths, and safety boundaries.

Ask Codex to run this when it seems unaware of the add-on environment:

```bash
codex-terminal-briefing
```

The briefing covers `,,` shell dispatch, `codex-shell-dispatch`, `ha`,
`supervisor-api`, `ha-toolbox`, `ha-api`, `ha-ws`, `ha-mcp-status`,
`ha-monitor`, `ha-site-memory`, Shell mode, mobile command input,
the Home Assistant SSH attach helper, `solar-toolbox`, `modbus-toolbox`,
`modbus-scan`, `modbus-read`, and the sensitive files it should avoid.

## Home Assistant Toolbox And Live API Helpers

`ha-toolbox` is the local Home Assistant orientation helper. It is read-only and
is meant to give Codex a reliable first move before broad Home Assistant work.

```bash
ha-toolbox
ha-toolbox audit-config --config /config
ha-toolbox states --pattern battery
ha-toolbox states --domain automation
ha-toolbox services --domain homeassistant
ha-toolbox tools
```

Use `ha-api` for exact read-only REST lookups:

```bash
ha-api config
ha-api state sensor.outdoor_temperature
ha-api services --domain automation
ha-api events
ha-api mcp-status
```

Use `ha-ws` for richer read-only WebSocket discovery and validation:

```bash
ha-ws ping
ha-ws entity-registry --pattern kitchen
ha-ws target-info --entity light.kitchen --capabilities
ha-ws exposed
ha-ws validate --file /config/action-snippet.yaml --section action
ha-site-memory status
```

`ha-mcp-status` checks whether Home Assistant's official Model Context Protocol
Server integration is loaded and reminds Codex that `/api/mcp` access is
controlled by exposed entities. These helpers intentionally omit service-call
and entity-exposure write commands; use brokered `ha` or human Shell dispatch
for control actions.

`ha-site-memory` writes `/data/monitor/ha-site-memory.md` from local Home
Assistant registries and live states. It is refreshed during add-on startup when
Home Assistant is reachable and included in `codex-terminal-briefing` so fresh
Codex sessions can resolve house-specific phrases such as "Ring lights" before
starting broad triage. Optional human notes from `/config/HA_SITE_NOTES.md` are
included when present. It is read-only and should be treated as a map; verify
live state with `ha-api` or `ha-ws` before changing anything.

The bundled field guide at `/opt/home-assistant/HA.md` covers configuration
layout, automations, scripts, scenes, helpers, templates, dashboards, entity and
device registries, integrations, add-ons, Supervisor, backups, recorder and
statistics, MQTT, Zigbee/ZHA, Z-Wave JS, Matter, ESPHome, mobile app, HomeKit,
Energy, and safe reload choices.

Common support tools include `sqlite3`, `mosquitto_sub`, `mosquitto_pub`, `dig`,
`nslookup`, `ping`, `ncat`, `socat`, `tcpdump`, `openssl`, `ssh`, and `rsync`.

## Supervisor Broker Guardrail

The add-on keeps `hassio_role: manager` so legitimate Home Assistant management
workflows continue to function, but it routes the default `ha` command through a
confirmation broker.

- Read-only commands such as `ha core check`, info, list, logs, and stats are
  allowed automatically.
- Routine management commands such as restart, reload, start, stop, update,
  rebuild, and options require a typed confirmation.
- High-risk host, OS, backup, install, uninstall, and delete operations require
  a fresh nonce and a reason.
- Non-interactive risky operations are refused.
- Direct Supervisor calls should use `supervisor-api`, which applies the same
  broker policy.
- Commands typed in the Shell pane or sent from Codex with `,,` are treated as
  human shell commands and run directly. Codex/non-interactive operations still
  use the broker guardrail.
- `supervisor_broker_comma_dispatch_enabled` also lets the broker accept a
  recent exact `,,ha ...` or `,, supervisor-api ...` line visible in the Codex
  pane as human dispatch intent if the browser shortcut or Codex guidance misses
  it.

The broker writes decisions to `/data/logs/supervisor-broker.log`. This log is
for accountability and troubleshooting, not tamper-proof audit. A determined
root process can bypass the broker, read `/data/.supervisor/token`, call the
real CLI, alter PATH, or edit logs. This is a guardrail, not a security
boundary.

## Modbus Toolbox

The bundled Modbus tooling is read-only by default:

```bash
modbus-scan 192.168.50.0/24 --port 502 --open-only
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 40001 --address-base modicon --count 2
```

Included support tools are `ncat`, `socat`, `tcpdump`, `libmodbus`,
`pymodbus[serial]`, `minimalmodbus`, and `pyserial`. `mbpoll` is not bundled
yet because it needs a separate multi-architecture packaging pass.

For Schneider Electric devices, verify the exact product and firmware register
map before reading values. Unit IDs, address bases, scale factors, and 32-bit
word order vary. The add-on does not ship Modbus write helpers because writes
can change live inverter, charger, meter, relay, or building-controller
behavior.

## Architecture

Supported for MVP:

- `amd64`
- `aarch64`

`armv7` is omitted because Codex Linux binary availability needs verification
there.
