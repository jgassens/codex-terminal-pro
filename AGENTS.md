# AGENTS.md

Guidance for Codex and other agents working in this repository.

## Project Context

This is a Home Assistant add-on repository for **Codex Terminal Pro**, an
unofficial OpenAI Codex CLI terminal add-on. The add-on exposes a web terminal
through Home Assistant ingress, starts in `/config`, preserves `/data` state,
and includes Home Assistant CLI, GitHub CLI, image paste support, and persistent
package helpers.

This fork descends from the original Home Assistant terminal add-on by Tom
Cassady and the enhanced ESJavadex/claude-code-ha fork. Preserve that
attribution in user-facing docs and license notes.

## Engineering Rules

- Preserve Home Assistant add-on conventions: `config.yaml`, `Dockerfile`,
  `run.sh`, `DOCS.md`, ingress settings, and `/data` persistence.
- Keep the add-on scoped to `/config` access for the MVP. Do not add broader
  mounts such as `/backup`, `/ssl`, `/media`, `/addon_configs`, or host mounts
  unless explicitly requested.
- Do not commit secrets. Never print, copy into logs, or commit
  `/data/.codex/auth.json`; it contains access tokens.
- Prefer small patches. This is an MVP runtime conversion, not a broad refactor.
- Preserve the image service, persistent package system, Home Assistant CLI,
  GitHub CLI, and ttyd reconnect behavior unless a change is necessary.
- Do not add Codex CLI flags unless they are verified against official Codex
  documentation or `codex --help` in a safe container environment.
- Do not implement API-key auth until there is a proper Home Assistant secret
  handling path.

## Validation

Run these checks when possible:

```bash
git status --short --branch
# Run the task's cleanup search and explain any intentional history matches.
python3 - <<'PY'
import yaml
for path in ["repository.yaml", "codex-terminal/config.yaml"]:
    with open(path) as f:
        yaml.safe_load(f)
    print(f"{path}: ok")
PY
bash -n codex-terminal/run.sh
find codex-terminal/scripts -type f -maxdepth 1 -print0 | xargs -0 -n1 bash -n
docker build -t local/codex-terminal-pro:test ./codex-terminal
docker run --rm local/codex-terminal-pro:test codex --version
```

The last two commands require Docker and network access.
