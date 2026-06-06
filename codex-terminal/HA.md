# Codex Terminal Pro Home Assistant Field Guide

Codex Terminal Pro is expected to be Home Assistant-native. This guide is the
local operating map for Codex when it works inside `/config`.

## Default Workflow

1. Orient first: run `ha-toolbox`, `ha-toolbox audit-config --config /config`,
   and read the relevant YAML or `.storage` files.
2. Keep secrets private: never print `secrets.yaml`, tokens, browser cookies,
   `/data/.codex/auth.json`, or `/data/.supervisor/token`.
3. Prefer read-only proof surfaces before edits:
   - `ha core check`
   - `ha-toolbox states`
   - `ha-toolbox services`
   - `supervisor-api /core/api/states`
   - `ha apps logs <addon>` or `ha core logs`
   - `ha-monitor status`
   - `ha-site-memory status`
4. Show diffs before editing Home Assistant configuration when practical.
5. Reload the smallest target that matches the change.
6. Restart Core or add-ons only when reloads are not enough or the human asks.

## Core Tools

- `ha`: Home Assistant CLI, routed through the broker.
- `supervisor-api`: direct Supervisor and Home Assistant REST helper.
- `ha-toolbox`: read-only Home Assistant briefing, config audit, states, and
  service discovery helper.
- `ha-site-memory`: read-only local house dictionary for integrations, areas,
  phrase shortcuts, and likely entity IDs.
- `codex-shell-dispatch`: direct human shell dispatch for `,,` commands.
- `jq` and `yq`: JSON/YAML inspection.
- `sqlite3`: recorder database inspection when the DB is safely readable.
- `mosquitto_sub` and `mosquitto_pub`: MQTT diagnostics.
- `dig`, `nslookup`, `ping`, `ncat`, `socat`, `tcpdump`, and `openssl`:
  network, DNS, TLS, port, and packet diagnostics.
- `rg`, `find`, `tree`, `git`, `gh`, `curl`, and `wget`: config search,
  repository work, and API inspection.

## Home Assistant Domains Codex Should Know

- Configuration layout: `configuration.yaml`, packages, includes,
  `automations.yaml`, `scripts.yaml`, `scenes.yaml`, blueprints, `custom_components`,
  `www`, and `.storage`.
- Automation work: triggers, conditions, actions, modes, traces, scripts,
  scenes, helpers, calendars, timers, counters, input booleans, and reloads.
- Template work: template sensors, binary sensors, availability, trigger-based
  templates, statistics, utility meters, and Home Assistant Energy metadata.
- Dashboards: Lovelace YAML/storage dashboards, cards, views, entity names,
  browser/mobile behavior, and dashboard-critical entity triage.
- Integrations: MQTT, ZHA, Zigbee2MQTT, Z-Wave JS, Matter, ESPHome, Shelly,
  mobile_app, HomeKit, Google/Nest, FordPass, weather, media, cameras, and
  vendor cloud bridges.
- Devices and entities: entity registry, device registry, area/floor labels,
  disabled entities, unavailable states, stale diagnostics, and renames.
- Add-ons and Supervisor: install/update/restart/logs/options, store reloads,
  backups, host/network/DNS/audio/OS/Supervisor operations, and broker tiers.
- Recorder/history: SQLite recorder database, statistics tables, long-term
  statistics, Energy dashboard statistics, purges, and corruption triage.
- Networking: local IPs, DNS, mDNS symptoms, TLS certificates, MQTT brokers,
  Modbus gateways, cloud callbacks, and ingress behavior.
- Security: secrets, tokens, long-lived access tokens, add-on roles, backups,
  exposed ports, and remote access implications.

## Common Commands

```bash
ha-toolbox
ha-toolbox audit-config --config /config
ha-toolbox states --domain automation
ha-toolbox states --pattern battery
ha-toolbox services --domain homeassistant
ha core check
ha core logs
ha-monitor status
ha-site-memory status
supervisor-api /core/api/states | jq 'length'
supervisor-api /core/api/services | jq '.[].domain'
sqlite3 /config/home-assistant_v2.db '.tables'
mosquitto_sub -h <broker> -t '#' -v
```

For human-dispatched management commands from Codex mode:

```bash
,,ha store reload
,,ha apps update 0a381758_codex_terminal_pro
,,ha apps restart 0a381758_codex_terminal_pro
```

## Reload Choices

Use the smallest practical reload:

- Automations: `supervisor-api -X POST /core/api/services/automation/reload`
- Scripts: `supervisor-api -X POST /core/api/services/script/reload`
- Scenes: `supervisor-api -X POST /core/api/services/scene/reload`
- Template entities: `supervisor-api -X POST /core/api/services/template/reload`
- Groups: `supervisor-api -X POST /core/api/services/group/reload`
- Input booleans, numbers, selects, helpers: use the matching integration
  reload service if exposed, or reload YAML/core only when necessary.
- Full YAML reload: use Home Assistant UI or the available `ha`/service path
  for the installed Core version.
- Core restart: last resort after `ha core check` and explicit human intent.

## Safety Boundaries

- Direct human Shell commands and `,,` dispatches are human intent.
- Codex-initiated restart, stop, update, install, uninstall, host, backup, and
  OS operations remain broker-guarded.
- Do not silently answer broker challenges from Codex's normal tool path.
- Before changing automations or scripts, preserve the old YAML and explain the
  reload path.
- Before touching integrations or add-ons, capture logs and current options.
- Before recorder or database work, stop and consider backups, locking, and DB
  integrity.

## Site Memory

Use `/data/monitor/ha-site-memory.md` before rediscovering the house. It maps
phrases such as "Ring lights" to likely integrations, areas, and entity IDs from
Home Assistant's registries and live states. Refresh it with
`ha-site-memory refresh` after renaming devices, integrations, or areas. Optional
human notes in `/config/HA_SITE_NOTES.md` are included when present. Treat it as
a map, not proof; verify live state with `ha-api` or `ha-ws` before changes.

## Change Desk Dispatch

Use `/data/monitor/change-desk-dispatch.json` as the compact monitor packet
before spending reasoning. It records deterministic deltas such as new,
resolved, and newly persistent issues plus config-fingerprint changes and budget
gates. It also labels noisy Modbus, Wi-Fi, socket, timeout, and unavailable
entity findings as localized connectivity trouble unless the entity looks
safety, security, or otherwise critical. The monitor does not call an LLM; high
reasoning should come from an explicit user question or Send Report.

## When Current Knowledge Matters

Home Assistant changes quickly. When behavior depends on a current integration,
service schema, breaking change, or Supervisor behavior, search current official
Home Assistant documentation or inspect the live instance instead of relying on
memory.
