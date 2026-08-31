# Dev harness

Runs the add-on's web frontend on this machine with no docker: the real
image-service, a real tmux session (so the sign-in link detection, cancel,
and consultant-setup endpoints work for real), a fake ttyd page for the
terminal iframe, and consult fixtures (a signed-in Claude, a Kimi with two
models carrying different `support_efforts`).

```bash
bash dev/dev-run.sh   # http://localhost:7680
```

Useful moves while it runs:

- Pop the sign-in dialog: print an OAuth-looking URL on a known host into
  the pane, e.g.
  `tmux send-keys -t codex-terminal:0.0 "echo 'https://claude.com/cai/oauth/authorize?code=true&state=x'" Enter`
- Unknown hosts (e.g. `https://evil.example/login`) must NOT pop the dialog.
- Make the shell pane busy (to test the consultant-setup 409):
  `tmux send-keys -t codex-terminal:raw-shell.0 "node -e 'setTimeout(()=>{},600000)'" Enter`
- Consultant state lives in `dev/.state/` (fixtures are created on first
  run and never committed); delete the directory to reset.

Note: pages gate their polling on `document.visibilityState`, so a
headless/preview surface that reports `hidden` will not poll; shadow
`document.hidden` in the console when driving the page from automation.

`.state/` and `fake-ttyd/node_modules/` are git-ignored. The docker build
context is `./codex-terminal`, so nothing in `dev/` ships in the image.
