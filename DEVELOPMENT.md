# Development

Local notes for Codex Terminal Pro.

## Build

The Dockerfile uses an explicit Home Assistant base image. Do not pass
`BUILD_FROM`.

```bash
docker build -t local/codex-terminal-pro:test ./codex-terminal
```

## Run Locally

```bash
mkdir -p /tmp/codex-terminal-data /tmp/ha-config
docker run --rm -it \
  -p 7680:7680 \
  -p 7681:7681 \
  -v /tmp/codex-terminal-data:/data \
  -v /tmp/ha-config:/config \
  local/codex-terminal-pro:test
```

Open `http://localhost:7680`.

## Validation

```bash
git status --short --branch
python3 - <<'PY'
import yaml
for path in ["repository.yaml", "codex-terminal/config.yaml"]:
    with open(path) as f:
        yaml.safe_load(f)
    print(f"{path}: ok")
PY
bash -n codex-terminal/run.sh
find codex-terminal/scripts -maxdepth 1 -type f -print0 | xargs -0 -n1 bash -n
docker run --rm local/codex-terminal-pro:test codex --version
```

## Auth Testing

Inside the running add-on/container:

```bash
codex-auth-helper
```

Use device-code login first. For fallback import, copy a trusted
`~/.codex/auth.json` into `/data/.codex/auth.json` and set permissions to
`600`.

## Home Assistant Testing

In Home Assistant:

1. Add the custom repository.
2. Install Codex Terminal Pro.
3. Start the add-on.
4. Open the web UI.
5. Run `codex-auth-helper`.
6. Start Codex and verify it opens in `/config`.
7. Ask Codex to inspect Home Assistant config before making changes.
