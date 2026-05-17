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
so text can still be inserted into the terminal. Touch devices also show
compact scroll controls for paging up/down in tmux scrollback and returning to
the live prompt.

The add-on includes read-only Modbus helpers for Home Assistant troubleshooting
and Schneider Electric discovery work. Run `modbus-toolbox` in the terminal for
examples, or see `/opt/modbus/MODBUS.md`.

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

Modbus helper docs are installed at `/opt/modbus/MODBUS.md`. Site-specific
register notes can live under `/config/modbus/` if you want them backed up with
Home Assistant configuration.

The add-on forces file credential storage with:

```toml
cli_auth_credentials_store = "file"
```

## Configuration

```yaml
auto_launch_codex: true
terminal_transcript_enabled: true
terminal_transcript_max_bytes: 1048576
terminal_transcript_backups: 2
terminal_history_limit: 50000
image_retention_days: 30
image_retention_max_bytes: 268435456
supervisor_broker_enabled: true
supervisor_broker_t1_ttl_seconds: 120
persistent_apk_packages: []
persistent_pip_packages: []
```

Terminal transcript logging stays enabled by default for debugging, but the log
rotates under `/data/logs`. Uploaded images stay in `/data/images` long enough
for normal Codex workflows and are cleaned up by age and total size.

`terminal_history_limit` controls tmux scrollback lines. The default is lower
than older releases to reduce memory and redraw pressure while keeping practical
scrollback.

## Safe Home Assistant Workflow

1. Ask Codex to inspect configuration first.
2. Ask Codex to show diffs before edits.
3. Run `ha core check`.
4. Reload YAML only if the check passes.
5. Restart Home Assistant only after explicit confirmation.

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
