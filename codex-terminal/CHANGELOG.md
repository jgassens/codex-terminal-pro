# Changelog

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
