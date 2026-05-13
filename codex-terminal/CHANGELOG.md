# Changelog

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
by Tom Cassady and the enhanced ESJavadex/claude-code-ha fork. Historical
runtime details from those upstream projects are intentionally not repeated here
because this fork now targets OpenAI Codex CLI.
