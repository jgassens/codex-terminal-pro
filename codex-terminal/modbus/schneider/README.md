# Schneider Electric Modbus Notes

Use these notes as a workspace for product-specific Schneider Electric register
maps. Codex Terminal Pro does not ship a universal Schneider map because the
correct addresses, unit IDs, scales, and permissions vary by device family,
gateway, and firmware.

## Safe Discovery Pattern

1. Identify the exact product, gateway, and firmware.
2. Find the matching Schneider Electric Modbus register map.
3. Start with read-only input registers or documented read-only holding
   registers.
4. Confirm the unit ID. Common examples are `1`, `100`, `247`, or `255`, but
   the right value is product-specific.
5. Confirm address base:
   - use `--address-base modicon` for `30001` / `40001` notation,
   - use `--address-base one` when the manual's first register is `1`,
   - use `--address-base zero` only when the manual gives protocol offsets.
6. Confirm scale and units from the map before using decoded values.

## Example Read

```bash
modbus-read \
  --host 192.168.50.25 \
  --unit 1 \
  --type holding \
  --address 40001 \
  --address-base modicon \
  --count 2
```

If the value looks wrong, try the documented word order:

```bash
modbus-read \
  --host 192.168.50.25 \
  --unit 1 \
  --type holding \
  --address 40001 \
  --address-base modicon \
  --count 2 \
  --word-order little
```

## Suggested Local Files

Keep site-specific notes in `/config/modbus/` so they live with the Home
Assistant configuration:

```text
/config/modbus/
  schneider-registers.md
  schneider-known-good-reads.json
  schneider-home-assistant-snippets.yaml
```

Do not commit private IP addresses, device serial numbers, credentials, or
site-specific control registers to a public repository.

## Write Operations

The bundled helpers intentionally do not write coils or registers. Schneider
write registers can alter active energy equipment and should have a separate
human confirmation step plus a verified product-specific register map.
