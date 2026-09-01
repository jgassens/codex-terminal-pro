# Codex Terminal Pro for Home Assistant

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjgassens%2Fcodex-terminal-pro)

Codex Terminal Pro is an unofficial Home Assistant add-on that runs the OpenAI
Codex CLI in a browser terminal, starting in your Home Assistant `/config`
directory. It keeps the upstream add-on wrapper, ingress terminal, image paste
service, persistent package helpers, Home Assistant CLI, GitHub CLI, and
read-only Modbus and solar commissioning helpers, plus persistent `/data` state.

This is an MVP fork. It is not an official OpenAI add-on.

## Features

- Safer Home Assistant edits: Codex starts in `/config`, can inspect YAML and
  storage directly, and Change Desk gathers `ha core check`, recent logs, live
  API reachability, MCP status, and monitor findings before you reload or
  restart.
- Better troubleshooting context: bundled read-only REST/WebSocket helpers,
  `ha-toolbox`, and `/opt/home-assistant/HA.md` give Codex exact entity states,
  service schemas, registry matches, exposed entities, and automation validation
  instead of forcing it to guess from stale config snippets.
- Faster repeat-issue triage: `ha-monitor` records bounded log fingerprints,
  unavailable/unknown state samples, MCP status, and compact deltas under
  `/data/monitor`, so recurring device or config problems do not have to be
  rediscovered from scratch every session.
- House-aware help: `ha-site-memory` builds a local map of areas, integrations,
  and likely entity IDs, so natural phrases like "Ring lights" can resolve to
  the right Home Assistant surfaces before Codex proposes a change.
- One clear approval owner: commands deliberately entered in Shell mode or
  with `,,` run directly, while model-initiated commands use Codex's native
  approval policy. Ask-for-approval can stop the bot before execution, and
  Auto-review or Full access can proceed without a second app-specific prompt.
- Reliable access from more places: the ingress sidebar, persistent `tmux`
  session, mobile command bar, paste fallbacks, and `/config/codex-terminal-pro-attach`
  SSH helper keep the same Codex session reachable across browser refreshes,
  phones, tablets, and ordinary Home Assistant SSH shells.
- Easier evidence sharing: paste or drop screenshots and photos into the prompt,
  keep uploads under `/data/images`, and use transcript/capture helpers when
  you need to recover terminal output that scrolled away.
- Practical field tooling for real homes: solar and Modbus helpers support
  read-only gateway discovery, Home Assistant Energy audits, register reads,
  MQTT/DNS/network checks, and pre-change restore planning before touching live
  inverter, meter, or automation settings.
- Durable add-on state: Codex auth/config, GitHub CLI config, uploaded images,
  terminal transcripts, monitor summaries, the Python virtual environment, and
  the requested APK package manifest live under `/data`. APK packages are
  reinstalled from that manifest after an image update.
- Headless-friendly setup and updates: device-code login support and pinned
  bundled Codex CLI releases keep authentication and CLI upgrades manageable
  from Home Assistant rather than from an interactive desktop.

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

For future releases, use the same release number in
`codex-terminal/config.yaml` `version`, the Dockerfile `io.hass.version` label,
and a new `codex-terminal/CHANGELOG.md` heading. Startup reads its displayed
fallback version from the copied `config.yaml`. Update the Dockerfile
`CODEX_CLI_VERSION` only when the bundled Codex
CLI should change. After pushing to GitHub, reload the Home Assistant add-on
store; Home Assistant compares the installed version with `config.yaml`.

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
Docker access, the ordinary Home Assistant SSH add-on can use only the
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
across the terminal; if the browser blocks automatic copy, an explicit **Copy
selection** panel keeps the exact text available for a deliberate retry or
manual copy.

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

The Shell pane and `,,` are explicit human command surfaces. Commands entered
there run without a second app-specific confirmation. Model-initiated commands
use Codex's current approval policy, so Ask-for-approval can stop them while
Auto-review or Full access can proceed without another terminal challenge.

If browser interception ever misses a `,,` line and Codex sees it as a prompt,
the shipped `codex-shell-dispatch` helper is the fallback path Codex should use
instead of running the stripped command directly.

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

GitHub CLI login and Codex's GitHub MCP transport are separate. `gh auth login`
continues to configure the CLI under `/data/.config/gh`. Startup disables only
the unsupported legacy PAT-backed GitHub MCP subserver so Codex does not print
a missing-token warning; the GitHub plugin itself remains enabled.

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
unchanged. `ha-monitor once` returns success when that observation was collected
and saved; use `ha-monitor once --fail-on-problems` when a script should also fail
if the observation reports errors or unavailable services. It does not call services, reload, restart, edit `/config`, execute
bespoke task files, or call an LLM. Change Desk's Mall Cop path hands the
bounded monitor evidence to Codex through `consult` - the same isolation the
optional consultants use: its own uid, a filtered projection instead
of the live `/config` and `/data` trees, and only the fenced packet as input -
once every 24 hours on panel open, or immediately from the **Ask Mall Cop**
button, and stores comparison memory at
`/data/monitor/change-desk-mall-cop-memory.json`. The live credential never
leaves the real store, and when Codex is signed out or the run fails the same
six sections are rendered deterministically instead, with the footer saying so.
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

Device-code login remains the preferred flow. If Codex falls back to plain
browser login, the browser may stop at a `localhost:1455` or `localhost:1457`
callback URL because those addresses point at the browser machine, not the
add-on container. Copy the complete failed URL into the sign-in dialog; the
add-on forwards it only when the matching live Codex process owns that exact
callback listener.

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
- The `ha` and `supervisor-api` wrappers still validate, classify, and audit
  management operations. They do not ask twice after human or Codex approval.
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
