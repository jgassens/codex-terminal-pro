# Codex Terminal Pro for Home Assistant

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fjgassens%2Fcodex-terminal-pro)

Codex Terminal Pro is an unofficial Home Assistant add-on that runs the OpenAI
Codex CLI in a browser terminal, starting in your Home Assistant `/config`
directory. It keeps the upstream add-on wrapper, ingress terminal, image paste
service, persistent package helpers, Home Assistant CLI, GitHub CLI, and
persistent `/data` state.

This is an MVP fork. It is not an official OpenAI add-on.

## Features

- Home Assistant ingress web terminal powered by ttyd.
- Sidebar panel entry for admin users via Home Assistant ingress.
- Persistent `tmux` session so browser reconnects do not kill Codex.
- Codex CLI installed with `npm install -g @openai/codex`.
- Starts in `/config` so Codex can inspect Home Assistant YAML and storage.
- Persistent Codex state under `/data/.codex`.
- Device-code login helper for headless add-on use.
- Image paste, drag-drop, and upload support with files saved in `/data/images`.
- Persistent APK and Python package helpers under `/data/packages`.
- Home Assistant CLI (`ha`) and GitHub CLI (`gh`) included.

## Installation

Click the button above to add this repository to Home Assistant, or install it
manually:

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the three-dot menu and choose **Repositories**.
3. Add this repository URL:

   ```text
   https://github.com/jgassens/codex-terminal-pro
   ```

4. Install **Codex Terminal Pro**.
5. Start the add-on and open the web UI.

After this repository is added through the Home Assistant add-on store, future
updates can be installed from GitHub instead of copying files into `/addons`.

## Updating From GitHub

Install the add-on from this GitHub repository, not from the local `/addons`
folder, if you want Home Assistant to offer updates. The local development app
slug such as `local_codex_terminal_pro` is useful for testing, but it will not
track GitHub releases.

For future releases, bump `codex-terminal/config.yaml` `version`, push to
GitHub, then reload the Home Assistant add-on store. Home Assistant will compare
the installed version with the version in this repository.

## Sidebar Access

Codex Terminal Pro registers a Home Assistant ingress sidebar panel titled
**Codex Terminal Pro**. The panel is admin-only by design because the terminal
has `/config` write access and Home Assistant manager API access.

## Launch Behavior

New installs default to `auto_launch_codex: true`, so Codex starts when the
terminal connects. If you previously installed an older build, Home Assistant
may preserve your existing option value; set `auto_launch_codex` to `true` in
the add-on configuration UI to restore auto-start.

Codex runs inside a named `tmux` session. Closing the browser tab, switching
away from the sidebar panel, refreshing the page, or losing the websocket should
detach the browser but leave Codex running. Reopening the panel reattaches to
the same session.

Mouse wheel scrolling is handled by tmux, with a large scrollback buffer. You
can also use tmux copy mode with `Ctrl-b [` and leave it with `q`. Terminal
output is mirrored to `/data/logs/codex-terminal.log` for debugging warnings
that scroll away. The transcript is rotated by size; treat it as sensitive
terminal output.

Selecting text inside the embedded terminal copies it to the browser clipboard
when the selection finishes. tmux mouse selections are forwarded to the browser
clipboard through OSC 52 support.

Dropping or pasting an image uploads it to `/data/images` and inserts the saved
image path directly into the Codex prompt.

## Authentication

Codex Terminal Pro uses ChatGPT/Codex account authentication for the MVP. A
ChatGPT subscription is used through Codex account auth. API-key auth would use
OpenAI API billing, and is intentionally not exposed in the add-on config yet
because API keys need a safe Home Assistant secret-handling path.

Preferred headless flow:

1. Start the add-on.
2. Open the web UI.
3. Run:

   ```bash
   codex-auth-helper
   ```

4. Choose **Start device-code login** and follow the URL and one-time code.

Do not use the plain browser-login callback from inside the Home Assistant
add-on. URLs like `http://localhost:1455/auth/callback?...` point at your
browser machine, not the add-on container.

Fallback import flow:

1. On a trusted local machine with a browser, configure file credential storage:

   ```bash
   mkdir -p ~/.codex
   grep -q '^cli_auth_credentials_store' ~/.codex/config.toml 2>/dev/null || printf 'cli_auth_credentials_store = "file"\n' >> ~/.codex/config.toml
   codex login
   ```

2. Copy `~/.codex/auth.json` into the add-on's Codex home:

   ```text
   /data/.codex/auth.json
   ```

3. Run `codex-auth-helper` and fix permissions.

Treat `auth.json` like a password. It contains access tokens. Do not commit it,
paste it into tickets, or share it in chat.

## Safety

- Back up Home Assistant before asking Codex to change configuration.
- Ask Codex to inspect first, then show diffs before edits.
- Run `ha core check` before reloads or restarts.
- Do not restart Home Assistant until config checks pass.
- Do not add broader mounts unless there is a concrete need.

## Architecture Support

The MVP supports `amd64` and `aarch64`. `armv7` is not advertised because Codex
Linux binary availability needs verification on that architecture.

## Attribution

Codex Terminal Pro preserves the MIT-licensed Home Assistant add-on work from
Tom Cassady's original terminal add-on and the ESJavadex enhanced fork. This fork
replaces the upstream runtime layer with OpenAI Codex CLI while retaining the
Home Assistant add-on wrapper and utility features.

The Codex icon assets are from LobeHub Icons and are distributed under the MIT
License.
