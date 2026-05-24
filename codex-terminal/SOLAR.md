# Solar Commissioning and Diagnostics

Codex Terminal Pro is a general-purpose Home Assistant terminal, but it should
arrive with a strong solar-installer mental model. The default posture is:
read-only discovery first, preserve the current state before changes, and only
move toward control or configuration writes after the exact device, protocol,
register/API, and safety implications are verified.

## What The Add-On Is Prepared For

- Domestic and small commercial PV systems.
- Hybrid inverter and battery systems.
- Backup-loads and whole-home/self-supply investigations.
- Home Assistant Energy dashboard repair.
- Gateway, meter, CT, Modbus, SunSpec, MQTT, and vendor API discovery.
- Installer handoff packages and pre-change restore captures.

## Common Solar Architecture Map

Solar sites usually combine several layers:

- PV inverter layer: string inverters, hybrid inverters, microinverters, or
  optimizer systems.
- Storage layer: battery inverter, integrated hybrid storage, BMS, battery
  gateway, and battery-bank association.
- Metering layer: production meter, site import/export meter, CTs, branch
  circuits, and utility meter visibility.
- Gateway layer: vendor gateway/logger, local web UI, cloud bridge, MQTT bridge,
  or Home Assistant integration.
- Control layer: export limit, grid support, load shave, tariff charging,
  demand response, EV charging, generator integration, and backup transfer.

The same symptom can live in different layers. For example, a blank Home
Assistant power-flow card may be entity metadata, while a zero-export or
no-whole-home-support problem may be CT placement, meter association, utility
program settings, or inverter export-control state.

## Protocol Recognition

Treat these as recognition targets before choosing a tool:

- Modbus TCP/RTU: common for inverters, meters, gateways, and industrial
  controllers. Use `modbus-scan` and `modbus-read` for read-only checks.
- SunSpec Modbus: a DER model layer for inverters, batteries, meters, and
  trackers. Verify model ID, model length, scale factors, and unit ID.
- MQTT: common for SolarAssistant, custom bridges, Envoy bridges, and add-ons.
- Local HTTP/REST: common for vendor gateways; firmware updates can change
  undocumented payload shapes.
- IEEE 2030.5: smart-energy application protocol for utility/DER management,
  demand response, pricing, EVs, and distributed generation.
- OpenADR: demand response and DER flexibility signaling; usually a utility or
  aggregator interface rather than a local inverter debug surface.

## Built-In Commands

Show the solar quick guide:

```bash
solar-toolbox
```

Audit Home Assistant config and entity registry for solar-like surfaces:

```bash
solar-toolbox audit-ha --config /config
solar-toolbox audit-ha --config /config --json
```

Run safe TCP discovery across likely solar gateway ports:

```bash
solar-toolbox discover 192.168.50.0/24 --ports 502,80,443,1502 --open-only
```

Print the prompt-ready site intake brief:

```bash
solar-toolbox brief
```

Print a read-only restore/commissioning capture checklist:

```bash
solar-toolbox snapshot-plan
```

Use the lower-level Modbus helpers when a target and register map are known:

```bash
modbus-toolbox
modbus-scan 192.168.50.0/24 --port 502 --open-only
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 40001 --address-base modicon --count 2
```

## Home Assistant Energy Checklist

When a system is visible in Home Assistant but the Energy dashboard is wrong,
check these before blaming hardware:

- Are production, consumption, grid import, grid export, battery charge, and
  battery discharge split into stable entities?
- Do power sensors reporting watts use `device_class: power` and
  `state_class: measurement`?
- Do energy sensors reporting Wh/kWh use `device_class: energy`,
  `state_class: total_increasing` or the correct accumulation semantics, and
  a valid energy unit?
- Are signs consistent? Import/export and charge/discharge should not silently
  flip across integrations.
- Are raw MQTT/Modbus entities wrapped behind stable `sensor.energy_*` entities
  before Lovelace or Energy dashboard cards depend on them?
- Are unavailable entities stale registry entries, integration downtime, or
  active gateway/network faults?

## Battery and Backup Readiness

For battery-backed systems, separate these questions:

- Is the BMS online and associated with the expected battery bank?
- Is SOC visible from the inverter/gateway and from Home Assistant?
- Are battery type, capacity, charge cycle, grid support, and SOC control
  consistent with the installed chemistry and vendor requirements?
- Is the site powering only a backup panel, or is there a service-point meter
  enabling whole-home/self-supply decisions?
- Are charge/discharge limits coming from inverter config, BMS protection,
  tariff automation, utility export control, or a Home Assistant automation?
- Are there active faults/warnings, or only stale history/statistics gaps?

## Pre-Change Restore Capture

Before installer-facing edits or configuration experiments, capture:

- Home Assistant config files, entity registry, dashboard storage, and
  `ha core check` output.
- Solar/grid/battery/meter entity states from Home Assistant.
- Vendor settings export when available.
- Vendor firmware/build and visible device list.
- Read-only Modbus/SunSpec identity, status, power, energy, SOC, voltage,
  current, alarm, and meter snapshots.
- Network/gateway discovery results.
- A short README describing what was captured, what was intentionally excluded,
  and how to restore or compare later.

Do not include secrets: `secrets.yaml`, browser cookies, access tokens,
`/data/.codex/auth.json`, or private transcript logs.

## Safety Boundary

This add-on should help an installer or homeowner become better informed. It
should not casually become a write-capable inverter configuration tool.

Unsafe actions require a separate explicit request, current vendor
documentation, a verified register/API, a rollback path, and a human who
understands the physical consequences. That includes writes involving export
limits, grid support, relay control, charger settings, battery chemistry,
charge current, frequency/voltage ride-through, generator input, and backup
transfer behavior.

## Official References To Refresh

- SunSpec information models: https://sunspec.org/sunspec-information-model-reference-sunspec-alliance/
- IEEE 2030.5 standard overview: https://standards.ieee.org/ieee/2030.5/11216/
- OpenADR Alliance: https://www.openadr.org/
- Home Assistant Modbus integration: https://www.home-assistant.io/integrations/modbus/
- Home Assistant battery energy docs: https://www.home-assistant.io/docs/energy/battery/
- Home Assistant Enphase Envoy integration: https://www.home-assistant.io/integrations/enphase_envoy/
