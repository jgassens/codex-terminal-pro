# Persistent Packages

Codex Terminal Pro preserves requested package manifests under `/data/packages`
so packages can be restored after add-on restarts and image rebuilds. Alpine
packages are reinstalled normally from their names, which restores the complete
package and dependency metadata instead of copying only a few binaries and
libraries from an older image.

## Paths

- Persistent root: `/data/packages`
- Alpine package manifest: `/data/packages/apk-packages.txt`
- Optional user executables: `/data/packages/bin` (last on `PATH`)
- Python virtual environment: `/data/packages/python/venv`
- Quarantined pre-2.6 copied shared libraries: `/data/packages/legacy-copied-files/lib`

All terminal sessions load `/etc/profile.d/persistent-packages.sh`. The guarded
system tools stay ahead of `/data/packages/bin` on `PATH`, so a persisted file
cannot silently replace the brokered Home Assistant `ha` command.
The Python virtual environment is active in interactive terminal sessions so
installed modules and console scripts are usable there. The add-on supervisor
itself keeps system tools ahead of that venv when it starts Node, ttyd, tmux,
and package restoration.

On the first 2.6 startup, shared libraries copied by older releases are moved
into `legacy-copied-files`. They are preserved for manual recovery but are no
longer placed on `LD_LIBRARY_PATH`; loading those partial files after an Alpine
image update can break Node, curl, Codex, or the entire add-on. Legacy/user
executables remain in `bin`, but that directory is last on `PATH`, so complete
system packages win. Requested APK names are restored as complete packages.

### Upgrading From A Release Before 2.6

Older releases saved loose package files but did not record the original APK
package names, so 2.6 cannot safely infer what to reinstall. After upgrading,
re-run `persist-install <package-name>` for each APK package you still need, or
add those names to `persistent_apk_packages` in the add-on configuration and
restart. Confirm the replacement packages work before manually deleting
anything under `legacy-copied-files`. Existing Python virtual-environment
packages remain under `/data/packages/python/venv`.

## Commands

Install an APK package:

```bash
persist-install tree
```

Install Python packages:

```bash
persist-install --python requests pyyaml
```

Check the Home Assistant CLI policy:

```bash
persist-install --ha-cli
```

The add-on already ships the guarded Home Assistant CLI. This command explains
that policy; it does not download a second unguarded `ha` executable.

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
- Persistent APK names are validated and reinstalled with `apk add` at startup;
  they may fail if a package is unavailable for the add-on architecture or the
  package repository cannot be reached.
- Storage is limited by the Home Assistant host's available disk space.
