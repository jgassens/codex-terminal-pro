# Codex Terminal Pro for Home Assistant

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjgassens%2Fcodex-terminal-pro)

Codex Terminal Pro is an unofficial Home Assistant add-on that runs the OpenAI
Codex CLI in a browser terminal, starting in your Home Assistant `/config`
directory. It keeps the upstream add-on wrapper, ingress terminal, image paste
service, persistent package helpers, Home Assistant CLI, GitHub CLI, and
read-only Modbus and solar commissioning helpers, plus persistent `/data` state.

This is an MVP fork. It is not an official OpenAI add-on.

## Features

- Home Assistant ingress web terminal powered by ttyd.
- Sidebar panel entry for admin users via Home Assistant ingress.
- Polished Codex-focused web wrapper with image paste/drop support and a
  read-only Change Desk review panel.
- Persistent `tmux` session so browser reconnects do not kill Codex.
- Host-SSH helper written to `/config/codex-terminal-pro-attach`, with
  mailbox-backed status, send, capture, transcript, logs, and ask-file commands
  for the ordinary Home Assistant SSH add-on.
- Switchable Codex/Shell modes, with Shell mode backed by a real interactive
  `/config` tmux shell window.
- Touch-friendly terminal text selection mode for phones and tablets.
- Paste button with clipboard-text/image support and manual mobile fallback.
- Mobile command bar with native typing, shortcut keys, tmux scrollback, and
  return-to-prompt controls.
- `,,` shell dispatch from the Codex prompt, so commands such as
  `,,ha store reload` run in the Shell pane instead of being sent to Codex.
- Hidden Shell dispatch output capture for completed commands, with copy and
  dismiss controls in the Codex view.
- Change Desk snapshot for Home Assistant YAML audit, `ha core check`, recent
  log issues, persistent HA monitor findings, prepared dispatch deltas, live REST
  config reachability, and MCP Server status before reloads or restarts.
- Bounded `ha-monitor` observer that fingerprints recent HA log issues, samples
  unavailable/unknown states, records MCP status, and stores safe summaries under
  `/data/monitor`.
- Deterministic Change Desk dispatch packets under `/data/monitor` with compact
  deltas, config-change fingerprints, localized-connectivity triage, and
  reasoning budget gates; no autonomous model calls are made by the monitor.
- Read-only `ha-site-memory` helper that builds a compact house dictionary under
  `/data/monitor/ha-site-memory.md` so phrases like "Ring lights" resolve to
  likely integrations, areas, and entity IDs before Codex starts troubleshooting.
- Trusted human Shell lane for commands typed in Shell mode or dispatched with
  `,,`, while Codex/non-interactive Home Assistant operations remain guarded.
- Codex CLI pinned and installed in the add-on image with
  `npm install -g @openai/codex@0.134.0`.
- Starts in `/config` so Codex can inspect Home Assistant YAML and storage.
- Persistent Codex state under `/data/.codex`.
- Upstream Codex CLI startup update prompts are disabled so add-on updates stay
  controlled by Codex Terminal Pro image releases.
- Supported Codex TUI defaults for theme colors, model, Fast mode, context, and
  rolling usage limits.
- Device-code login helper for headless add-on use.
- Image paste and drag-drop upload support with files saved in `/data/images`
  and paths inserted into the prompt.
- Persistent APK and Python package helpers under `/data/packages`.
- Home Assistant CLI (`ha`), `ha-toolbox`, `ha-api`, `ha-ws`,
  `ha-mcp-status`, `ha-monitor`, `ha-site-memory`, and GitHub CLI (`gh`)
  included.
- Read-only Home Assistant REST/WebSocket helpers for exact live entity
  snapshots, service schemas, entity registry discovery, target expansion,
  exposed-entity checks, and automation snippet validation.
- Home Assistant field guide at `/opt/home-assistant/HA.md` plus common admin
  utilities including `sqlite3`, MQTT clients, DNS/network tools, OpenSSL,
  OpenSSH client, and `rsync`.
- Solar commissioning toolbox with `solar-toolbox` for site intake, read-only
  gateway discovery, Home Assistant energy/entity audits, protocol/vendor
  recognition, and pre-change restore planning.
- Read-only Modbus toolbox with `modbus-read`, `modbus-scan`, `ncat`,
  `socat`, `tcpdump`, `libmodbus`, `pymodbus`, `minimalmodbus`, and
  `pyserial`.

## Installation

Click the button above to add this repository to Home Assistant, or install it
manually:

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the three-dot menu and choose **Repositories**.
3. Add this repository URL:

   ```text
   https://github.com/jgassens/codex-terminal-pro
   ```

4. Install **Codex Terminal Pro**.
5. Start the add-on and open the web UI.

After this repository is added through the Home Assistant add-on store, future
updates can be installed from GitHub instead of copying files into `/addons`.

## Updating From GitHub

Install the add-on from this GitHub repository, not from the local `/addons`
folder, if you want Home Assistant to offer updates. The local development app
slug such as `local_codex_terminal_pro` is useful for testing, but it will not
track GitHub releases.

For future releases, bump `codex-terminal/config.yaml` `version`, update the
Dockerfile `CODEX_CLI_VERSION` when the bundled Codex CLI should change, push
to GitHub, then reload the Home Assistant add-on store. Home Assistant will
compare the installed version with the version in this repository.

## Sidebar Access

Codex Terminal Pro registers a Home Assistant ingress sidebar panel titled
**Codex Terminal Pro**. The panel is admin-only by design because the terminal
has `/config` write access and Home Assistant manager API access.

## Home Assistant SSH Access

Codex Terminal Pro does not run its own SSH server. If you already SSH into
Home Assistant and that shell can see `/config`, use the helper that the add-on
writes there:

```bash
/config/codex-terminal-pro-attach
```

With Docker access, the default command attaches to the existing
`codex-terminal` tmux session inside the running add-on container. Without
Docker access, the ordinary Home Assistant SSH add-on still supports the
mailbox-backed commands below:

```bash
/config/codex-terminal-pro-attach status
/config/codex-terminal-pro-attach send "say hello"
/config/codex-terminal-pro-attach capture 120
/config/codex-terminal-pro-attach transcript 120
/config/codex-terminal-pro-attach ask-file /config/codex-ssh-reply.txt "write a one-line status"
/config/codex-terminal-pro-attach logs
```

`capture` reads the current tmux pane, and `transcript` reads the add-on's
internal `/data/logs/codex-terminal.log` through the Codex Terminal Pro bridge.
For reliable SSH-side request/response tests, `ask-file` tells Codex to write
the answer under `/config`, then the SSH shell can read it with `cat`.

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

## Launch Behavior

New installs default to `auto_launch_codex: true`, so Codex starts when the
terminal connects. If you previously installed an older build, Home Assistant
may preserve your existing option value; set `auto_launch_codex` to `true` in
the add-on configuration UI to restore auto-start.

Codex runs inside a named `tmux` session. Closing the browser tab, switching
away from the sidebar panel, refreshing the page, or losing the websocket should
detach the browser but leave Codex running. Reopening the panel reattaches to
the same session.

Mouse wheel scrolling is handled by tmux, with a large scrollback buffer. You
can also use tmux copy mode with `Ctrl-b [` and leave it with `q`. Terminal
output is mirrored to `/data/logs/codex-terminal.log` for debugging warnings
that scroll away. The transcript is rotated by size; treat it as sensitive
terminal output.

### Mobile Terminal UX

The terminal stays on ttyd/xterm for live output, colors, cursor behavior, and
Codex TUI panels. On touch devices, input moves to a native browser command bar
below the terminal so iOS and Android keyboards do not need to focus the iframe.

The mobile command bar includes a real textarea, **Send** button, Ctrl-C,
Ctrl-D, Ctrl-Z, Tab, Enter, command-history arrows, clear, tmux page up/down,
and return-to-bottom controls. Header **Paste**, manual paste fallback, and
uploaded image paths target the native command field on mobile when practical.

Selecting text inside the embedded terminal copies it to the browser clipboard
when the selection finishes. tmux mouse selections are forwarded to the browser
clipboard through OSC 52 support. Touch devices can use **Select Text** and drag
across the terminal; if the browser blocks automatic copy, the selected text is
left visible for manual copy.

Dropping or pasting an image uploads it to `/data/images` and inserts the saved
image path directly into the Codex prompt.

The toolbar includes a **Paste** button. It can paste clipboard text into the
terminal, upload clipboard images when the browser exposes them, or open a
manual paste box on mobile browsers that block direct clipboard reads.

### Shell Mode And `,,` Dispatch

Use the **Shell** mode switch for raw terminal commands. It changes the ttyd
view to a real interactive tmux shell in `/config`; **Codex** switches back to
the Codex TUI window. From Codex mode, prefix a line with `,,` to send the rest
directly to the Shell pane, for example `,, ha store reload` or
`,,ha store reload`. Completed commands stay in Codex mode and return their
output in the Codex view. Long-running commands switch to Shell mode so they can
be controlled interactively.

Commands typed directly in Shell mode, or sent from Codex with `,,`, are treated
as human shell commands. They do not ask for a second broker confirmation.
Codex/non-interactive `ha` and `supervisor-api` operations still use the broker
guardrail, so agent-driven restart, stop, update, host, OS, backup, install,
and uninstall operations cannot silently answer their own prompts.

If browser interception ever misses a `,,` line and Codex sees it as a prompt,
the shipped `codex-shell-dispatch` helper is the fallback path Codex should use
instead of running the stripped command directly. The broker also recognizes a
recent exact `,,ha ...` or `,, supervisor-api ...` line in the Codex pane as
human dispatch intent for the matching operation.

Useful update commands from Codex mode:

```bash
,,ha store reload
,,ha apps update 0a381758_codex_terminal_pro
,,ha apps restart 0a381758_codex_terminal_pro
,,ha apps info 0a381758_codex_terminal_pro
```

### Codex Runtime Guidance

The add-on installs Codex guidance in `/config/AGENTS.md` on first run. If that
file already exists, it preserves the user file, writes the full add-on guidance
to `/config/AGENTS.codex-terminal-pro.md`, and appends or refreshes a small
managed Codex Terminal Pro capabilities block inside `/config/AGENTS.md`.

The add-on also writes `/config/CODEX_TERMINAL_PRO.md` and installs
`codex-terminal-briefing`. That briefing is the short environment map for Codex:
it lists shell dispatch behavior, Home Assistant helpers, broker rules,
solar/Modbus tools, useful paths, and safety boundaries. If Codex seems unaware
of the wrapper, ask it to run:

```bash
codex-terminal-briefing
```

That guidance tells Codex about `,,`, `codex-shell-dispatch`, `ha`,
`supervisor-api`, `ha-toolbox`, `ha-api`, `ha-ws`, `ha-mcp-status`,
`ha-monitor`, `ha-site-memory`, `solar-toolbox`, `modbus-toolbox`,
`modbus-scan`, and `modbus-read`.

## Home Assistant Toolbox And Live API Helpers

Run `ha-toolbox` inside the terminal for Home Assistant-native orientation.
It is read-only by default and gives Codex a local map for configuration,
states, services, dashboards, registries, add-ons, Supervisor, recorder,
MQTT, Zigbee/ZHA, Z-Wave JS, Matter, ESPHome, mobile app, HomeKit, Energy, and
common troubleshooting paths.

```bash
ha-toolbox
ha-toolbox audit-config --config /config
ha-toolbox states --pattern battery
ha-toolbox states --domain automation
ha-toolbox services --domain homeassistant
ha-toolbox tools
```

Run `ha-api` when Codex needs an exact Core REST lookup, and `ha-ws` when it
needs richer live WebSocket discovery before editing YAML:

```bash
ha-api state sensor.outdoor_temperature
ha-api services --domain automation
ha-ws entity-registry --pattern kitchen
ha-ws target-info --entity light.kitchen --capabilities
ha-ws validate --file /config/action-snippet.yaml --section action
ha-mcp-status
ha-monitor status
ha-site-memory status
```

These helpers are read-only by design. Use the existing brokered `ha` command
or human Shell dispatch path for control actions.

`ha-monitor` is the safe first slice of persistent agent behavior. When enabled,
it runs in the background every few minutes, reads recent Home Assistant logs,
collects bounded unavailable/unknown state samples, checks MCP status, and writes
summaries to `/data/monitor/ha-monitor.json` plus dispatch packets to
`/data/monitor/change-desk-dispatch.json`. It fingerprints deltas between samples
so Change Desk can say whether anything is new, resolved, persistent, or likely
unchanged. It does not call services, reload, restart, edit `/config`, execute
bespoke task files, or call an LLM. Reasoning budget fields are gate metadata for
future scheduled summaries and explicit Send Report/user-question flows.
The monitor also triages issues deterministically: Modbus, Wi-Fi, socket,
timeout, and unavailable-entity noise is labeled as localized connectivity
trouble with low system-wide risk unless the entity looks safety, security, or
otherwise critical. Configuration, auth, and system-health patterns still remain
review findings.

`ha-site-memory` builds a read-only site map from Home Assistant's local
registries and live states. Startup refreshes `/data/monitor/ha-site-memory.md`
when Home Assistant is reachable, and `codex-terminal-briefing` includes a capped
copy so new Codex sessions can resolve house-specific phrases before broad
triage. Optional human notes from `/config/HA_SITE_NOTES.md` are included when
present. Run `ha-site-memory refresh` after renaming devices or integrations.

The detailed Home Assistant field guide is installed at
`/opt/home-assistant/HA.md`.

## Solar Toolbox

Run `solar-toolbox` inside the terminal for solar, battery, inverter, gateway,
meter, Modbus, SunSpec, MQTT, and Home Assistant Energy work. The toolbox is
read-only first: it helps identify topology, preserve state before changes, and
find the right gateway/protocol path before touching installer settings.

```bash
solar-toolbox
solar-toolbox brief
solar-toolbox audit-ha --config /config
solar-toolbox discover 192.168.50.0/24 --ports 502,80,443,1502 --open-only
solar-toolbox snapshot-plan
```

The installed field guide lives at `/opt/solar/SOLAR.md` and covers site
intake, Home Assistant Energy checks, gateway discovery, battery/backup
readiness, vendor/protocol recognition, and pre-change restore captures.

## Modbus Toolbox

Run `modbus-toolbox` inside the terminal for quick examples and installed
versions. The bundled helpers are read-only:

```bash
modbus-scan 192.168.50.0/24 --port 502 --open-only
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 40001 --address-base modicon --count 2
```

Schneider Electric maps vary by product and firmware. Verify the register map,
unit ID, address base, scale, and word order before trusting decoded values.
Write-register helpers are intentionally not bundled.

## Authentication

Codex Terminal Pro uses ChatGPT/Codex account authentication for the MVP. A
ChatGPT subscription is used through Codex account auth. API-key auth would use
OpenAI API billing, and is intentionally not exposed in the add-on config yet
because API keys need a safe Home Assistant secret-handling path.

Preferred headless flow:

1. Start the add-on.
2. Open the web UI.
3. Run:

   ```bash
   codex-auth-helper
   ```

4. Choose **Start device-code login** and follow the URL and one-time code.

Do not use the plain browser-login callback from inside the Home Assistant
add-on. URLs like `http://localhost:1455/auth/callback?...` point at your
browser machine, not the add-on container.

Fallback import flow:

1. On a trusted local machine with a browser, configure file credential storage:

   ```bash
   mkdir -p ~/.codex
   grep -q '^cli_auth_credentials_store' ~/.codex/config.toml 2>/dev/null || printf 'cli_auth_credentials_store = "file"\n' >> ~/.codex/config.toml
   codex login
   ```

2. Copy `~/.codex/auth.json` into the add-on's Codex home:

   ```text
   /data/.codex/auth.json
   ```

3. Run `codex-auth-helper` and fix permissions.

Treat `auth.json` like a password. It contains access tokens. Do not commit it,
paste it into tickets, or share it in chat.

## Safety

- Back up Home Assistant before asking Codex to change configuration.
- Ask Codex to inspect first, then show diffs before edits.
- Run `ha core check` before reloads or restarts.
- Do not restart Home Assistant until config checks pass.
- Codex/non-interactive `ha` and `supervisor-api` operations still use the
  broker guardrail. Commands typed in the Shell pane or sent with `,,` are
  treated as human shell commands and run directly.
- Do not add broader mounts unless there is a concrete need.

## Architecture Support

The MVP supports `amd64` and `aarch64`. `armv7` is not advertised because Codex
Linux binary availability needs verification on that architecture.

## Attribution

Codex Terminal Pro preserves the MIT-licensed Home Assistant add-on work from
Tom Cassady's original terminal add-on and the ESJavadex enhanced fork. This fork
replaces the upstream runtime layer with OpenAI Codex CLI while retaining the
Home Assistant add-on wrapper and utility features.

The Codex icon assets are from LobeHub Icons and are distributed under the MIT
License.
