# Changelog

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
