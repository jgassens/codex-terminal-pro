# Codex Terminal Pro

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjgassens%2Fcodex-terminal-pro)

Unofficial OpenAI Codex CLI terminal for Home Assistant.

Codex Terminal Pro provides a Home Assistant ingress web terminal that starts in
`/config`, with Codex CLI, image paste support, persistent packages, Home
Assistant CLI, `ha-toolbox`, read-only REST/WebSocket helpers, MCP status
checks, the bounded `ha-monitor` observer, `ha-site-memory`, GitHub CLI,
read-only Modbus helpers, and a solar commissioning toolbox preinstalled.

It registers an admin-only Home Assistant sidebar panel titled **Codex Terminal
Pro** through ingress.

The web terminal wrapper uses a compact Codex-focused interface around ttyd,
with image paste/drop support and a read-only **Change Desk** review panel
kept one click away from the prompt.

The terminal runs inside a persistent `tmux` session, so browser reconnects and
Home Assistant ingress websocket drops should reattach instead of restarting
Codex.

On startup, the add-on writes `/config/codex-terminal-pro-attach`. Run that
helper from a Home Assistant SSH shell with `/config` access to talk to Codex
Terminal Pro without exposing a second SSH server from this add-on.

Mouse wheel scrolling uses tmux scrollback instead of sending history keys to
Codex. If needed, enter tmux copy mode with `Ctrl-b [` and leave it with `q`.
Terminal output is also mirrored to `/data/logs/codex-terminal.log`; treat that
file as sensitive.

## Browser And Mobile Terminal UX

Highlighted terminal text is copied to the browser clipboard when the selection
finishes. tmux mouse selections are forwarded to the browser clipboard through
OSC 52 support. On touch devices, use **Select Text** in the terminal toolbar,
then drag across the terminal text to select it. Mobile browser clipboard APIs
are best-effort, so a failed automatic copy opens an explicit **Copy selection**
panel containing the exact selected text.

Dropped or pasted images are uploaded to `/data/images`, and the saved image
path is inserted directly into the Codex prompt. Paste is captured inside the
embedded terminal iframe when the browser exposes image clipboard data.

The toolbar includes a **Paste** button for mobile and desktop browsers. It
reads text or images from the clipboard when the browser allows it; if mobile
clipboard access is blocked, it opens a manual paste box that can insert text
into the persistent terminal session. Touch devices also show a native command
bar below the terminal, so typing and paste use a real browser text field while
ttyd remains the live display. Its shortcut strip sends common control keys,
history arrows, tmux page up/down, and return-to-prompt controls.

The mobile command bar is a hybrid terminal input layer: ttyd/xterm remains the
live output surface, while the phone keyboard, native paste, uploaded image
paths, and manual paste text go through a browser textarea when practical. This
avoids the iOS/Android iframe focus failure that can hide the command line
behind the keyboard.

The **Change Desk** button opens a read-only Home Assistant review panel. It
collects the `ha-toolbox` YAML audit, `ha core check`, recent `ha core logs`
issues, persistent `ha-monitor` findings, prepared dispatch deltas, live
`ha-api config` reachability, and `ha-mcp-status` so you can inspect the blast
radius before a reload or restart. It can copy the summary or run Mall Cop.
Opening Change Desk asks Mall Cop to observe and report at most once every 24
hours, and the footer **Ask Mall Cop** action forces a fresh run. Mall Cop sends
a chronic-condition packet to `codex exec` in read-only mode, stores memory
under `/data/monitor/change-desk-mall-cop-memory.json`, and renders the returned
**Mall Cop: To Observe and Report** summary back in Change Desk. The subprocess
runs as an unprivileged user inside a minimal filesystem jail with no `/config`
or `/data` tree.

## Shell Mode And `,,` Dispatch

The **Codex/Shell** mode switch keeps the same ttyd display but changes the
active tmux window. **Codex** shows the Codex TUI; **Shell** opens a real
interactive `/config` login shell for raw terminal commands. From Codex mode,
prefix a line with `,,` to send the rest directly to the Shell pane, for
example `,, ha store reload` or `,,ha store reload`. Completed commands stay in
Codex mode and return their output in the Codex view. Long-running commands
switch to Shell mode so they can be controlled interactively.

The Shell pane and `,,` are explicit human command surfaces. Commands entered
there run without a second app-specific confirmation. Model-initiated shell
commands are governed by Codex's current approval policy; Auto-review or Full
access can approve them without an additional terminal challenge.

If browser interception ever misses a `,,` line and Codex sees it as a prompt,
the shipped `codex-shell-dispatch` helper is the fallback path Codex should use
instead of running the stripped command directly.

Common update flow from Codex mode:

```bash
,,ha store reload
,,ha apps update 0a381758_codex_terminal_pro
,,ha apps restart 0a381758_codex_terminal_pro
,,ha apps info 0a381758_codex_terminal_pro
```

## Home Assistant SSH Access

Codex Terminal Pro does not need its own SSH listener. SSH into Home Assistant
as usual, then run the helper from a Home Assistant SSH shell that can see
`/config`:

```bash
/config/codex-terminal-pro-attach
```

With Docker access, the default command can attach to the live tmux session.
Without Docker access, the ordinary Home Assistant SSH add-on can use only the
read-limited mailbox status check:

```bash
/config/codex-terminal-pro-attach status
```

Shared `/config` is not an authenticated command channel, so mailbox-backed
prompt injection, pane capture, transcript access, and asynchronous file writes
are intentionally disabled. `ask-file` is disabled even with Docker because a
shared `/config` path can change before Codex writes to it.

Interactive `attach`, direct `shell`, `send`, `capture`, `transcript`, `logs`,
and `container` discovery need Docker or a Home Assistant OS host shell because
they access the running add-on container directly:

```bash
/config/codex-terminal-pro-attach
/config/codex-terminal-pro-attach shell
/config/codex-terminal-pro-attach send "say hello"
/config/codex-terminal-pro-attach capture 120
/config/codex-terminal-pro-attach transcript 120
/config/codex-terminal-pro-attach logs
/config/codex-terminal-pro-attach container
```

From the raw HA OS host shell, run the same helper from the Home Assistant
config directory path, commonly
`/mnt/data/supervisor/homeassistant/codex-terminal-pro-attach`.

## Codex Runtime Guidance

On first run, the add-on installs its runtime guidance at `/config/AGENTS.md`.
If that file already exists, the full guidance is written to
`/config/AGENTS.codex-terminal-pro.md`, and a small managed Codex Terminal Pro
capabilities block is appended to `/config/AGENTS.md` or refreshed in place.

This guidance tells Codex about `,,`, `codex-shell-dispatch`, `ha`,
`supervisor-api`, `ha-toolbox`, `ha-api`, `ha-ws`, `ha-mcp-status`,
`ha-monitor`, `ha-site-memory`, `solar-toolbox`, `modbus-toolbox`,
`modbus-scan`, and `modbus-read`.

## Home Assistant Readiness

The add-on includes `ha-toolbox` and `/opt/home-assistant/HA.md` so Codex has a
local Home Assistant field guide and read-only discovery commands before it
starts guessing. The toolbox covers config audits, live states, live services,
helper inventory, dashboards, registries, add-ons, Supervisor, recorder,
statistics, MQTT, Zigbee/ZHA, Z-Wave JS, Matter, ESPHome, mobile app, HomeKit,
and Energy work.

Useful Home Assistant commands:

```bash
ha-toolbox
ha-toolbox audit-config --config /config
ha-toolbox states --pattern battery
ha-toolbox states --domain automation
ha-toolbox services --domain homeassistant
ha-toolbox tools
```

The add-on also includes live read-only API helpers:

```bash
ha-api state sensor.outdoor_temperature
ha-api services --domain automation
ha-api mcp-status
ha-ws entity-registry --pattern kitchen
ha-ws target-info --entity light.kitchen --capabilities
ha-ws validate --file /config/action-snippet.yaml --section action
ha-mcp-status
ha-monitor status
ha-site-memory status
```

`ha-api` talks to Home Assistant Core's REST API through the add-on's internal
Supervisor proxy. `ha-ws` talks to Home Assistant's WebSocket API for live
registry, exposed-entity, target, service/trigger/condition, and validation
queries. `ha-mcp-status` checks whether the official Home Assistant MCP Server
integration is loaded before Codex assumes `/api/mcp` is available.

`ha-monitor` is a lightweight persistent observer. When enabled, it runs every
few minutes, fingerprints recent `ha core logs` warnings/errors, collects bounded
unavailable/unknown entity samples through `ha-api`, records MCP status, and
writes `/data/monitor/ha-monitor.json` plus
`/data/monitor/change-desk-dispatch.json`. The dispatch packet is a compact delta
for Change Desk: new issues, resolved issues, newly persistent issues, config
fingerprint changes, deterministic triage posture, and reasoning budget gates.
Repeated Modbus, Wi-Fi, socket, timeout, and unavailable-entity noise is labeled
as localized connectivity trouble with low system-wide risk unless the entity
looks safety, security, or otherwise critical. Configuration, auth, and
system-health patterns remain review findings. It does not call services,
reload, restart, edit `/config`, execute arbitrary task files, or call an LLM.
Change Desk separately groups the monitor's persistent/current findings into a
chronic-condition ledger. Mall Cop memory compares the current ledger with the
previous Mall Cop run so the summary can distinguish acute state from recurring,
stable, worsening, quiet, new, resolved, changed, or unchanged conditions.
The reserved `/data/monitor/tasks.d` directory is intentionally ignored in this
release so a future bespoke persistent-task design can be added behind explicit
guardrails.

`ha-site-memory` builds a read-only house dictionary from Home Assistant's local
registries and live states. Startup refreshes `/data/monitor/ha-site-memory.md`
when Home Assistant is reachable, and the Codex briefing includes a capped copy
so phrases such as "Ring lights" can resolve to likely entity IDs before Codex
starts broad triage. Optional human notes from `/config/HA_SITE_NOTES.md` are
included when present. Run `ha-site-memory refresh` after renaming devices,
integrations, or areas.

The image also bundles practical Home Assistant admin utilities including
`sqlite3`, `mosquitto_sub`, `mosquitto_pub`, `dig`, `nslookup`, `ping`, `ncat`,
`socat`, `tcpdump`, `openssl`, `ssh`, and `rsync`.

## Solar And Modbus Readiness

The add-on also includes a read-only Modbus toolbox for Home Assistant and
Schneider Electric troubleshooting: `modbus-toolbox`, `modbus-scan`,
`modbus-read`, `ncat`, `socat`, `tcpdump`, `libmodbus`, and Python modules for
`pymodbus`, `minimalmodbus`, and `pyserial`.

For solar, battery, inverter, meter, and Home Assistant Energy work, run
`solar-toolbox`. It provides a site-intake brief, read-only gateway discovery,
Home Assistant entity/config audits, vendor/protocol recognition notes, and a
pre-change restore checklist. The detailed field guide is installed at
`/opt/solar/SOLAR.md`.

Useful solar commands:

```bash
solar-toolbox
solar-toolbox brief
solar-toolbox audit-ha --config /config
solar-toolbox discover 192.168.50.0/24 --ports 502,80,443,1502 --open-only
solar-toolbox snapshot-plan
```

Fresh installs add supported Codex defaults in `/data/.codex/config.toml`:
file credential storage, disabled upstream startup update prompts, Catppuccin
Mocha theme colors, and a footer with run state, model/reasoning/Fast mode,
context remaining, 5-hour limit, and weekly limit. Existing user-customized
Codex TUI config and status-line preferences are left untouched.

The bundled Codex CLI is pinned in the Docker build. This release installs
`@openai/codex@0.147.0`; future CLI updates should bump that Dockerfile value
and the add-on version together.

![Codex Terminal Pro screenshot](screenshot.png)

## Quick Start

1. Click the button above to add the custom repository, or add it manually:

   ```text
   https://github.com/jgassens/codex-terminal-pro
   ```

2. Install **Codex Terminal Pro** from the Home Assistant add-on store.
3. Start the add-on.
4. Open the web UI.
5. Run:

   ```bash
   codex-auth-helper
   ```

6. Choose device-code login, then start Codex from the menu.

## Updating From GitHub

Install from `https://github.com/jgassens/codex-terminal-pro` in the Home
Assistant add-on store to receive updates from GitHub. A local `/addons`
install, usually shown with a `local_` slug, is only for development testing and
does not track GitHub.

When publishing a release, use the same release number in `config.yaml`, the
Dockerfile `io.hass.version` label, the `run.sh` fallback `APP_VERSION`, and a
new `CHANGELOG.md` heading. Change the Dockerfile `CODEX_CLI_VERSION` only when
the bundled Codex CLI is also changing. After the release is pushed, reload the
Home Assistant add-on store and update from the UI; version detection comes
from `config.yaml`.

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
persistent_apk_packages: []
persistent_pip_packages: []
```

- `auto_launch_codex`: Start Codex automatically when the terminal opens. The
  MVP now defaults this to `true`; set it to `false` to open the session picker
  first.
- `terminal_transcript_enabled`: Mirror terminal output to
  `/data/logs/codex-terminal.log` so warnings can be recovered after they scroll
  away.
- `terminal_transcript_max_bytes` and `terminal_transcript_backups`: Rotate the
  transcript before it grows without bound. Transcript redaction is best-effort;
  treat the log as sensitive.
- `terminal_history_limit`: tmux scrollback lines retained inside the persistent
  terminal session.
- `image_retention_days` and `image_retention_max_bytes`: Clean up old uploaded
  images from `/data/images`.
- `ha_monitor_enabled`: Start the read-only HA monitor background observer.
- `ha_monitor_interval_seconds`: Seconds between monitor samples. Values below
  60 are raised to 60 by the helper.
- `ha_monitor_log_lines`: Recent `ha core logs` lines to scan per sample.
- `ha_monitor_state_scan_enabled`: Include bounded unavailable/unknown entity
  samples from `ha-api`.
- `ha_monitor_mcp_status_enabled`: Include MCP Server integration status.
- `ha_monitor_max_issues`: Maximum current/persistent issue samples retained in
  monitor summaries.
- `ha_monitor_summary_interval_seconds`: Low-reasoning eligibility interval
  recorded in dispatch budget gates. HA monitor itself does not call a model;
  Change Desk's Mall Cop path is the gated read-only model call.
- `ha_monitor_reasoning_cooldown_seconds`: Cooldown metadata for repeated
  dispatch packets with the same underlying fingerprints.
- `ha_monitor_reasoning_daily_budget`: Scheduled reasoning-call cap recorded in
  the budget gate for future or explicit workflows.
- `ha_monitor_dispatch_max_chars`: Maximum prepared dispatch packet text size.
- `supervisor_broker_enabled`: Keep the fallback broker enabled for unmarked
  background callers. Verified human terminal commands and commands already
  admitted by Codex's approval policy do not receive a second prompt.
- `supervisor_broker_t1_ttl_seconds`: Short reuse window for routine fallback
  broker confirmations from unknown callers.
- `persistent_apk_packages`: APK package names to keep in the persistent
  manifest and reinstall as complete system packages at startup.
- `persistent_pip_packages`: Python packages to install into the persistent
  virtual environment.

## Auth

Device-code login is preferred for headless Home Assistant use:

```bash
codex-auth-helper
```

The helper sets `CODEX_HOME=/data/.codex`, ensures file credential storage in
`/data/.codex/config.toml`, and fixes `/data/.codex/auth.json` permissions to
`600` if present.

Plain browser login is not reliable in the add-on because Codex completes OAuth
through `localhost:1455`, which points at your browser machine instead of the
Home Assistant container. Use device-code login or import `auth.json`.

Fallback import is supported by copying a local `~/.codex/auth.json` into
`/data/.codex/auth.json`. Treat that file like a password because it contains
access tokens.

ChatGPT subscriptions are used through Codex account auth. API-key auth would
use OpenAI API billing and is not part of the MVP add-on configuration.

GitHub CLI authentication is separate: use `gh auth login` for the bundled
CLI. If `GITHUB_PAT_TOKEN` is absent, the Codex launch guard disables only
known legacy PAT-backed GitHub MCP subserver entries that would otherwise fail
at startup. It preserves the GitHub plugin, leaves unrelated custom MCP servers
alone, and does not synthesize or copy a token.

## Safety

- Back up Home Assistant before edits.
- Ask Codex to inspect first.
- Ask Codex to show diffs before changing files.
- Run `ha core check` before reloads or restarts.
- Only restart Home Assistant after explicit confirmation.

Codex Terminal Pro keeps a Supervisor broker guardrail for unknown background
callers. Read-only `ha` commands run normally. The two registered operator tmux
lanes must match their live pane ID and operating-system session before running
directly, including when a command redirects its input and output.
Normal Codex launches carry an agent-routing marker, so Codex's native policy
is the single approval owner; Ask-for-approval, Auto-review, and Full access
remain the places where model-initiated execution is decided. Unmarked
management callers still receive the fallback broker challenge or fail closed
when they are non-interactive.

This prevents many accidental agent-driven operations during normal use. It
does not prevent a determined root process from bypassing the wrapper, reading
the token file, editing the broker, or tampering with logs. It is a guardrail,
not a security boundary. The pane identity and Codex marker are routing signals
inside that shared root container, not cryptographic authentication.

Clipboard support depends on browser security rules. Nabu Casa and HTTPS
contexts can use browser clipboard APIs; plain HTTP LAN access may need the
manual tap-and-hold copy fallback, especially on iOS.

## Modbus

Run `modbus-toolbox` inside the terminal for examples. The bundled helpers are
read-only by design:

```bash
modbus-scan 192.168.50.0/24 --port 502 --open-only
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 40001 --address-base modicon --count 2
```

Schneider Electric register maps vary by product and firmware. Verify the
exact map, unit ID, address base, scale, and word order before trusting a
decoded value. Modbus write helpers are intentionally not bundled.

## Architecture

The MVP supports `amd64` and `aarch64`. `armv7` is not supported until Codex can
be verified on that platform.

## Attribution

This MIT-licensed fork preserves the Home Assistant add-on wrapper and utility
work from the original upstream terminal add-ons, then swaps the runtime layer to
OpenAI Codex CLI. It is not an official OpenAI add-on.

The Codex icon assets are from LobeHub Icons and are distributed under the MIT
License.
