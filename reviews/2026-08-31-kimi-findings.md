# Code Review Findings

Full code review of the Codex Terminal Pro repository, performed 2026-08-31 on
`main` @ `bb625df` (Release 2.8.2). Working tree was clean. All findings were
produced by reading the code in full; the top items were independently
spot-verified against the sources cited.

Overall: unusually disciplined code for a shell-heavy HA add-on — pinned/verified
downloads, atomic writes with symlink defenses, token redaction in transcripts,
and security tests that exercise the real server end-to-end. The problems that
matter are concentrated in a few isolation boundaries.

---

## Critical / High

### 1. Dev harness = unauthenticated LAN RCE on the developer's machine
- `dev/dev-run.sh:85` sets `IMAGE_SERVICE_ALLOW_LOOPBACK_DEVELOPMENT=true`, but
  `isAllowedRequestSource` (`codex-terminal/image-service/request-security.js:54`)
  returns the flag for **any** source address — no loopback check on that path.
- The server binds `0.0.0.0` (`codex-terminal/image-service/server.js:3641`), so
  anyone on the LAN can reach `POST /terminal-shell-command` and inject
  keystrokes into the real tmux bash session the harness starts.
- `DEVELOPMENT.md:29-31` claims "loopback only", which is false; the documented
  `docker run` example is safe only because it adds `-p 127.0.0.1:7680:7680`.
- **Fix:** bind `127.0.0.1` when the flag is set, or gate on
  `isLoopbackAddress(remoteAddress)` instead of blanket-allow; correct the doc.

### 2. `SUPERVISOR_TOKEN` (manager role) exposed during third-party package installs
- `codex-terminal/run.sh:1453-1454` runs `setup_persistent_packages` (apk/pip
  network installs executing maintainer scripts as root) **before**
  `setup_supervisor_broker` unsets the token at `run.sh:922`.
- A compromised PyPI/apk package reads the token from its environment →
  Supervisor takeover (`hassio_role: manager`, `config.yaml:84`).
- Verified: nothing between init and the broker needs the env var —
  `bashio::config` reads `/data/options.json` locally.
- **Fix:** write the token to `/data/.supervisor/token` and
  `unset SUPERVISOR_TOKEN` at the end of `init_environment`.

### 3. CI on `main` is red — last three releases shipped with a failing Validate
- `codex-terminal/scripts/tests/test_consult.py:220-228` asserts stderr contains
  "not set up yet" / "claude-auth-helper", but `consult:420-421` checks
  `shutil.which("claude")` first and raises "Claude Code is not installed in
  this add-on" on runners without claude. Passes on dev machines, fails on
  `ubuntu-latest`.
- Confirmed failing on CI runs 33395414662, 33349002575, 33338007955
  (releases 2.8.2, 2.8.1, and the consultants merge).
- **Fix:** drop a fake `claude` executable into a tempdir prepended to `PATH`
  for this test (mirrors the fake `kimi` in `dev/dev-run.sh:61`).

### 4. `consult`'s `CDLL("libc.so.6")` is very likely dead on the musl image
- `codex-terminal/scripts/consult:362` dlopens `libc.so.6` (glibc name); the
  base image is Alpine 3.22 (musl) with no `libc6-compat`/`gcompat`.
- The sibling jail correctly uses `CDLL(None)`
  (`codex-terminal/scripts/codex-terminal-mall-cop-jail.py:58`).
- The exception fires inside `preexec_fn` → every consult dies with a traceback.
  Fails closed (no privilege-keeping exec), but the feature is dead. Untested
  either way — container-smoke never runs a consult; could not boot the
  container to confirm.
- **Fix:** use `CDLL(None)` and add a container-smoke consult case.

### 5. Mall Cop jail: live `auth.json` token + network egress + untrusted prompt in one chroot
- `codex-terminal/image-service/mall-cop-isolation.js:189-202` copies the real
  `/data/.codex/auth.json` into a sandbox whose process is fed explicitly
  untrusted HA data. Containment rests entirely on model-level
  `--disable`/`web_search="disabled"` flags — not kernel-level.
- The kill path (`server.js:2275-2288, 2320, 2337-2341`) signals only the direct
  child (no `detached: true`); descendants survive inside the jail with the
  token and network, and their cwd is deleted by `cleanupTempDir`. Compare
  `consult`, which does `start_new_session` + `os.killpg`.
- **Fix:** verify the disable flags against pinned Codex 0.147.0 (AGENTS.md
  requires this), spawn `detached: true` and signal `-child.pid`; longer-term,
  run the jail without network (bubblewrap is already in the image) behind a
  loopback-only API proxy that injects the token.

---

## Medium

### 6. Root-executed scripts at predictable `/tmp` paths
- `run.sh:1299` (`/tmp/codex-terminal-launch.sh`, executed by tmux as root) and
  `run.sh:1102` (`/tmp/codex-terminal-transcript-writer.sh`, via `pipe-pane`).
- The de-privileged consult user (uid 65534) can pre-plant a symlink/file at
  these paths; on the next add-on restart root's `cat >` follows it and tmux
  executes attacker-controlled content as root — defeating the uid-drop
  isolation. Elsewhere the code uses `mktemp` correctly (`run.sh:741,898`).
- **Fix:** write both to a root-only directory (e.g. under `/data/.supervisor`,
  already `chmod 700`) or use `mktemp`.

### 7. No signal handling during startup as PID 1
- `run.sh:1234` + `config.yaml:6` (`init: false`). The TERM/INT trap is only
  installed inside `supervise_web_processes`; the kernel drops SIGTERM for PID 1
  with no handler, so `ha addons stop` during startup (apk installs, venv
  rebuilds — minutes) hangs until the supervisor SIGKILLs.
- **Fix:** install a minimal `trap '... ; exit 0' TERM INT` at the top of `main`.

### 8. Image-service readiness window is only 2 seconds
- `run.sh:1183-1194` (`seq 1 20` × `sleep 0.1`). Cold Node start on aarch64
  (Raspberry Pi) can exceed this; on timeout `set -e` kills `run.sh` and the
  add-on crash-loops despite a healthy service.
- **Fix:** extend to ~10 s (`seq 1 100`).

### 9. `ha-site-memory` can leak the Supervisor token through proxy env vars
- `codex-terminal/scripts/ha-site-memory:143-152` uses
  `urllib.request.urlopen`, which honors `http_proxy`/`HTTP_PROXY`; the
  `Authorization: Bearer` request then goes to that proxy. The other two token
  consumers are hardened (`supervisor-api.sh:253` uses `--noproxy '*'`, `ha-ws`
  uses aiohttp `trust_env=False`).
- **Fix:** `build_opener(ProxyHandler({}))` and use `opener.open(...)`.

### 10. Broker/guard trust markers are forgeable env vars; T2 nonce flow is nearly dead code
- `supervisor-broker.sh:62-96,488-496`: `CODEX_TERMINAL_AGENT_EXECUTION=1` (set
  by the codex wrapper) auto-approves all tiers including `host reboot`;
  `is_trusted_human_terminal` is forgeable by any process in the pane. The T2
  nonce prompt only ever fires for unmarked TTY processes.
- Additionally `supervisor-broker.sh:14-17` **sources**
  `/data/.supervisor/broker.conf` as shell code — any root process can disable
  policy or inject code. The code is candid that this is a "guardrail, not a
  containment boundary"; docs must not oversell it as a security control.
- **Fix:** strict-parse broker.conf instead of sourcing; document that T2
  confirmations apply only to out-of-band scripts.

### 11. `solar-toolbox` materializes the CIDR host list before the cap check
- `codex-terminal/scripts/solar-toolbox:282-286` builds the full list first;
  `discover 10.0.0.0/8` allocates ~16M strings (a `/0` attempts billions) and
  exhausts memory before `--max-hosts` is ever checked.
- **Fix:** compare `network.num_addresses` against the cap before expanding, or
  iterate `network.hosts()` lazily with a counter.

### 12. TOML table-boundary regexes misfire inside multi-line strings
- `codex-disable-heygen-plugin:52-62`, `codex-disable-github-mcp:56-66`,
  `codex-disable-codex-security-mcp:51-61`: `split_tables` treats any line
  starting with `[...]` as a table header, including lines inside a `"""..."""`
  value. A user string containing a bracket line gets `enabled = false`
  inserted into the string; an `enabled = true` at line start inside a string is
  rewritten. Still passes `validate_toml` — silent corruption of user content.
- **Fix:** track triple-quote parity while scanning, or re-render only the
  managed tables from a `tomllib` parse.

### 13. Heuristic "fanout repair" auto-executes a mutated command
- `codex-terminal-shell-dispatch.sh:78-106` and the JS twin
  `image-service/shell-command-normalizer.js:81-141`: collapse "duplicated"
  characters and execute the *repaired* command without confirmation when the
  reduction ratio ≥ 35% and the first word resolves on PATH. `read -r -a`
  re-splitting destroys quoting; a glitchy paste can run a different command
  with mangled arguments.
- **Fix:** print the repaired command and require confirmation, or restrict
  repair to the command name only.

### 14. `modbus-read` rejects `--unit 255`, which the Schneider README recommends
- `codex-terminal/scripts/modbus-read:285` caps `--unit` at 247, but
  `codex-terminal/modbus/schneider/README.md:14` tells users 255 is common for
  Schneider gear. Modbus TCP commonly uses 255 for direct-to-device. Confirmed
  at runtime.
- **Fix:** widen validation to 0–255 (pymodbus accepts it) or fix the README.

---

## Low

### Image service
- **Rejected-request log can capture the hassio_ingress session token** —
  `server.js:2511` logs the raw rejected path; ingress URLs carry the token in
  the path. Log shape/presence like the Change Desk handler (`server.js:3157-3166`).
- **OAuth sign-in code is typed into whichever pane is active** —
  `index.html:4720` → `server.js:3351` (`activeTmuxTarget()`). If the user
  flipped back to Codex mode, the one-time code lands in the model conversation.
  Target `RAW_TMUX_TARGET` for code submission or refuse when not in raw mode.
- **SVG active-content check scans only the first 4 KB** — `server.js:210-215`
  with `readFileHead` default 4096. Low residual risk today (uploads are not
  served over HTTP), but stored-XSS-in-waiting if any route ever serves them.
- **Content sniffing is magic-bytes only** — `server.js:217-258`; an 8-byte fake
  PNG passes. Fine for the disk-reading consumer; note it or decode-validate if
  browser serving is ever added.
- **Sign-in URL recovery can bless a planted OAuth URL** — `signin-utils.js:54-71`;
  a prompt-injected agent printing a real-host `oauth/authorize` URL with an
  attacker `client_id` gets a QR code in the UI. Consider requiring a known
  login-helper process to be alive in the pane.
- **PID-reuse window in cancel escalation** — `server.js:3140-3149`; re-check
  `/proc/<pid>/args` before SIGKILL.
- **No rate limiting on subprocess-spawning GETs** — `server.js:3155, 2713`;
  self-DoS only; an in-flight guard would tidy it.

### Jail / consult
- **All jail runs share uid 65534** — `codex-terminal-mall-cop-jail.py:17-18`;
  per-run isolation between concurrent runs is illusory (same-uid ptrace,
  sibling `summary.md` readable). Blunted because every run gets the same token.
- **Jail launcher does no env scrubbing of its own** —
  `codex-terminal-mall-cop-jail.py:76-77` passes the caller's env verbatim,
  trusting server.js's allowlist. Enforce the allowlist in the launcher too.
- **`copy_credential` uses a single `os.read`** — `consult:348`; a short read
  silently writes a truncated credential. Loop until EOF.
- **`ensure_sandbox_base` never verifies ownership of `/tmp/consult`** —
  `consult:402-407`; `lstat`, refuse symlinks, `chown 0:0` before chmod.
- **Consultants can read `/config/secrets.yaml` and ship it to a third-party
  provider** — `consult:38,76-87`; the uid drop blocks writes only, and Kimi
  gets no tool-restriction flags at all. At minimum document it and add a
  "never read secrets.yaml / auth tokens" line to `framed_prompt`.

### Shell scripts
- **`supervisor-api.sh:256` puts the token in curl's argv** — visible in
  `/proc/<pid>/cmdline`; use `printf 'header = ...' | curl --config -`.
- **Stale `mkdir` lock permanently disables the ssh-bridge after SIGKILL** —
  `codex-terminal-ssh-bridge.sh:99-103`; write the PID into the lock and
  `kill -0` it, or use `flock`.
- **Session picker busy-loops at 100% CPU on stdin EOF** —
  `codex-session-picker.sh:39-47,142-161`; `read -r choice || exit 0`.
- **host-attach request files inherit the caller's umask** —
  `codex-terminal-host-attach.sh:101-102`; with umask 002/000 the mailbox
  rejects every request. Set `umask 077` in `bridge_status_request`.
- **Bridge `mkdir -p`/`chmod 700` follows pre-planted symlinks on shared
  /config** — `codex-terminal-ssh-bridge.sh:105-107`; DoS only (mailbox refuses
  to operate). `lstat`-check before chmod.
- **Poisoned mailbox request dirs are never cleaned** —
  `codex-terminal-ssh-mailbox.py:293-294`; a non-regular `done` entry skips
  cleanup forever. Fall through to the abandoned-TTL path.
- **Kimi credentials directory itself is never chmod'd** —
  `kimi-auth-helper.sh:30-33,119-125`; `chmod 700 "$CRED_DIR"` after the `mv`.
- **bash-only guard can fall through in a POSIX `sh` login shell** —
  `codex-terminal-shell-dispatch.sh:5`; add a `[ -n "${BASH_VERSION:-}" ]` clause.

### Core lifecycle
- **`GITHUB_PAT_TOKEN` branches are unreachable dead code** — `run.sh:212`,
  `health-check.sh:145-153`, `codex-disable-github-mcp:239`; not in the schema,
  nothing exports it, but `DOCS.md:237`/`README.md:384` treat it as settable.
  Document as intentionally unsettable or remove the branches.
- **Dead `init` subcommand and duplicated auto-install logic** —
  `persistent-packages.sh:499-507` vs `run.sh:676-732`; the two validators can drift.
- **`persist-install` usage comment contradicts dispatch** — `persist-install:4`
  says `persist-install python git vim`, but bare `python` selects the pip branch.
- **Build-time helper shipped in the runtime image** — `Dockerfile:155` copies
  `scripts/build/stage-mall-cop-jail.sh`; add `scripts/build/` to `.dockerignore`.
- **Hardcoded version fallback `2.8.2` in `run.sh:400`** will silently
  misreport after the next release (three places to update).

### HA integration
- **`ha-monitor:1317` — `once` always exits 0**; the `else 1` branch is dead.
  Return nonzero for `error`/`unavailable` or document always-0.
- **Duplicated path normalization** — `supervisor-api.sh:109-133` vs
  `supervisor-broker.sh:264-290`; equivalent today, can drift apart.
- **Hardcoded tmux trust targets vs env-overridable session names** —
  `supervisor-broker.sh:11-12` vs `server.js:73-75`; write resolved targets
  into `broker.conf`.
- **`ha-ws:174-188` — no connect timeout, unbounded receive loop**; wrap the
  whole call in `asyncio.wait_for`.
- **`ha-toolbox:288-291` — `secrets.yaml` root keys leak into aggregate output**;
  skip `root_key_counter.update` for `SENSITIVE_FILENAMES`.

### TOML/JSON mutators
- **Advisory lock doesn't include the CLIs themselves** —
  `codex_config_utils.py:21-38`; a concurrent `codex` CLI write between read and
  atomic replace is lost. Comment it or compare (dev, ino, mtime) before replace.
- **`read_config` never enforces the size cap after reading** —
  `codex_config_utils.py:62`; raise if more than `MAX_CONFIG_BYTES` returned.
- **`codex-config-set` inserts `value` verbatim into TOML** —
  `codex-config-set:33`; reject `\r`/`\n` in values (latent — all callers pass
  literals today).
- **`codex-config-tui` misses multi-line / literal-string `status_line` forms** —
  `codex-config-tui:35,44-48`; unsupported items survive silently.
- **`claude-config-set` accepts `NaN`/`Infinity` and writes invalid JSON** —
  `claude-config-set:75`; use `json.dumps(..., allow_nan=False)`.

### Modbus
- **`--port` never range-validated** — `modbus-read:90`; uncaught
  `OverflowError` instead of a clean error (modbus-scan validates 1–65535).
- **`--bytesize`/`--stopbits`/`--timeout` unvalidated** — `modbus-read:113-116`;
  raw tracebacks; use `choices=` and `> 0` checks.
- **`call_read` catches `TypeError` too broadly** — `modbus-read:205-224`; a
  pymodbus-internal TypeError triggers six signature retries (six wire
  requests). Use `inspect.signature` once.
- **Dead duplicate `--version` handling** — `modbus-read:25-27`; short-circuits
  argparse and silently ignores other args.
- **IPv6 targets accepted but probed with `AF_INET`** — `modbus-scan:55`;
  reject non-IPv4 or select the address family per host.
- **`--max-hosts` cap only applies to CIDR expansion** — `modbus-scan:33-51`;
  a comma list of thousands of hosts bypasses it. Cap the final deduped list.

### Tests / CI / dev tooling
- **CI syntax sweep misses scripts AGENTS.md covers** —
  `.github/workflows/validate.yml:44-50` uses `-maxdepth 1` (skips
  `scripts/tests/container-smoke.sh`) and never checks `config/scripts/`.
- **The example session picker has drifted from the shipped one** —
  `config/scripts/codex-session-picker.sh` lacks the auth-missing guard;
  `test_repository_contracts.py:27-44` greps only markers, so it passes.
  If parity is intended, use a diff-based contract test.
- **Dead cleanup trap in the dev harness** — `dev/dev-run.sh:77-80,103`;
  `exec node` discards the EXIT trap and leaks fake-ttyd. Drop `exec` and
  `wait` on the PID.
- **Codex version `0.147.0` hard-coded in container-smoke but absent from the
  release checklist** — `container-smoke.sh:81,113` vs `DEVELOPMENT.md:49-60`.
- **The 0600 credential-mode assertion skips in CI** —
  `test_consult.py:179-188` (`skipTest` when non-root); the O_NOFOLLOW test is
  the only credential-copy assertion with real CI coverage.

---

## Checked and found sound

- **Endpoint authZ matrix**: every mutating route enforces same-origin browser
  provenance; global middleware restricts traffic to the ingress proxy IP, with
  loopback only for `/health` and `/terminal-shell-command`.
- **CSRF**: layered Sec-Fetch-Site → Origin/Referer-vs-Host → non-safelisted
  marker header, with a hostile-preflight test proving no ACAO leakage.
- **Upload handling**: server-generated filenames, extension allowlist, multer
  size caps, partial-file cleanup, retention caps. No traversal possible.
- **XSS in index.html**: all server data rendered via `textContent`/`.value`;
  the only `innerHTML` sink is `qrcode`-generated path data for allow-listed hosts.
- **SSRF**: `/agent-callback-forward` pinned to `127.0.0.1:1455`; WebSocket
  upgrades require trusted peer + Origin==Host; ttyd binds `127.0.0.1`.
- **Supply chain**: base image pinned by digest; HA CLI and gh CLI are
  sha256-verified; npm/pip pinned; image-service uses `npm ci`; no `curl | bash`.
- **Secret hygiene**: `auth.json` forced to 600; supervisor token file 600 in a
  700 dir; transcript writer redacts Bearer/`sk-`/`ghp_`/JWT/`SUPERVISOR_TOKEN`
  shapes; nothing logs `auth.json` contents.
- **SSH mailbox**: dir-fd traversal with `O_NOFOLLOW`, ownership/mode/nlink
  checks, stat→open→fstat re-verification, atomic publish, read-limited.
- **`codex-terminal-config-files.py`**: dir-fd walk, dev/ino re-checks, `O_EXCL`
  temp files, fsync of file and directory; contracts with run.sh verified.
- **`ha-guard.sh`**: strips caller `--endpoint/--api-token/--config`, unsets
  Viper env overrides, rejects symlinked token files, loads the token only after
  broker authorization.
- **`update-apk-manifest`**: `--hold-lock` protocol matches the coproc usage;
  package-name validation blocks option injection; atomic replace + dir fsync.
- **Modbus tooling**: read-only by design, no injection surface, doc claims
  (125-register / 2000-bit limits) match the code; `test_solar_modbus.py`
  covers the riskiest validators and passes.
- **Ingress posture**: no host `ports:` mapping; `panel_admin: true`; the
  no-auth `ttyd --writable` setup is consistent with HA ingress proxy auth.

## Suggested first patch batch

Small, coherent, closes the worst holes:

1. `request-security.js`: gate the dev override on `isLoopbackAddress` (and fix
   `DEVELOPMENT.md` to match). — finding 1
2. `run.sh`: move token persistence + `unset` into `init_environment`. — finding 2
3. `test_consult.py`: fake `claude` on `PATH` for the unsigned test. — finding 3
4. `consult`: `CDLL("libc.so.6")` → `CDLL(None)`. — finding 4
5. `run.sh`: `mktemp`/root-only dir for the two `/tmp` scripts; extend readiness
   loop to ~10 s; add a startup TERM/INT trap. — findings 6–8
