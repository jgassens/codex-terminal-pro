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
install -m 600 config/options.json /tmp/codex-terminal-data/options.json
docker run --rm -it \
  -e IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT=true \
  -p 127.0.0.1:7680:7680 \
  -v /tmp/codex-terminal-data:/data \
  -v /tmp/ha-config:/config \
  local/codex-terminal-pro:test
```

Open `http://localhost:7680`.

The development override accepts loopback traffic only. Production add-on
traffic remains restricted to Home Assistant's authenticated ingress proxy;
the ttyd port is internal and is reached through the image-service proxy.

## Validation

```bash
git status --short --branch
ruby -e 'require "yaml"; %w[repository.yaml codex-terminal/config.yaml].each { |path| YAML.safe_load(File.read(path), permitted_classes: [], aliases: false, filename: path); puts "#{path}: ok" }'
python3 -m json.tool config/options.json >/dev/null
bash -n codex-terminal/run.sh
python3 -m unittest discover -s codex-terminal/scripts/tests -p 'test_*.py' -v
(cd codex-terminal/image-service && npm ci --no-audit --no-fund && npm test && npm audit --omit=dev)
docker run --rm local/codex-terminal-pro:test codex --version
bash codex-terminal/scripts/tests/container-smoke.sh local/codex-terminal-pro:test
```

The YAML command uses Ruby's standard-library parser, so local validation does
not depend on installing PyYAML first.

## Release Checklist

Use one release number in all four release surfaces:

1. `codex-terminal/config.yaml` `version`
2. `codex-terminal/Dockerfile` `io.hass.version`
3. The fallback `APP_VERSION` in `codex-terminal/run.sh`
4. A new heading in `codex-terminal/CHANGELOG.md`

Change `CODEX_CLI_VERSION` in the Dockerfile only when the bundled Codex CLI is
also being upgraded. The repository contract test checks that the first three
release-version values agree.

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
