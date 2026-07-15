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

## Release Status

- GitHub repository URL is set to
  `https://github.com/jgassens/codex-terminal-pro`.
- The Home Assistant base image, Home Assistant CLI, GitHub CLI, and CI actions
  are version/digest pinned and checksum verified where downloaded directly.
- Automated validation covers both `amd64` and `aarch64` image builds in CI.

## Remaining Hardware Validation

- Verify device-code login on an actual Home Assistant add-on install.
- Verify image upload and ttyd ingress through Home Assistant, not just Docker.
- Add API-key auth only if a safe Home Assistant secret path is designed.
