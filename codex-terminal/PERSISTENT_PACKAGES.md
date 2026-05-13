# Persistent Packages

Codex Terminal Pro preserves the upstream persistent package workflow. Packages
installed through `persist-install` are copied into `/data/packages` so they
survive add-on restarts and image rebuilds.

## Paths

- Persistent root: `/data/packages`
- Executables: `/data/packages/bin`
- Libraries: `/data/packages/lib`
- Python virtual environment: `/data/packages/python/venv`

All terminal sessions load `/etc/profile.d/persistent-packages.sh`, which adds
these paths to `PATH`, `LD_LIBRARY_PATH`, and `PKG_CONFIG_PATH`.

## Commands

Install an APK package:

```bash
persist-install tree
```

Install Python packages:

```bash
persist-install --python requests pyyaml
```

Install the Home Assistant CLI into persistent storage:

```bash
persist-install --ha-cli
```

List persistent packages:

```bash
persist-install --list
```

## Add-on Configuration

```yaml
persistent_apk_packages:
  - tree
  - ripgrep
persistent_pip_packages:
  - requests
  - pyyaml
```

Configured packages are installed during add-on startup.

## Notes

- Prefer the built-in `ha`, `gh`, `git`, `jq`, `yq`, `curl`, `wget`, `tree`,
  `vim`, and `nano` where possible.
- Persistent package installs still use Alpine packages and may fail if a
  package is unavailable for the add-on architecture.
- Storage is limited by the Home Assistant host's available disk space.
