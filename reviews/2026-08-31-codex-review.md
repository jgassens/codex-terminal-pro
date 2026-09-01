# Codex review and repair report

Date: 2026-08-31

Reviewed base: `main` at `bb625dfe73c5eb966f1f207c06dfbf5b1c8c962d`
(Release 2.8.2)

Input review: `kimi-findings.md`

Review surface: the complete working-tree diff, repository tests, the pinned
Home Assistant/Alpine image, a locally built ARM64 container, and one fresh
post-patch bypass review

## Bottom line

Kimi's review was valuable. Twelve of its fourteen major findings were
confirmed or confirmed in their actionable part. Two were disproved against the
actual shipped container:

- Alpine in this image successfully loads `libc.so.6`; consultant startup was
  not dead on musl.
- The Home Assistant base image runs s6 `/init` as PID 1; `run.sh` is not PID 1
  and does not have the claimed PID-1 signal behavior.

Every confirmed, source-fixable finding in Kimi's report has been repaired. The
independent sweep also found and repaired additional isolation, OAuth, image
decoding, subprocess-boundedness, configuration-integrity, and packaging
problems. Mall Cop no longer launches an AI model at all, consultants no longer
have access to the live `/config` or `/data` trees, and terminal control is no
longer reachable over container loopback.

The fresh post-patch reviewer found one Medium issue: `POST /settings` could
still bypass the shared subprocess budget. That path was fixed. A final cleanup
search found the same raw helper in consultant setup; it was fixed too. The
regression now starts settings read, settings save, and consultant setup
concurrently and proves that all three share one bounded status subprocess.

No known actionable source finding remains in the reviewed tree. The limits at
the end of this report are verification or fundamental external-coordination
limits, not silently deferred code repairs.

## How the findings were checked

For security claims, I traced the caller-controlled input, enforcement point,
protected operation, identity, filesystem/network boundary, and failure mode.
For correctness claims, I reproduced the affected command or route and added a
test at the narrowest meaningful boundary. Claims about the container were
checked in the final image rather than inferred from macOS behavior.

## Kimi's major findings

| # | Verdict | Final disposition |
|---|---|---|
| 1 | Confirmed | Fixed. The host development service binds to `127.0.0.1`; the development override accepts only an actual loopback peer. Docker-bridge development has a separate explicit switch and documentation requiring a host-loopback port publish. |
| 2 | Confirmed | Fixed. The Supervisor manager token is atomically written to a root-only file and removed from the environment before apk, pip, npm, or other third-party code can execute. |
| 3 | Confirmed | Fixed. The consultant test supplies a fake `claude` executable and no longer depends on a developer-machine installation. Current local suites pass. GitHub Actions itself was not rerun because nothing was pushed. |
| 4 | Refuted in the actual image | No repair was needed. The final Alpine image loads `ctypes.CDLL("libc.so.6")`, and the real consultant Landlock path runs in container smoke. |
| 5 | Confirmed | Eliminated architecturally. Mall Cop is now a deterministic local renderer: it launches no Codex process, copies no credential, sends no prompt to a model, and gives no AI process network access. Its ordinary Home Assistant snapshot collectors still query the local HA surfaces. The obsolete jail/launcher code and tests were removed. |
| 6 | Confirmed | Fixed. Root-executed launch and transcript helpers live under root-only `/run/codex-terminal`, not predictable shared `/tmp` paths. |
| 7 | Refuted in the actual image | No PID-1 patch was needed. Image inspection reports entrypoint `/init`, and container execution shows s6 owns initialization and shutdown. Normal and forced-child-failure shutdown are both covered by smoke tests. |
| 8 | Confirmed | Fixed. Startup has a longer readiness budget and does not report ready until both the image service and private ttyd transport are usable. |
| 9 | Confirmed | Fixed. Authenticated Home Assistant requests made by `ha-site-memory` explicitly disable environment proxy handling. |
| 10 | Confirmed in its actionable parts | Fixed/hardened. Broker configuration is strict-parsed as data and never sourced as shell; resolved tmux targets are written centrally; human routing requires the exact registered pane and process session. Agent/human markers are documented and tested as approval-routing signals, not as a sandbox or privilege boundary. |
| 11 | Confirmed | Fixed. Solar discovery checks network size before expansion, iterates lazily, and applies one cap to the final normalized/deduplicated target set. |
| 12 | Confirmed | Fixed. All three TOML mutators track multiline basic and literal strings before recognizing tables or managed keys. String contents are no longer mistaken for configuration structure. |
| 13 | Confirmed | Fixed. Broad quote-destroying command mutation was removed. The JavaScript path removes only the known repeated `,,` marker; the shell fallback can repair only a duplicated command name while preserving the original argument text. |
| 14 | Confirmed | Fixed. Modbus TCP accepts unit IDs through 255; RTU retains its protocol limit. Documentation and runtime behavior now agree. |

## Kimi's low findings

### Image service

| Finding | Final disposition |
|---|---|
| Rejected paths could log an ingress token | Fixed. Logs emit a shaped route label, never the raw ingress path. |
| OAuth code could be typed into the wrong pane | Fixed. URL, mode, pane, process, code/cancel action, and listener ownership are bound and rechecked. |
| SVG inspection stopped at 4 KiB | Fixed. The complete bounded upload is scanned, including late active content. |
| Image validation used magic bytes only | Fixed. Signature, declared/derived type, metadata limits, and a complete decoder pass must all agree. |
| A planted allowlisted OAuth URL could be trusted | Fixed. The UI requires a matching live login process with trusted ancestry. |
| Cancel escalation had a PID-reuse window | Fixed. PID identity and argv are re-read before escalation. |
| Subprocess-spawning reads were unbounded | Fixed. One process-wide bounded single-flight queue covers consultant status/settings/setup, login scans, Change Desk snapshots, and terminal-client counts. Capacity failures return 429. |

Image input is now limited to the portable, fully tested set: JPEG, PNG, GIF,
WebP, and SVG. Uploads have byte, dimension, decoded-pixel, frame, and queue
limits. MIME contradictions cannot be laundered through a safe extension. HEIC
is deliberately rejected instead of being advertised without a portable
decoder. This matches Sharp's distinction between its
[prebuilt input formats](https://sharp.pixelplumbing.com/install/) and formats
that require a custom global libvips build; the output API likewise does not
offer portable HEIC output in the bundled configuration
([Sharp output formats](https://sharp.pixelplumbing.com/api-output/)).

### Mall Cop and consultants

| Finding | Final disposition |
|---|---|
| Mall Cop runs shared one UID and trusts a launcher environment | Eliminated. Mall Cop has no model subprocess or jail now. |
| Credential copy could truncate on a short read/write | Fixed with bounded complete reads and writes. |
| The consultant sandbox base did not verify ownership | Fixed. Type, ownership, mode, and non-symlink state are enforced. |
| Consultants could read `/config/secrets.yaml` | Fixed at the kernel boundary. A root-owned filtered projection is built, credentials are copied only into a disposable private home, and fail-closed Landlock rules deny the real `/config` and `/data` trees and writes outside that disposable home. Distinct fixed non-login UIDs isolate Claude and Kimi from one another. |

The projection skips known secret-store paths/filenames and sensitive suffixes,
symlinks, hardlinks, binary and oversized files; redacts token/assignment
shapes; and has per-file, total-byte, and file-count caps. Container smoke proves
a real UID-dropped consultant can read a safe projected file but cannot read
`/config/secrets.yaml`, an existing `/data/.supervisor/token`, a world-readable
live `/data` probe, or a projected write target. Separate fixed-UID fixtures
prove Claude and Kimi cannot read one another's private credential files.

### Shell and mailbox scripts

| Finding | Final disposition |
|---|---|
| Supervisor token appeared in curl argv | Fixed. The header is supplied through curl's stdin configuration. |
| A stale SSH bridge lock survived SIGKILL | Fixed with PID-aware recovery and unsafe-lock refusal. |
| Session picker looped on stdin EOF | Fixed; EOF exits both the main and missing-auth prompts. |
| Host-attach inherited a permissive umask | Fixed with `umask 077`. |
| Bridge directory setup followed planted symlinks | Fixed with component, type, owner, mode, and link checks. |
| Poisoned mailbox request directories never aged out | Fixed; invalid entries reach bounded abandoned-entry cleanup. |
| Kimi credential-directory mode was not restored | Fixed with 0700 enforcement after recreation. |
| Bash-only dispatch could fall through under POSIX `sh` | Fixed with a POSIX-safe profile wrapper and separate Bash implementation. |

### Lifecycle and packaging

| Finding | Final disposition |
|---|---|
| Unsupported `GITHUB_PAT_TOKEN` branches and docs | Fixed. Runtime enabling branches and user-facing instructions were removed. Historical config recognition remains only so old managed entries can be disabled safely; token-shaped text remains in redaction/block lists. |
| Duplicated persistent-package startup logic and dead `init` | Fixed. Startup delegates to the package manager's single `auto-install` path; dead setup branches/helpers were removed. |
| `persist-install` help contradicted dispatch | Fixed. |
| Build-only helper shipped in runtime context | Fixed through `.dockerignore`. |
| Version fallback was hand-maintained | Fixed. Runtime reads the copied `config.yaml`, while explicit build/app environment overrides retain precedence. Release contracts cover the machine-readable version surfaces. |

### Home Assistant integration

| Finding | Final disposition |
|---|---|
| `ha-monitor once` always exited zero | Fixed as an explicit contract: ordinary `once` means collection/save success; `--fail-on-problems` makes error/unavailable states nonzero for automation. Tests and docs cover both. |
| Supervisor path normalization was duplicated | Fixed with one shared fail-closed path utility used by API and broker. |
| Broker tmux trust targets could drift | Fixed. `run.sh` publishes the resolved targets in protected broker configuration; the broker strict-validates them. |
| `ha-ws` had no whole-operation timeout | Fixed. Connect and receive now share one finite deadline. |
| `ha-toolbox` leaked root keys from sensitive YAML | Fixed. Sensitive files are excluded from aggregate key output. |

### TOML and JSON mutators

| Finding | Final disposition |
|---|---|
| An external Codex writer could race an advisory lock | Mitigated as far as this repository can enforce it. Every mutator compares the source revision immediately before atomic replacement and refuses a stale write; tests reproduce and preserve an external revision. A writer that ignores this lock can still change the file in the microscopic compare-to-rename interval; eliminating that requires cooperation from the external CLI. |
| Post-read config size was not enforced | Fixed with an actual byte-count check. |
| `codex-config-set` accepted line breaks | Fixed; CR/LF values are rejected. |
| The config TUI missed multiline/literal forms | Fixed with lexical TOML handling and quote-safe serialization. |
| Claude config accepted NaN/Infinity | Fixed with finite-number validation and strict JSON output. |

### Modbus

All six low Modbus findings were fixed: port and serial settings are validated;
timeouts must be positive and finite; the pinned read signature is selected once
instead of retrying an internal `TypeError`; duplicate manual version handling
was removed; IPv6 uses the correct address family; and the host cap applies to
the final deduplicated list, including explicit comma-separated targets.

### Tests, CI, and development tooling

All five findings were fixed: syntax checking is recursive and includes example
scripts; the example and shipped session picker have an exact parity contract;
the development cleanup trap survives until its child exits; the pinned Codex
version is in the release checklist; and the root-only credential/ownership
case is exercised by running all Python tests as root inside the final Alpine
image.

## Additional findings from the Codex sweep

### 1. Root terminal control was reachable over container loopback — fixed

Production ttyd and shell dispatch used loopback TCP. Loopback is shared by
every process in a container, so a UID-dropped consultant could bypass Home
Assistant ingress. Both control surfaces now use sockets under root-only
`/run/codex-terminal`. Tests prove TCP cannot dispatch, the browser proxy can
reach ttyd, and an unprivileged identity cannot connect to either socket.

### 2. Consultant identities and live filesystem access were not isolated — fixed

Claude and Kimi now have distinct fixed non-login users. Each invocation gets a
disposable private home plus a bounded, filtered workspace projection. Landlock
is fail-closed: if the kernel restriction cannot be installed, the consultant
does not run.

### 3. OAuth callback ownership was incomplete — fixed

Callback forwarding now requires same-origin browser provenance; the exact
localhost callback shape and allowed port; the same trusted service user; the
matching live Codex login process and pane; and ownership of the exact IPv4
listener by that process tree. The TCP connection is opened before the final
ownership check and reused afterward, preventing a listener-replacement race.
Tests cover argv spoofing, pane changes, UID mismatch, IPv6/IPv4 owner mismatch,
and port fallback from 1455 to 1457.

### 4. Full image decoding and resource bounds were missing — fixed

Sharp 0.35.4 is pinned and used for complete decode validation. Animated images
are decoded across frames, warning/error handling is strict, and decoder work is
serialized with a bounded queue. Every advertised format is decoded in an
integration test; truncated signature-only files, active SVG, HEIC, MIME/type
contradictions, malformed JSON, and oversized input are rejected.

### 5. Subprocess-heavy reads needed one global budget — fixed

A shared bounded single-flight primitive serializes different read tasks,
coalesces identical concurrent work, caps pending work, expires stale waiters,
and releases correctly after timeout or rejection. The fresh post-patch review
found `POST /settings` outside it; the cleanup search found consultant setup.
Both are now covered by one concurrency regression.

### 6. Further integrity and lifecycle repairs — fixed

The sweep also repaired OAuth listener ownership, config stale-write detection,
private paste buffers, bounded log rotation, complete web/terminal readiness,
process-group cleanup, strict Supervisor broker configuration, Home Assistant
request proxy/timeout behavior, mailbox races, and a production npm advisory.

## Final verification evidence

All results below apply to the final working tree unless a limitation is stated.

| Gate | Result |
|---|---|
| Host Python suite | 214 passed; 1 expected root-only case skipped |
| Python suite as root in final Alpine image | 214 passed; 0 skipped |
| Node image-service suite | 93 passed; 0 failed |
| Exact post-review concurrency regression | Passed; three routes produced one consultant-status subprocess |
| Production dependency audit | `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities |
| YAML | `repository.yaml` and `codex-terminal/config.yaml` parsed with Ruby's safe YAML parser |
| JSON | `config/options.json` parsed successfully |
| Syntax | `run.sh`, recursive shell scripts, and every image-service JavaScript file passed syntax checks |
| Patch hygiene | `git diff --check` passed |
| Final Docker build | Passed on ARM64; image `sha256:a859fbf5be40aad1c02f306014a9849039a5568cda263c646bab44e0dc29da7f` |
| Runtime CLI | `codex-cli 0.147.0` starts in the final image |
| Alpine libc reproduction | `ctypes.CDLL("libc.so.6")` passed in the final image |
| Deterministic Mall Cop | Node integration proved it renders locally without launching Codex or consuming a login |
| Container smoke | Startup, readiness, Landlock consultant isolation, human/Codex broker routing, normal shutdown, and required-child failure all passed |
| Base-image architecture manifest | The pinned index contains both `linux/amd64` and `linux/arm64` manifests |

The cleanup search found only intentional historical, implementation, or
defensive matches. In particular:

- the loopback development variable remains in the loopback-bound harness,
  request-policy implementation, server warning, and tests;
- `GITHUB_PAT_TOKEN` remains in historical release notes, redaction, consultant
  environment blocking, old-managed-config recognition, and regression
  fixtures—not an enabling path;
- the old `/tmp/codex-terminal-launch.sh` name remains only as a process-wrapper
  attribution fixture;
- UID 65534 remains only in negative isolation/ownership tests; and
- the raw consultant-status function is reachable only through its bounded
  wrapper.

## Verification limits and handoff

- The final image was built and exercised on the current ARM64 Docker host.
  The pinned base manifest was verified to contain both supported architectures,
  and CI defines QEMU/Buildx builds for AMD64 and ARM64. A local AMD64 attempt
  could not be completed because this Docker installation has no Buildx; its
  legacy builder cannot honor `--platform` for an indexed base image.
- The add-on was not installed into a live Home Assistant instance, so real
  Supervisor ingress and installed-add-on persistence remain deployment gates.
- GitHub Actions was not rerun because no commit was pushed.
- An external config writer that does not participate in the repository lock
  can still win the tiny interval after the last stale-revision comparison.
  Atomic writes prevent corruption; full serialization requires the external
  writer to cooperate.
- Projection filtering is necessarily heuristic: a semantic secret stored in
  an innocuously named text file and key may survive filtering. The enforceable
  guarantee is that the consultant cannot access the live `/config` or `/data`
  trees and cannot write outside its disposable home.
- HEIC is intentionally rejected; it is not falsely shown as a supported image
  type.
- No commit, tag, release, push, publication, or live installation was made.
- `kimi-findings.md` was left untouched as the original review artifact.
