# Development Status

## Codex Terminal Pro MVP

The repository has been converted into a first MVP fork:

- Product name: Codex Terminal Pro
- Slug: `codex_terminal_pro`
- Add-on directory: `codex-terminal/`
- Runtime CLI: OpenAI Codex CLI installed with npm
- Persistent Codex home: `/data/.codex`
- Auth helper: `codex-auth-helper`
- Session picker: `codex-session-picker`
- Supported architectures: `amd64`, `aarch64`

## Remaining Maintainer Work

- GitHub repository URL is set to
  `https://github.com/jgassens/codex-terminal-pro`.
- Pin `ghcr.io/home-assistant/base:latest` to a specific current base image tag
  when ready for release hardening.
- Verify device-code login on an actual Home Assistant add-on install.
- Verify image upload and ttyd ingress through Home Assistant, not just Docker.
- Add API-key auth only if a safe Home Assistant secret path is designed.
