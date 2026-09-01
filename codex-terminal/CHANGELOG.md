# Changelog

## 2.10.2

- Ask consultants in parallel. `consult --agents kimi,claude "..."` runs both
  at once as independent opinions - not a primary and a backup - and streams
  each answer as it lands, fastest first, so Codex can act on the quick one
  (Kimi) the moment it settles the question and still get the slower, deeper
  one (Claude) when it arrives. Single-consultant `consult --agent X` and the
  bare default are unchanged. The consult skill now teaches this pattern.
- Raise the default consult timeout to 600s (from 300s). A heavy safety review
  that reads several config files at high effort was overrunning five minutes
  and being reported as a timeout; it now has room to finish. A consultant
  that still overruns is shown as "no answer" for that one while the others'
  answers stand. Effort is unchanged - consults stay at full intelligence.

## 2.10.1

- Fix consultants failing everywhere with "filesystem isolation could not be
  applied" on kernels without Landlock. 2.9.0's security pass made Landlock a
  required, fail-closed layer, but Home Assistant OS ships kernels that do not
  implement it (the syscall returns ENOSYS), so every consult - and Mall Cop's
  Codex narration - died at startup. Landlock is now applied where the kernel
  provides it and skipped where it does not, falling back to the dedicated
  unprivileged uid, the redacted workspace projection, and no-new-privileges
  (the model shipped before 2.9.0). A Landlock that is present but fails after
  the probe still fails closed. consult notes on stderr which isolation tier a
  run used.

## 2.10.0

- Add Codex as a consultant. It uses the login the terminal already has and
  runs through the same isolation as Claude Code and Kimi Code: its own uid,
  Landlock, a filtered projection instead of the live trees, an ephemeral
  `codex exec` with every extra capability switched off, and no write-back of
  its credential copy, so a prompt-injected run can never rewrite the
  terminal's own identity.
- Mall Cop narrates again. Change Desk hands the bounded monitor evidence to
  the Codex consultant through `consult` - so the model never holds the live
  credential and sees nothing but the fenced packet - and renders the six
  sections it writes. When Codex is signed out or the run fails, the
  deterministic reading of the same sections is shown instead, and the
  observation footer says which one you are looking at.
- The Codex auth helper reports real sign-in state the way the other helpers
  now do, instead of "present, 600".

## 2.9.0

Security pass. An independent review of 2.8.2 (`reviews/2026-08-31-kimi-findings.md`)
was verified and repaired finding by finding (`reviews/2026-08-31-codex-review.md`):

- The manager `SUPERVISOR_TOKEN` is written to a root-only file and removed from
  the environment before apk, pip, npm, or any other third-party code runs.
- The development harness accepts the loopback override only from an actual
  loopback peer and binds to 127.0.0.1; it used to accept any LAN address.
- Root-executed launch and transcript helpers live under a root-only runtime
  directory instead of predictable shared /tmp paths.
- Root terminal control is no longer reachable over container loopback, and
  consultants can no longer reach the live /config or /data trees: each runs
  under its own uid with a Landlock-confined, filtered projection.
- Mall Cop no longer launches a model. It rendered untrusted Home Assistant data
  through a Codex process holding a copy of the live credential with network
  access and only model-level containment. It is now a deterministic local
  renderer of the same six sections; model narration returns in a later release
  through the consultant isolation path.
- Broker configuration is parsed as data rather than sourced as shell; the
  paste-repair heuristic no longer rewrites quoted arguments; the three TOML
  mutators no longer mistake string contents for tables; rejected-request logs
  no longer capture the ingress token; `ha-site-memory` ignores proxy
  environment variables; solar discovery bounds a CIDR before expanding it;
  Modbus TCP accepts unit IDs through 255.
- Image decoding is fully validated with resource bounds, subprocess-heavy
  reads share one global budget, the OAuth callback flow verifies ownership,
  and startup waits for both the image service and the ttyd transport.
- The consultant test no longer depends on a developer-machine `claude`
  binary, which had been failing Validate on every push since 2.8.0.

Consultant sign-in truthfulness:

- Report a consultant as signed in only when its stored credential still holds
  a token. Signing out leaves the credential file in place with the tokens
  emptied, so the Settings panel, `consult --list`, and the auth helpers all
  reported a dead account as "signed in and ready" while every consult failed.
- Sign in to Claude Code with `claude auth login`, the CLI's own sign-in
  command. The previous option launched the chat interface, which signs you in
  only if you then remember to type /login.
- Refuse a shell dispatch while the Shell pane is busy, the way consultant
  setup already does. A dispatch types into the shared pane, so it used to
  take the pane from an auth helper mid-sign-in or a running consultant.
- Carry a token refreshed during a consult back into the real credential
  store. The consultant runs against a throwaway copy, so a refresh was
  discarded with the sandbox while the provider had already rotated the old
  token away.
- Include the consultant's own log in a failure message. Kimi reports errors as
  "See log: <path>" pointing inside the sandbox that cleanup then deletes.

## 2.8.2

- Keep the image service's output in /data/logs/image-service.log (one rotated
  backup) in addition to the add-on log. A service that dies at startup used
  to lose its traceback to the container teardown, leaving only "Image service
  failed to start"; the failure branch now also prints the log's last lines so
  the add-on log itself shows the cause.

## 2.8.1

- Keep the sign-in dialog above the Settings panel. Starting a consultant
  sign-in from Settings used to pop the link and QR code invisibly underneath
  it, making the flow look dead.
- Show the server's actual refusal when a consultant setup cannot start, such
  as the Shell pane being busy with another sign-in, instead of a generic
  failure line.

## 2.8.0

- Add optional consultants. Codex remains this add-on's agent; Claude Code and
  Kimi Code ship alongside it and stay inert until the user signs one in.
- Add the `consult` command and a bundled Codex skill so Codex can ask a
  consultant for an independent opinion, either on its own or as `$consult`.
  A consultant runs as an unprivileged user with read-only access to `/config`,
  gets its credentials as a throwaway copy, and has every provider API key
  stripped from its environment.
- Add a Settings panel to the web UI covering consultant setup and consult
  defaults. Starting a sign-in runs the helper in the Shell pane so it never
  types into a working Codex session.
- Recover consultant sign-in links from the terminal, where they are wrapped
  and unselectable, and present them as a real link plus a QR code with a field
  for the returned code. Links are reassembled at whatever width the active
  viewer imposed on the shared window.
- Let a Codex browser sign-in that dead-ends on `localhost:1455` be completed
  by pasting the failed URL, which is delivered to the CLI's own in-container
  listener. Only that fixed host, port, and path are forwardable.

## 2.6.9

- Stop asking for a second Home Assistant confirmation after command intent is
  already established. Commands typed in the verified Shell tmux pane, sent
  from the human mobile command bar, or dispatched with `,,` now run directly.
  Commands launched by Codex are delegated to Codex's native approval policy,
  so Ask-for-approval can stop before execution while Auto-review or Full
  access can proceed without a second terminal challenge.
- Keep the Supervisor wrapper's fixed endpoint, managed-token, argument
  validation, tier classification, and audit log. Unmarked background callers
  remain broker-guarded, and an environment flag alone cannot impersonate the
  human pane: its pane ID and operating-system session must match the live tmux
  pane. This remains reliable when a command redirects all standard streams.
- Treat choosing **Restart Home Assistant** in the human session picker as the
  confirmation itself instead of asking the human to type `restart` again.

## 2.6.8

- Fix Change Desk and other protected toolbar actions over plain-HTTP Home
  Assistant LAN access. Browsers can omit all three ambient provenance headers
  in that environment: same-origin GET has no Origin, privacy controls can
  suppress Referer, and Fetch Metadata is not guaranteed for an untrustworthy
  `http://homeassistant.local` origin. The UI now adds a fixed request marker
  that the service accepts only after trusted Home Assistant ingress and only
  when no cross-site, Origin, or Referer evidence contradicts it. Bare and
  explicitly cross-site requests remain rejected, and the service still opts
  into no cross-origin access.
- Upgrade the bundled Codex CLI from `0.144.4` to the stable `0.147.0` release.
  The image build remains pinned to that exact package version, and the normal
  and jailed container smoke checks assert the new CLI version.

## 2.6.7

- Stop Codex from fighting its own sandbox inside the add-on. Codex CLI's
  inner sandbox and approval flow cannot see the add-on's real boundaries, so
  sessions stalled on automatic approval reviews that sometimes denied even
  bundled read-only helpers (`ha-site-memory status`, `ha-api`, ...), and
  sandboxed helper runs returned empty output because they need Home Assistant
  API network access and `/data` state. Startup now sets
  `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` in the
  persistent Codex config on every boot. The container remains the operating
  boundary — only `/config` and `/data` are mapped, ingress stays admin-only,
  and management-capable `ha` and `supervisor-api` commands still stop at the
  human-answered Supervisor broker challenge. Mall Cop is unchanged; it always
  runs `codex exec` with `--ignore-user-config --sandbox read-only` inside its
  jail. Set the new `codex_full_access: false` option to keep those two keys
  under your own control.

## 2.6.6

- Fix Change Desk failing with "Cross-origin Change Desk access is not
  allowed". The summary endpoint is the add-on's only origin-gated GET, and
  same-origin GET fetches carry no Origin header, so the check depended
  entirely on the Referer surviving the trip — which privacy-focused browsers,
  extensions, and some proxy chains strip. The same-origin check now accepts
  the browser's own Sec-Fetch-Site header (set automatically by all modern
  browsers and unforgeable by page scripts) as first-class proof, and also
  matches Origin/Referer against X-Forwarded-Host so reverse proxies that
  rewrite Host in front of Home Assistant keep working. Requests a browser
  labels cross-site are now rejected even when other headers look right.

## 2.6.5

- Stop a terminal left open on a second device from shrinking the view on the
  device in use. Every browser attaches its own terminal client and tmux sizes
  the single shared window to whichever client acted last, so an idle phone
  tab could pin the desktop to phone width. A backgrounded tab now releases its
  terminal client once at least one other device is still attached, and
  reattaches when shown again, so the visible device drives the size. A lone
  device never releases, so single-device use never reloads on return. tmux is
  also pinned to `window-size latest` so the most recently used client wins
  when two are visible at once. Adds a `GET /terminal-clients` count endpoint
  behind the existing ingress guard.

## 2.6.4

- Fix mobile touch scrolling. Finger drags previously posted one full-page
  tmux jump to the server per 54 pixels of travel, serialized behind HTTP
  round-trips — quantized, laggy, and error-prone. Drags now synthesize local
  mouse-wheel input that xterm forwards to tmux as wheel reports (or applies
  to its own scrollback when no application mouse mode is active), so content
  tracks the finger line-by-line with no network traffic. The PgUp/PgDn/Bottom
  keys and the keyboard-open return-to-prompt behavior are unchanged.
- Reclaim vertical space on phones: the title row is hidden on touch layouts,
  header buttons share one row instead of two, and an empty status line no
  longer reserves its own row — roughly 80 more pixels of terminal. Shorten
  the mobile input placeholders that clipped mid-word, remove the
  permanently hidden floating scroll buttons, and size the app against
  dynamic-viewport units so the layout stays correct while the mobile URL
  bar collapses.

## 2.6.3

- Fix copy-on-highlight failing for careful selections. Browsers only permit
  clipboard writes for ~5 seconds after mousedown and a mouse release never
  renews that permission, so any drag longer than that reached mouseup with
  every clipboard API blocked and popped the manual-copy dialog. Failed copies
  are now staged and complete silently on the next click or keystroke, which
  carries fresh permission; the status bar shows the pending state and still
  offers the manual dialog on demand.
- Also try the embedding page's Clipboard API when the terminal frame's write
  is denied, keep keyboard focus in the terminal after every copy instead of
  dropping it on the page body, accept tmux OSC 52 copies triggered from
  copy-mode keyboard bindings (for example vi-mode `y`), extend the OSC 52
  acceptance window to survive slow drags, and stop canceling drag tracking
  when the pointer merely crosses element boundaries inside the terminal.

## 2.6.2

- Fix copy-on-highlight inside Home Assistant ingress, where the outer add-on
  iframe does not delegate `clipboard-write`. The terminal now keeps the
  gesture in the ttyd frame and uses a synchronous native copy event when the
  standard Clipboard API is blocked, while rejecting legacy false-success
  reports that did not update the system clipboard.
- Stop a stale persisted `codex-security` MCP launch path from producing a
  startup warning in the Home Assistant runtime. The startup guard disables
  only that plugin transport and preserves the Codex Security skills.

## 2.6.1

- Fix copy-on-highlight falsely reporting success without changing the browser
  clipboard. Terminal selections now start the standard Clipboard API during
  the mouse or touch gesture before using the synchronous Safari fallback.

## 2.6.0

- Upgrade the bundled Codex CLI from `0.134.0` to `0.144.4`, keep the image
  build pinned to that exact package version, and assert the same version in
  the jailed container smoke test.
- Stop the unauthenticated legacy GitHub MCP transport from starting when
  `GITHUB_PAT_TOKEN` is absent, while preserving the GitHub plugin and the
  independently authenticated `gh` CLI. Re-apply that policy before every
  Codex launch and redact GitHub token shapes from terminal transcripts.
- Repair terminal selection copying across mouse, touch, Unicode, wrapped text,
  OSC 52, delayed ttyd initialization, and blocked clipboard APIs. Failed
  automatic copies now expose an explicit manual **Copy selection** fallback.
- Restrict the web service to Home Assistant's authenticated ingress peer,
  require same-origin browser requests and WebSocket upgrades, remove direct
  host port publication, and reject uploads before multipart parsing.
- Bound upload size/count, randomize stored filenames, serialize raw-shell
  commands, recover timed-out tmux panes before advancing the queue, and make
  monitor history tolerant of individual malformed records.
- Run Mall Cop as an ephemeral, optional-tool-disabled, config-free summary
  process under an unprivileged UID in a minimal chroot jail that contains
  neither `/config` nor `/data`. Keep its environment scrubbed, quote untrusted
  Home Assistant observations, and persist memory atomically with private modes.
- Close Supervisor and WebSocket guardrail bypasses: callers can no longer
  override curl URLs/options or WebSocket request identity, and service/state
  writes now require the human authorization lane.
- Remove the spoofable Shell/`,,` broker bypass. The prefix still dispatches to
  the interactive Shell pane, but management commands now require the visible
  broker challenge from every surface.
- Supervise ttyd, the image service, the SSH status bridge, and `ha-monitor`
  from PID 1 so any required-child failure causes a clean add-on restart instead
  of leaving a half-working interface.
- Restore persistent APK packages from a validated manifest with complete
  Alpine dependency metadata; preserve requested Python requirements across
  interpreter/ABI rebuilds; reject option-shaped package input; and keep
  persistent executables behind the guarded Home Assistant CLI on `PATH`.
- Deduplicate unchanged `ha-monitor` log tails, fix health-check aggregation,
  serialize the monitor's full read/build/save cycle, and recursively redact
  GitHub PAT/JWT values before state, history, or dispatch publication.
- Restrict the shared `/config` SSH mailbox to read-limited status only, and
  use dirfd/`O_NOFOLLOW` plus atomic replacement for managed `/config` files so
  pre-created symlinks cannot redirect startup writes.
- Parse Change Desk command JSON before redacting human-facing output, bound
  Supervisor connect/overall timeouts, cap Modbus requests at protocol limits,
  and serialize all Codex TOML mutators under one validated atomic lock.
- Pin the Home Assistant base image, Home Assistant CLI, and GitHub CLI to
  explicit versions and SHA-256 checksums; add immutable-action GitHub CI for
  syntax, tests, audits, and amd64/arm64 container builds.
- Fix overly broad solar `ct` matching and redact credential-bearing audit
  lines; reject mismatched Modicon reference types and out-of-range read spans.
- Stop tracking local Claude worktrees, ignore generated Python bytecode, and
  repair the example add-on options file as valid JSON.

## 2.5.10

- Explicitly disable the known HeyGen Codex plugin IDs in
  `/data/.codex/config.toml` before Codex starts, so the remote plugin sync
  cannot rehydrate HeyGen 3.0.0 and trip the skill description validator.
- Keep the existing HeyGen cache/source pruning in place and run the same
  disable-and-prune guard before manual Codex launches.

## 2.5.9

- Persist Mall Cop observations under `/data/monitor/change-desk-mall-cop-memory.json`
  so new runs can compare current Home Assistant issues with the previous Mall
  Cop memory and call out new, resolved, changed, and unchanged conditions.
- Run Mall Cop automatically when Change Desk opens, gated to once every 24
  hours, while keeping the footer **Ask Mall Cop** button as a manual forced run.
- Keep the latest Mall Cop summary visible in Change Desk after refresh/open and
  scroll to the report after a button-triggered run.

## 2.5.8

- Remove persisted HeyGen Codex plugin source mirrors and cache copies before
  Codex starts, and route Codex launches through a guard wrapper so the broken
  HeyGen skill metadata cannot keep resurfacing from `/data/.codex`.
- Stop startup diagnostics and health checks from running `codex --version`,
  avoiding an unnecessary Codex process that can hydrate plugin cache during
  add-on startup.

## 2.5.7

- Add a `/config` mailbox bridge so the ordinary Home Assistant SSH add-on can
  run `codex-terminal-pro-attach status`, `send`, `capture`, `transcript`,
  `logs`, and `ask-file` without Docker access.
- Keep Docker/host access only for true interactive attach, direct shell, and
  container-name discovery.

## 2.5.6

- Remove the persisted HeyGen Codex plugin cache during startup instead of
  trying to repair its oversized skill descriptions. HeyGen is not part of the
  Home Assistant add-on workflow, and removing that cache prevents repeated
  Codex skill-loader warnings.

## 2.5.5

- Write `/config/codex-terminal-pro-attach` on startup so a Home Assistant SSH
  or host shell with Docker access can attach to the live Codex Terminal Pro
  tmux session without exposing a second SSH server from the add-on.
- Add helper subcommands for tmux attach, `/config` shell, direct prompt send,
  tmux pane capture, transcript tailing, file-backed Codex requests, status, and
  container-name discovery.

## 2.5.4

- Clean up the Change Desk Mall Cop report display: avoid repeating the
  **Mall Cop: To Observe and Report** title and render basic Markdown emphasis
  and inline code styling in the panel.
- Ask the on-demand Mall Cop prompt to return section content only, since the
  UI already labels the report.

## 2.5.3

- Add an on-demand **Mall Cop: To Observe and Report** flow in Change Desk.
  The panel now groups persistent monitor findings into chronic conditions,
  then runs `codex exec` in read-only mode only when the user clicks
  **Ask Mall Cop**.
- Render the returned Mall Cop summary back inside Change Desk and include the
  chronic condition ledger in copied reports.

## 2.5.2

- Repair cached HeyGen skill metadata during startup so persisted plugin
  descriptions that exceed Codex CLI limits do not keep producing skill-loader
  warnings.
- Redact privacy-sensitive live state values such as precise location, SSID,
  BSSID, IP, phone, SIM, and serial-like fields from generated `ha-site-memory`
  Markdown and JSON while preserving the entity IDs and mappings.

## 2.5.1

- Put Change Desk recommendations directly under the summary metrics so the
  action list appears before detailed audit, monitor, log, and live sections.
- Add an explicit **Mall cop** status metric and HA Monitor line showing whether
  the read-only observer is on patrol, stale, or unavailable.
- Include the Mall cop status near the top of copied and staged Change Desk
  reports.

## 2.5.0

- Add deterministic issue triage to `ha-monitor` so repeated Modbus, Wi-Fi,
  socket, timeout, and unavailable-entity noise is labeled as localized
  connectivity trouble instead of treated like a Home Assistant config blocker.
- Keep safety/security/critical-looking entities out of the benign-noise bucket
  until a human confirms priority, and keep true config/system blockers as
  review-before-reload findings.
- Surface triage posture, issue labels, and deterministic low-risk budget gates
  in Change Desk, staged reports, monitor history, and dispatch packets.

## 2.4.0

- Add deterministic Change Desk dispatch packets to `ha-monitor`, written under
  `/data/monitor/change-desk-dispatch.json` alongside the existing monitor state.
- Track compact deltas between monitor samples: new issues, resolved issues,
  newly persistent issues, status changes, and cheap config fingerprints.
- Add reasoning budget gate metadata without making autonomous LLM calls: no
  call when there is no meaningful delta, hourly/cooldown defaults, a scheduled
  daily cap, and high reasoning marked as explicit-user-action only.
- Surface the prepared dispatch packet and budget gate in Change Desk and include
  them in staged Send Report prompts.

## 2.3.0

- Add `ha-site-memory`, a read-only Home Assistant site-memory helper that builds
  `/data/monitor/ha-site-memory.md` and JSON from local registries and live
  states.
- Refresh site memory during add-on startup before writing the Codex briefing, so
  fresh Codex sessions can resolve house-specific phrases such as "Ring lights"
  to likely entity IDs before broad triage.
- Include optional human-maintained notes from `/config/HA_SITE_NOTES.md` in the
  generated site memory when present.
- Teach the runtime briefing, managed AGENTS guidance, docs, and field guide to
  use site memory as a map while still verifying exact live state with `ha-api`
  or `ha-ws` before changes.

## 2.2.5

- Add a colored raw Shell prompt so command entry is visually distinct from
  command output.
- Punch up the Shell-mode light palette and terminal inversion filter for
  stronger contrast and less washed-out output.

## 2.2.4

- Give Shell mode its own light, inverted terminal aesthetic instead of reusing
  the dark Codex wrapper colors.
- Invert the embedded ttyd/xterm frame in Shell mode so the terminal surface
  visibly matches the selected light shell theme.

## 2.2.3

- Keep prompt paste inert: pasted `,,` shell-dispatch text no longer executes
  just because the clipboard carried a trailing newline.
- Strip trailing line breaks from toolbar/manual prompt paste before inserting
  text into the terminal; the user must press Enter to run it.

## 2.2.2

- Stage full Change Desk reports under `/data/monitor/reports` before sending
  them to Codex, then insert only the report path and review instructions into
  the terminal so large monitor snapshots do not exceed paste limits.
- Strip Home Assistant ANSI color codes from Change Desk and HA monitor issue
  samples before display, copy, and report staging.

## 2.2.1

- Rename the Change Desk **Ask Codex** action to **Send Report** so it better
  describes inserting the report into the Codex prompt.
- Remove the visible paste/drop image hint from the header; image paste and
  drag/drop support remain available without a button-like affordance.

## 2.2.0

- Add `ha-monitor`, a bounded read-only Home Assistant observer that runs in the
  background, fingerprints recent `ha core logs` warnings/errors, samples
  unavailable or unknown states through `ha-api`, records MCP status, and writes
  `/data/monitor/ha-monitor.json`.
- Surface persistent HA monitor findings in Change Desk alongside YAML audit,
  core check, recent logs, live API, and MCP status.
- Add add-on options for monitor enablement, sample interval, log-line cap,
  state/MCP scans, and retained issue count.
- Reserve `/data/monitor/tasks.d` for a future bespoke persistent-task design,
  but intentionally ignore task manifests in this safe observer release.

## 2.1.1

- Remove the local git working-tree probe from Change Desk so the panel stays
  focused on Home Assistant validation instead of reporting `/config` as "not a
  git repository."
- Add a Recent Logs section to Change Desk that reads `ha core logs`, counts
  recent errors and warnings, and highlights repeated log signatures.
- Remove the Voice Input toolbar and modal because browser speech recognition
  is not reliable in the target Home Assistant browsers.
- Replace the Upload Image toolbar button with a compact paste/drop image hint;
  image upload still works through paste and drag/drop.

## 2.1.0

- Add a read-only **Change Desk** panel to the web terminal wrapper. It collects
  Home Assistant YAML audit results, `ha core check`, recent logs, live REST
  config reachability, and MCP Server status in one review surface.
- Let the Change Desk copy its summary or insert a Codex review prompt without
  applying changes, reloading YAML, or restarting Home Assistant.
- Redact common token patterns from Change Desk command output and cap captured
  output sizes for safer browser display.
- Skip `.claude` scratch/worktree directories during `ha-toolbox` config audits
  so review snapshots stay focused on Home Assistant files.

## 2.0.3

- Preserve existing Codex TUI `status_line` preferences on startup instead of
  replacing them during add-on updates.
- Sanitize only Codex CLI `0.134.0` strings that are valid permission concepts
  but unsupported as `[tui].status_line` item IDs (`auto-review`,
  `permissions`, and `approval-mode`) so startup stays clean without
  clobbering the rest of the user's footer.
- Remove `auto-review` from the fresh-install managed footer default because
  the pinned CLI does not accept it as a `[tui].status_line` item.
- Keep `fast-mode` in the fresh-install managed footer default because it is
  the separate, supported footer item for showing Fast mode state.

## 2.0.2

- Pin the bundled Codex CLI to `@openai/codex@0.134.0` in the Docker build so
  the add-on release, not an in-container self-update prompt, controls the
  installed CLI version.
- Print `codex --version` during the Docker build so a bad or unexpected CLI
  package version fails visibly while building the add-on image.

## 2.0.1

- Disable the upstream Codex CLI startup update prompt inside the add-on
  container. Codex CLI updates should arrive through Codex Terminal Pro image
  releases instead of temporary `npm install -g @openai/codex` changes inside a
  running container.
- Keep managed Codex config values at the top level of
  `/data/.codex/config.toml`, even when a user already has TOML tables such as
  `[tui]`.
- Restore the managed Codex footer to the operational HUD: run state,
  model/reasoning/Fast mode, context remaining, auto-review, 5-hour limit, and
  weekly limit.

## 2.0

- Add `ha-api`, a read-only Home Assistant Core REST helper for exact live
  config, state, service schema, event, and MCP Server status lookups.
- Add `ha-ws`, a read-only Home Assistant WebSocket helper for live state
  summaries, entity registry display, exposed-entity checks, target expansion,
  applicable service/trigger/condition discovery, and automation
  trigger/condition/action validation.
- Add `ha-mcp-status` to quickly detect whether Home Assistant's official MCP
  Server integration is loaded and to show the internal and external MCP
  endpoint paths.
- Teach the installed briefing, managed AGENTS guidance, startup diagnostics,
  Docker image, and toolbox inventory about the new HA API/WebSocket/MCP helper
  layer.

## 1.46

- Preserve logical command lines when copying mouse- or touch-dragged terminal
  selections across soft-wrapped xterm rows, so wrapped commands paste back as
  a single line.

## 1.45

- Harden `,,` shell dispatch against duplicate browser event fanout by locking
  each tracked prompt line to one text source.
- Repair clearly duplicated dispatch commands such as `,,,,hhaa ccoorer ...`
  before sending them to the raw Shell pane, but only when the repaired command
  resolves to an executable.
- Extend the raw Shell fallback so a prefixed command that reaches Bash with
  duplicated text can still recover the full command line.

## 1.44

- Restrict direct terminal `,,` interception to Codex mode and add duplicate
  event filtering so browser key-event fanout cannot poison the dispatch buffer.
- Add a trusted raw Shell profile fallback so `,,ha ...` and `,, ha ...` typed
  into Bash execute as human shell commands instead of returning
  `command not found`.
- Recover prefixed raw-shell commands from duplicated-key command names such as
  `,,hhaa` when the collapsed command exists.

## 1.43

- Redirect direct top-level `/terminal/` loads back to the Codex Terminal Pro
  wrapper while keeping the embedded ttyd iframe working.
- Mark the wrapper iframe's ttyd URL as embedded so Home Assistant or browser
  history cannot strand users on raw ttyd without upload controls, mobile input,
  or `,,` shell dispatch interception.

## 1.42

- Move Codex Terminal Pro to the 1.x release line for the Home Assistant-native
  toolbox release.
- Add `ha-toolbox`, a read-only Home Assistant command for local field guidance,
  config audits, live state summaries, service summaries, and helper inventory.
- Add `/opt/home-assistant/HA.md`, a bundled Home Assistant field guide covering
  YAML, automations, scripts, scenes, helpers, templates, dashboards, entity and
  device registries, add-ons, Supervisor, recorder/statistics, MQTT, Zigbee,
  Z-Wave JS, Matter, ESPHome, mobile app, HomeKit, and Energy work.
- Bundle common Home Assistant admin utilities: `sqlite3`, MQTT clients,
  DNS/network tools, OpenSSL, OpenSSH client, and `rsync`.
- Teach the runtime briefing and installed agent guidance to use `ha-toolbox`
  and `/opt/home-assistant/HA.md` before broad Home Assistant changes.

## 0.1.41

- Add `codex-terminal-briefing`, a local environment briefing command that
  lists Codex Terminal Pro behaviors, safety rules, Home Assistant helpers,
  shell dispatch, solar/Modbus tools, and useful paths.
- Write the same briefing to `/config/CODEX_TERMINAL_PRO.md` on startup so
  Codex and the human have a stable add-on feature map to inspect.
- Strengthen installed agent guidance to run the briefing before guessing about
  available tools or wrapper behavior.
- Show the briefing path in the terminal startup banner.

## 0.1.40

- Attach an xterm.js custom key handler so typed `,,` shell-dispatch commands
  are intercepted before ttyd sends Enter to Codex.
- Serve the wrapper UI with `Cache-Control: no-store` so Home Assistant reloads
  pick up frontend fixes instead of leaving a stale shell-dispatch script in
  the browser.
- Teach the Supervisor broker to recognize a recent exact `,,ha ...` or
  `,, supervisor-api ...` prompt in the live Codex tmux pane as the human's
  shell-dispatch intent if browser interception and agent guidance both miss.
- Export the Codex tmux target into the launched session so brokered commands
  can verify the prompt that authorized them.
- Add an expert broker option to disable recent `,,` prompt authorization while
  keeping the default workflow smooth for human-typed shell dispatches.

## 0.1.39

- Harden `,,` dispatch capture inside the ttyd iframe by tracking paste and
  `beforeinput` events in addition to keydown.
- Add `codex-shell-dispatch` as a fallback helper so Codex can route a human
  `,,` prompt through the same Shell-pane dispatch path if browser interception
  misses it.
- Update installed agent guidance and add an idempotent managed block to an
  existing `/config/AGENTS.md` so Codex learns the add-on tools and `,,`
  behavior without replacing user guidance.

## 0.1.38

- Run `,,` shell dispatches in the hidden Shell pane without switching away from
  Codex when the command completes quickly.
- Capture command output and show it back in the Codex view with copy/dismiss
  controls. Long-running commands still fall back to Shell mode so the user can
  interact with them.

## 0.1.37

- Change `,,` from a mode toggle into a shell dispatch prefix: `,, ha store
  reload` and `,,ha store reload` send `ha store reload` directly to the Shell
  pane and switch the display there.
- Mark the Shell pane as a trusted human shell so brokered `ha` and
  `supervisor-api` commands typed there, or dispatched there with `,,`, do not
  require a second confirmation. Codex/non-interactive operations remain
  broker guarded.

## 0.1.36

- Replace the `!` shell escape with an exact `,,` prompt-line escape because
  Codex already owns `!command` for local shell commands.
- Support `,,` from both the mobile command bar and direct terminal typing:
  Codex mode switches to Shell mode, and Shell mode switches back to Codex.

## 0.1.35

- Treat a command-bar input of `!` in Codex mode as a shell escape: it switches
  to the interactive Shell tmux window instead of sending `!` to Codex.
- Update the Codex-mode command placeholder to advertise `! for shell`.

## 0.1.34

- Add a tmux-backed **Shell** mode that switches the embedded terminal from the
  Codex TUI window to a real `/config` login shell window.
- Keep mobile command-bar input, paste, upload paths, and terminal controls
  pointed at the active tmux window, so Shell mode receives real shell commands.
- Preserve Supervisor broker safety: restart, stop, update, install, uninstall,
  reboot, shutdown, backup, and OS operations still require the human to type
  the broker confirmation inside the terminal.

## 0.1.33

- Add a mobile-native command bar below the ttyd terminal so phones and tablets
  type into a real browser textarea while ttyd remains the live display.
- Add mobile shortcut keys for Ctrl-C, Ctrl-D, Ctrl-Z, Tab, Enter, command
  history, clear, tmux page up/down, and return-to-prompt controls.
- Route mobile clipboard text, manual paste, uploaded image paths, and voice
  transcripts into the native command bar instead of refocusing the iframe.

## 0.1.32

- Add a read-only `solar-toolbox` command for solar commissioning intake,
  Home Assistant energy/entity audits, common gateway TCP discovery, vendor and
  protocol recognition notes, and pre-change restore capture planning.
- Add `/opt/solar/SOLAR.md` with a domestic and small-commercial solar
  diagnostics field guide covering Modbus, SunSpec, MQTT, Home Assistant Energy
  metadata, battery/BMS readiness, meter/CT placement, and safety boundaries.
- Teach the in-add-on agent guidance to start solar work from topology,
  preserve-state, and read-only proof surfaces before any installer-facing
  configuration changes.

## 0.1.31

- Improve mobile terminal layout when the on-screen keyboard opens by sizing
  the wrapper to the visible viewport and keeping manual paste/copy panels above
  the keyboard.
- Add touch-swipe terminal scrolling that routes through the same tmux
  scrollback controls as the mobile scroll buttons.
- Return the tmux pane to the live prompt before browser paste, manual paste,
  or uploaded-image insertion so pasted text lands on the command line after
  scrollback or selection use.

## 0.1.30

- Hide the mobile-only Select Text and Paste controls on desktop layouts while
  keeping them visible on phone-sized and touch-oriented browser layouts.

## 0.1.29

- Fix the background health-check logger so missing bashio shell functions do
  not make otherwise successful checks report as failed.

## 0.1.28

- Stop showing the manual "Copy failed" panel after mobile Select Text when
  the terminal selection itself succeeded but the browser clipboard API is
  unavailable.
- Add a Paste button that reads text or images from the browser clipboard when
  allowed, with a manual paste fallback for mobile browsers that block
  clipboard reads.
- Add mobile terminal scroll controls for page-up, page-down, and return to the
  live prompt through tightly allowed tmux control actions.

## 0.1.27

- Add a read-only Modbus toolbox for Home Assistant and Schneider Electric
  debugging workflows.
- Install `pymodbus[serial]`, `minimalmodbus`, `pyserial`, `nmap-ncat`,
  `socat`, `tcpdump`, and `libmodbus` in the add-on image.
- Add `modbus-toolbox`, `modbus-scan`, and `modbus-read` helper commands.
- Document Schneider-safe read patterns, address-base handling, and why Modbus
  write helpers are intentionally not bundled.

## 0.1.26

- Stop showing the manual-copy fallback panel for normal desktop terminal
  highlighting when a secondary clipboard attempt reports a false failure.
- Keep the manual-copy panel for explicit copy actions and touch-select
  fallback cases.

## 0.1.25

- Install Alpine's `ripgrep` package so Codex and shell workflows can use
  `rg` inside the add-on.
- Add `rg` path and version to startup diagnostics.

## 0.1.24

- Add a Supervisor broker guardrail for Home Assistant management commands.
  Read-only checks remain frictionless, routine management actions require a
  typed confirmation, and high-risk host/OS/backup/add-on operations require a
  fresh nonce plus reason.
- Store broker decisions in `/data/logs/supervisor-broker.log` with restrictive
  permissions.
- Move the default interactive path toward brokered `ha` and `supervisor-api`
  helpers while documenting that this is a guardrail, not containment.
- Preserve any existing `/config/AGENTS.md`; write add-on guidance to
  `/config/AGENTS.codex-terminal-pro.md` when needed.

## 0.1.23

- Improve iOS and mobile clipboard fallbacks for terminal selections, uploaded
  paths, and voice transcripts.
- Add a visible manual-copy panel when browser clipboard APIs are unavailable.
- Keep touch-device **Select Text** mode as the reliable mobile terminal
  selection path.

## 0.1.22

- Harden `/terminal-input` against cross-origin browser calls and control
  characters.
- Bind ttyd to `127.0.0.1`; ingress continues to use the local Express proxy.
- Validate uploaded image contents with lightweight signature checks and reject
  invalid renamed files.
- Add non-breaking security headers and tighten persistent package argument
  handling.

## 0.1.21

- Make tmux scrollback configurable with a lower default history limit.
- Rewrite transcript rotation to avoid a file-size `stat` call on every output
  line.
- Apply best-effort redaction for common token patterns in terminal transcripts.
- Remove stale frontend auto-paste/key-event fallback paths so image insertion
  continues through the tmux-backed `/terminal-input` endpoint.

## 0.1.20

- Reduce Codex TUI redraw noise by trimming the managed status line back to
  low-cost essentials: run state, model, context remaining, directory, and git
  branch.
- Remove the managed terminal-title override to avoid extra title/redraw churn.
- Make image `beforeinput` paste handling return immediately for normal typing.
- Replace the fixed 3-second image-service startup wait with a fast health poll.

## 0.1.19

- Add a mobile-visible **Select Text** mode for the embedded terminal.
- In select mode, touch-drag maps the finger range to xterm buffer cells,
  visually selects the terminal range, and copies the selected text on release.
- Keep normal terminal touch input unchanged until Select Text mode is enabled.

## 0.1.18

- Capture image paste events inside the embedded ttyd terminal iframe so
  pasting an image at the Codex prompt uploads it and inserts the saved path.
- Handle image paste from `paste` and `beforeinput` events for better mobile
  browser compatibility.
- Support multiple selected, dropped, or pasted images and accept common iOS
  photo formats (`HEIC`/`HEIF`) in addition to JPEG, PNG, GIF, WebP, and SVG.

## 0.1.17

- Remove `permissions` and `approval-mode` from the managed Codex TUI status
  line because Codex `0.130.0` rejects those item IDs.
- Automatically upgrade managed `0.1.15` and `0.1.16` TUI blocks that contain
  unsupported status-line items.

## 0.1.16

- Remove the duplicate context-used field from the managed Codex TUI status
  line, leaving the clearer context-remaining readout.
- Automatically upgrade the exact `0.1.15` managed TUI block while preserving
  user-customized `[tui]` configuration.

## 0.1.15

- Expand the managed Codex TUI defaults into a fuller status HUD with
  Catppuccin Mocha theme colors, run state, task progress, context used and
  remaining, 5-hour and weekly limits, git/branch metadata, permissions,
  approval mode, and Codex version.
- Add a terminal title default with activity, project, branch, and model
  metadata.
- Automatically upgrade the exact `0.1.14` managed footer block while leaving
  user-customized `[tui]` configuration untouched.

## 0.1.14

- Restyle the Home Assistant ingress wrapper with a warmer terminal-focused
  Codex interface while preserving the existing ttyd, tmux, image upload, and
  voice input behavior.
- Add a supported Codex TUI footer default for fresh `/data/.codex/config.toml`
  files showing model, context remaining, working directory, and git branch.
- Leave any existing Codex `[tui]` configuration untouched.

## 0.1.13

- Rotate the persistent terminal transcript instead of appending forever.
- Tighten Codex, GitHub CLI, and XDG state directory permissions under `/data`.
- Remove the unused Home Assistant Auth API permission.
- Pin image-service dependencies with a lockfile and install them with `npm ci`.
- Add uploaded-image retention cleanup while keeping drag/drop upload behavior.
- Start health checks in the background so the terminal opens faster.

## 0.1.12

- Install Alpine's `bubblewrap` package so Codex finds `bwrap` on `PATH`
  instead of warning and falling back to its bundled helper.
- Log `bwrap` path and version in startup diagnostics.

## 0.1.11

- Copy mouse-dragged terminal text by reading the visible xterm buffer cells
  under the drag range, avoiding stale tmux copy-mode output.
- Keep tmux mouse scrolling enabled without forcing tmux copy mode on every
  drag.

## 0.1.10

- Start tmux copy mode on mouse drag so terminal selections have real text to
  send through OSC 52.
- Stop reporting browser copy success when ttyd's native copy handler returns
  true without selected text.

## 0.1.9

- Trigger ttyd/xterm's native copy handler directly on mouse release so Firefox
  sees selection copy as a user-initiated action.
- Keep the wrapper text-copy fallback, but avoid stealing the terminal
  selection before ttyd has a chance to copy it.

## 0.1.8

- Route tmux mouse selections through OSC 52 clipboard support so selecting text
  in the persistent tmux session can reach the browser clipboard.
- Add a small OSC 52 clipboard bridge in the wrapper for ttyd/xterm clipboard
  sequences.

## 0.1.7

- Read highlighted text from ttyd's xterm terminal API before falling back to
  browser selection, so copy-on-select works inside the embedded terminal.
- Enable xterm's macOS Option-drag selection escape hatch for tmux mouse mode.

## 0.1.6

- Insert uploaded image paths directly into the persistent Codex terminal
  prompt using `tmux send-keys`.
- Forward image drops over the embedded terminal iframe to the upload flow.

## 0.1.5

- Copy highlighted terminal text to the browser clipboard when selection
  finishes inside the embedded terminal.

## 0.1.4

- Enable tmux mouse mode so mouse wheel scrolling enters terminal scrollback
  instead of sending up/down history keys to Codex.
- Increase tmux scrollback history to 200,000 lines.
- Save terminal output to `/data/logs/codex-terminal.log` with restrictive
  permissions for debugging warnings that have scrolled off screen.

## 0.1.3

- Run the interactive Codex terminal inside a persistent `tmux` session.
- Reattach to the same terminal session after browser tab switches, websocket
  drops, page refreshes, or Home Assistant ingress reconnects.

## 0.1.2

- Default new installs to auto-launch Codex when the terminal opens.
- Route ttyd websocket upgrades explicitly through the image-service ingress
  proxy so the terminal can work without publishing host port `7681`.
- Normalize Home Assistant ingress paths so the terminal iframe does not request
  `//terminal/`.

## 0.1.1

- Make the Home Assistant sidebar ingress panel explicit.
- Enable ingress streaming for the embedded terminal path.
- Document that the sidebar entry is admin-only because the terminal can edit
  Home Assistant configuration.

## 0.1.0

Initial Codex Terminal Pro MVP fork.

- Renamed the add-on to **Codex Terminal Pro** with slug
  `codex_terminal_pro`.
- Replaced the upstream runtime layer with OpenAI Codex CLI installed by
  `npm install -g @openai/codex`.
- Added persistent Codex state under `/data/.codex`.
- Forced Codex file credential storage with
  `cli_auth_credentials_store = "file"`.
- Added `codex-auth-helper` with device-code login and fallback auth import
  guidance.
- Added a seven-item session picker focused on Codex and Home Assistant safety
  workflows.
- Preserved Home Assistant ingress, ttyd reconnect behavior, image paste,
  persistent package helpers, Home Assistant CLI, GitHub CLI, and `/config`
  access.
- Replaced upstream add-on icon and logo PNGs with Codex icon assets.
- Dropped `armv7` from MVP architecture support pending Codex verification.
- Switched the Dockerfile to an explicit Home Assistant base image instead of
  relying on a `BUILD_FROM` default.

## Fork History

This project is an MIT-licensed fork of the Home Assistant terminal add-on work
by Tom Cassady and an enhanced ESJavadex Home Assistant terminal fork. Historical
runtime details from those upstream projects are intentionally not repeated here
because this fork now targets OpenAI Codex CLI.
