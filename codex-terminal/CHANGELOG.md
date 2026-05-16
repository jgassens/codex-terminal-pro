# Changelog

## 0.1.26

- Stop showing the manual-copy fallback panel for normal desktop terminal
  highlighting when a secondary clipboard attempt reports a false failure.
- Keep the manual-copy panel for explicit copy actions and touch-select
  fallback cases.

## 0.1.25

- Install Alpine's `ripgrep` package so Codex and shell workflows can use
  `rg` inside the add-on.
- Add `rg` path and version to startup diagnostics.

## 0.1.24

- Add a Supervisor broker guardrail for Home Assistant management commands.
  Read-only checks remain frictionless, routine management actions require a
  typed confirmation, and high-risk host/OS/backup/add-on operations require a
  fresh nonce plus reason.
- Store broker decisions in `/data/logs/supervisor-broker.log` with restrictive
  permissions.
- Move the default interactive path toward brokered `ha` and `supervisor-api`
  helpers while documenting that this is a guardrail, not containment.
- Preserve any existing `/config/AGENTS.md`; write add-on guidance to
  `/config/AGENTS.codex-terminal-pro.md` when needed.

## 0.1.23

- Improve iOS and mobile clipboard fallbacks for terminal selections, uploaded
  paths, and voice transcripts.
- Add a visible manual-copy panel when browser clipboard APIs are unavailable.
- Keep touch-device **Select Text** mode as the reliable mobile terminal
  selection path.

## 0.1.22

- Harden `/terminal-input` against cross-origin browser calls and control
  characters.
- Bind ttyd to `127.0.0.1`; ingress continues to use the local Express proxy.
- Validate uploaded image contents with lightweight signature checks and reject
  invalid renamed files.
- Add non-breaking security headers and tighten persistent package argument
  handling.

## 0.1.21

- Make tmux scrollback configurable with a lower default history limit.
- Rewrite transcript rotation to avoid a file-size `stat` call on every output
  line.
- Apply best-effort redaction for common token patterns in terminal transcripts.
- Remove stale frontend auto-paste/key-event fallback paths so image insertion
  continues through the tmux-backed `/terminal-input` endpoint.

## 0.1.20

- Reduce Codex TUI redraw noise by trimming the managed status line back to
  low-cost essentials: run state, model, context remaining, directory, and git
  branch.
- Remove the managed terminal-title override to avoid extra title/redraw churn.
- Make image `beforeinput` paste handling return immediately for normal typing.
- Replace the fixed 3-second image-service startup wait with a fast health poll.

## 0.1.19

- Add a mobile-visible **Select Text** mode for the embedded terminal.
- In select mode, touch-drag maps the finger range to xterm buffer cells,
  visually selects the terminal range, and copies the selected text on release.
- Keep normal terminal touch input unchanged until Select Text mode is enabled.

## 0.1.18

- Capture image paste events inside the embedded ttyd terminal iframe so
  pasting an image at the Codex prompt uploads it and inserts the saved path.
- Handle image paste from `paste` and `beforeinput` events for better mobile
  browser compatibility.
- Support multiple selected, dropped, or pasted images and accept common iOS
  photo formats (`HEIC`/`HEIF`) in addition to JPEG, PNG, GIF, WebP, and SVG.

## 0.1.17

- Remove `permissions` and `approval-mode` from the managed Codex TUI status
  line because Codex `0.130.0` rejects those item IDs.
- Automatically upgrade managed `0.1.15` and `0.1.16` TUI blocks that contain
  unsupported status-line items.

## 0.1.16

- Remove the duplicate context-used field from the managed Codex TUI status
  line, leaving the clearer context-remaining readout.
- Automatically upgrade the exact `0.1.15` managed TUI block while preserving
  user-customized `[tui]` configuration.

## 0.1.15

- Expand the managed Codex TUI defaults into a fuller status HUD with
  Catppuccin Mocha theme colors, run state, task progress, context used and
  remaining, 5-hour and weekly limits, git/branch metadata, permissions,
  approval mode, and Codex version.
- Add a terminal title default with activity, project, branch, and model
  metadata.
- Automatically upgrade the exact `0.1.14` managed footer block while leaving
  user-customized `[tui]` configuration untouched.

## 0.1.14

- Restyle the Home Assistant ingress wrapper with a warmer terminal-focused
  Codex interface while preserving the existing ttyd, tmux, image upload, and
  voice input behavior.
- Add a supported Codex TUI footer default for fresh `/data/.codex/config.toml`
  files showing model, context remaining, working directory, and git branch.
- Leave any existing Codex `[tui]` configuration untouched.

## 0.1.13

- Rotate the persistent terminal transcript instead of appending forever.
- Tighten Codex, GitHub CLI, and XDG state directory permissions under `/data`.
- Remove the unused Home Assistant Auth API permission.
- Pin image-service dependencies with a lockfile and install them with `npm ci`.
- Add uploaded-image retention cleanup while keeping drag/drop upload behavior.
- Start health checks in the background so the terminal opens faster.

## 0.1.12

- Install Alpine's `bubblewrap` package so Codex finds `bwrap` on `PATH`
  instead of warning and falling back to its bundled helper.
- Log `bwrap` path and version in startup diagnostics.

## 0.1.11

- Copy mouse-dragged terminal text by reading the visible xterm buffer cells
  under the drag range, avoiding stale tmux copy-mode output.
- Keep tmux mouse scrolling enabled without forcing tmux copy mode on every
  drag.

## 0.1.10

- Start tmux copy mode on mouse drag so terminal selections have real text to
  send through OSC 52.
- Stop reporting browser copy success when ttyd's native copy handler returns
  true without selected text.

## 0.1.9

- Trigger ttyd/xterm's native copy handler directly on mouse release so Firefox
  sees selection copy as a user-initiated action.
- Keep the wrapper text-copy fallback, but avoid stealing the terminal
  selection before ttyd has a chance to copy it.

## 0.1.8

- Route tmux mouse selections through OSC 52 clipboard support so selecting text
  in the persistent tmux session can reach the browser clipboard.
- Add a small OSC 52 clipboard bridge in the wrapper for ttyd/xterm clipboard
  sequences.

## 0.1.7

- Read highlighted text from ttyd's xterm terminal API before falling back to
  browser selection, so copy-on-select works inside the embedded terminal.
- Enable xterm's macOS Option-drag selection escape hatch for tmux mouse mode.

## 0.1.6

- Insert uploaded image paths directly into the persistent Codex terminal
  prompt using `tmux send-keys`.
- Forward image drops over the embedded terminal iframe to the upload flow.

## 0.1.5

- Copy highlighted terminal text to the browser clipboard when selection
  finishes inside the embedded terminal.

## 0.1.4

- Enable tmux mouse mode so mouse wheel scrolling enters terminal scrollback
  instead of sending up/down history keys to Codex.
- Increase tmux scrollback history to 200,000 lines.
- Save terminal output to `/data/logs/codex-terminal.log` with restrictive
  permissions for debugging warnings that have scrolled off screen.

## 0.1.3

- Run the interactive Codex terminal inside a persistent `tmux` session.
- Reattach to the same terminal session after browser tab switches, websocket
  drops, page refreshes, or Home Assistant ingress reconnects.

## 0.1.2

- Default new installs to auto-launch Codex when the terminal opens.
- Route ttyd websocket upgrades explicitly through the image-service ingress
  proxy so the terminal can work without publishing host port `7681`.
- Normalize Home Assistant ingress paths so the terminal iframe does not request
  `//terminal/`.

## 0.1.1

- Make the Home Assistant sidebar ingress panel explicit.
- Enable ingress streaming for the embedded terminal path.
- Document that the sidebar entry is admin-only because the terminal can edit
  Home Assistant configuration.

## 0.1.0

Initial Codex Terminal Pro MVP fork.

- Renamed the add-on to **Codex Terminal Pro** with slug
  `codex_terminal_pro`.
- Replaced the upstream runtime layer with OpenAI Codex CLI installed by
  `npm install -g @openai/codex`.
- Added persistent Codex state under `/data/.codex`.
- Forced Codex file credential storage with
  `cli_auth_credentials_store = "file"`.
- Added `codex-auth-helper` with device-code login and fallback auth import
  guidance.
- Added a seven-item session picker focused on Codex and Home Assistant safety
  workflows.
- Preserved Home Assistant ingress, ttyd reconnect behavior, image paste,
  persistent package helpers, Home Assistant CLI, GitHub CLI, and `/config`
  access.
- Replaced upstream add-on icon and logo PNGs with Codex icon assets.
- Dropped `armv7` from MVP architecture support pending Codex verification.
- Switched the Dockerfile to an explicit Home Assistant base image instead of
  relying on a `BUILD_FROM` default.

## Fork History

This project is an MIT-licensed fork of the Home Assistant terminal add-on work
by Tom Cassady and an enhanced ESJavadex Home Assistant terminal fork. Historical
runtime details from those upstream projects are intentionally not repeated here
because this fork now targets OpenAI Codex CLI.
