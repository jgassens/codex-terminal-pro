# Codex Terminal Pro

Codex Terminal Pro is an unofficial OpenAI Codex CLI add-on for Home Assistant.
It opens a web terminal in `/config` and keeps persistent runtime state in
`/data`.

The add-on registers an admin-only sidebar panel titled **Codex Terminal Pro**.
It remains admin-only because the terminal can edit Home Assistant
configuration and call manager-level Home Assistant actions.

## Install

1. Go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open **Repositories** from the three-dot menu.
3. Add:

   ```text
   https://github.com/jgassens/codex-terminal-pro
   ```

4. Install **Codex Terminal Pro**.
5. Start the add-on and open the web UI.

## Updates

To receive updates from GitHub, install Codex Terminal Pro from the custom
repository URL above. A local `/addons` copy is not GitHub-managed.

When publishing an update, bump `version` in `config.yaml`, push to GitHub, and
reload the Home Assistant add-on store. Home Assistant uses that version value
to offer updates.

## First Login

Run:

```bash
codex-auth-helper
```

Use device-code login first:

```bash
codex login --device-auth
```

If that is not available for your account or workspace, authenticate on a
trusted machine and copy `~/.codex/auth.json` into:

```text
/data/.codex/auth.json
```

Then run `codex-auth-helper` again and fix permissions. The file must be mode
`600`. Do not print or share it.

Avoid plain browser login inside the add-on. A callback URL like
`http://localhost:1455/auth/callback?...` points at the browser machine, not the
Home Assistant container, so the OAuth completion usually cannot reach Codex.

ChatGPT subscriptions are used through Codex account auth. API-key auth would
use OpenAI API billing and is deferred until the add-on has a safe
secret-handling path.

## Session Menu

When auto-launch is disabled, or after Codex exits, the menu provides:

1. Start Codex in `/config`
2. Open regular shell in `/config`
3. Codex auth: check/login/import
4. Run Home Assistant config check, if available
5. Reload Home Assistant YAML, if available
6. Restart Home Assistant, only after confirmation
7. Exit

## Persistent State

- Codex home: `/data/.codex`
- Codex auth: `/data/.codex/auth.json`
- Codex config: `/data/.codex/config.toml`
- Shell home: `/data/home`
- GitHub CLI config: `/data/.config/gh`
- Uploaded images: `/data/images`
- Persistent packages: `/data/packages`

The add-on forces file credential storage with:

```toml
cli_auth_credentials_store = "file"
```

## Configuration

```yaml
auto_launch_codex: false
persistent_apk_packages: []
persistent_pip_packages: []
```

## Safe Home Assistant Workflow

1. Ask Codex to inspect configuration first.
2. Ask Codex to show diffs before edits.
3. Run `ha core check`.
4. Reload YAML only if the check passes.
5. Restart Home Assistant only after explicit confirmation.

## Architecture

Supported for MVP:

- `amd64`
- `aarch64`

`armv7` is omitted because Codex Linux binary availability needs verification
there.
