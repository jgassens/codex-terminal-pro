# Codex Terminal Pro Runtime Guidance

You are running inside the Codex Terminal Pro Home Assistant add-on.

- Work from `/config` unless the human explicitly asks otherwise.
- If you are unsure what tools or behaviors this add-on provides, run
  `codex-terminal-briefing` or read `/config/CODEX_TERMINAL_PRO.md` before
  guessing.
- Use `ha` for Home Assistant CLI work and `supervisor-api` for direct
  Supervisor HTTP work.
- Use `ha-toolbox`, `ha-toolbox audit-config --config /config`,
  `ha-toolbox states`, and `ha-toolbox services` for read-only Home Assistant
  orientation before broad changes.
- Use `ha-api` for exact read-only Home Assistant REST lookups, including
  `ha-api state <entity_id>`, `ha-api services --domain <domain>`, and
  `ha-api mcp-status`.
- Use `ha-ws` for read-only Home Assistant WebSocket discovery and validation:
  `ha-ws entity-registry --pattern <text>`, `ha-ws target-info --entity <id>
  --capabilities`, `ha-ws exposed`, and `ha-ws validate --file <yaml>
  --section action`.
- Use `ha-mcp-status` before assuming Home Assistant's official MCP Server is
  installed or reachable.
- Use `ha-monitor status` to read the add-on's bounded observer summary before
  broad Home Assistant triage. It is read-only: it records logs, unavailable
  state samples, and MCP status under `/data/monitor` but does not reload,
  restart, edit files, run bespoke tasks, or call an LLM by itself.
- Use `/data/monitor/change-desk-dispatch.json` as the prepared Change Desk
  packet when present. It contains deterministic deltas, triage labels, and
  reasoning budget gates; high reasoning should happen only from explicit human
  action such as Change Desk's Ask Mall Cop button.
- Treat monitor findings labeled localized connectivity noise as device,
  Modbus, Wi-Fi, socket, or reachability trouble first, not proof of broken
  Home Assistant configuration. Confirm whether the entity is safety, security,
  or otherwise critical before dismissing it as benign noise.
- Use `ha-site-memory status` or read `/data/monitor/ha-site-memory.md` before
  troubleshooting named rooms, integrations, or house-specific devices such as
  "Ring lights". Treat it as a map of likely entities, then refresh and verify
  exact live state with `ha-api` or `ha-ws` before changing anything. Optional
  human-maintained aliases or recurring fixes may live in `/config/HA_SITE_NOTES.md`.
- The `,,` prefix is Codex Terminal Pro shell dispatch. If the human prompt
  starts with `,,`, strip the prefix and run the rest through
  `codex-shell-dispatch`. Do not run the stripped command directly through
  Codex's normal shell execution path.
  Example: `,, supervisor-api -X POST /core/api/services/automation/reload`
  should become
  `codex-shell-dispatch supervisor-api -X POST /core/api/services/automation/reload`.
- Do not ask for another confirmation before using `codex-shell-dispatch` for a
  `,,` prompt; the prefix is the human's direct shell-dispatch instruction.
- If the terminal is in Shell mode, treat it as a real interactive shell, not a
  Codex permission bypass.
- If the human wants to reach Codex Terminal Pro from Home Assistant SSH, point
  them to `/config/codex-terminal-pro-attach`. In the ordinary Home Assistant
  SSH add-on, `status`, `send`, `capture`, `transcript`, `logs`, and
  `ask-file` work through the `/config` mailbox bridge without Docker access.
  Interactive `attach`, direct `shell`, and `container` discovery still need
  Docker or the Home Assistant OS host shell. For SSH-side readback, `capture`
  and `transcript` can show recent output; `ask-file` is the reliable path
  because it asks Codex to write the answer under `/config`.
- Do not reconstruct or print the Supervisor token.
- Do not read `/data/.supervisor/token` unless you are maintaining the broker.
- Never auto-answer a Supervisor broker challenge if one appears. Stop and
  explain the operation. Human Shell commands may be trusted by the broker and
  run without a second confirmation.
- Treat `/data/.codex/auth.json` and `/data/logs/codex-terminal.log` as
  sensitive files.
- Run `ha core check` before Home Assistant reloads or restarts when practical.
- Use `/opt/home-assistant/HA.md` as the local Home Assistant field guide.
- Search current official Home Assistant documentation or inspect live service
  schemas when integration behavior, service payloads, or Supervisor behavior
  could have changed.

## Solar / Battery / Inverter Work

This add-on is expected to be unusually strong at domestic and small commercial
solar work. Start prepared, then search current official sources when a device,
firmware, standard, or integration behavior is uncertain.

- Use a read-only-first commissioning mindset. Before installer-facing changes,
  preserve Home Assistant config/entity/dashboard context plus vendor settings
  exports and read-only telemetry snapshots when available.
- Classify the site before diagnosing: grid-tied, hybrid, backup-loads,
  whole-home/self-supply, off-grid, or microgrid.
- Identify the layers: inverter, battery/BMS, gateway/logger, production meter,
  service-point import/export meter, CT placement, Home Assistant integration,
  MQTT bridge, Modbus/SunSpec path, vendor cloud, and any utility/aggregator
  control interface.
- Prefer evidence from three surfaces: Home Assistant states/logs, read-only
  local telemetry such as Modbus/SunSpec/MQTT, and the vendor UI or official
  settings export.
- Run `solar-toolbox`, `solar-toolbox audit-ha --config /config`, and
  `solar-toolbox snapshot-plan` when they fit the task.
- Use `modbus-toolbox`, `modbus-scan`, and `modbus-read` for read-only Modbus
  discovery. Verify unit ID, address base, scale factors, and word order before
  trusting decoded values.
- Do not write inverter, charger, relay, export-control, battery chemistry,
  charge-current, grid-support, or transfer settings unless the human
  explicitly asks, the exact register/API is verified, and there is a rollback
  plan.
