# Modbus Toolbox

Codex Terminal Pro includes a small read-only Modbus toolbox for Home Assistant
debugging and Schneider Electric discovery work.

## Included Tools

- `modbus-toolbox`: prints examples, installed helper versions, and safety
  notes.
- `modbus-scan`: checks which hosts accept TCP connections on a Modbus port.
- `modbus-read`: reads coils, discrete inputs, input registers, or holding
  registers and prints JSON.
- `ncat`: quick TCP connectivity checks.
- `socat`: serial/TCP bridge and low-level connection testing.
- `tcpdump`: packet capture inside the add-on network namespace.
- `libmodbus`: C library for libmodbus-based tools.
- Python modules on `PYTHONPATH`: `pymodbus[serial]`, `minimalmodbus`, and
  `pyserial`.

`mbpoll` is intentionally not bundled yet. It is useful, but it needs a
separate multi-architecture build/packaging pass before it should be included
in the add-on image.

## Quick Checks

Find devices with Modbus TCP open:

```bash
modbus-scan 192.168.50.0/24 --port 502 --open-only
```

Check one host with `ncat`:

```bash
ncat -vz 192.168.50.25 502
```

Read two holding registers using conventional 40001-style Modbus notation:

```bash
modbus-read \
  --host 192.168.50.25 \
  --unit 1 \
  --type holding \
  --address 40001 \
  --address-base modicon \
  --count 2
```

Read two input registers using conventional 30001-style notation:

```bash
modbus-read \
  --host 192.168.50.25 \
  --unit 1 \
  --type input \
  --address 30001 \
  --address-base modicon \
  --count 2
```

If a manual lists register `1` as the first register, use:

```bash
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 1 --address-base one --count 2
```

If a manual already lists zero-based offsets, use the default:

```bash
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 0 --count 2
```

## Addressing Notes

Modbus wire addresses are zero-based. Many device manuals are not.

- `--address-base zero`: the value you typed is already the 0-based Modbus
  frame address.
- `--address-base one`: register `1` means frame address `0`.
- `--address-base modicon`: conventional ranges are translated for you:
  `00001`, `10001`, `30001`, and `40001` become frame address `0` for coils,
  discrete inputs, input registers, and holding registers respectively.

Schneider Electric documents can use product-specific terminology, offsets,
unit IDs, and scaling. Always verify against the exact product and firmware
register map.

## Decoding Notes

`modbus-read` always returns raw registers or bits. For register reads, it also
prints common 16-bit and 32-bit interpretations:

- `uint16`, `int16`, and `hex16`
- paired `uint32`, `int32`, `float32`, and `hex32`
- a lossy ASCII view

For 32-bit values, try the device manual's byte and word order:

```bash
modbus-read --host 192.168.50.25 --unit 1 --type holding --address 40001 --address-base modicon --count 2 --word-order little
```

## Serial / RTU

The helper supports RTU syntax:

```bash
modbus-read --serial /dev/ttyUSB0 --baudrate 9600 --unit 1 --type holding --address 1 --address-base one
```

The add-on does not add new host/device mounts for serial adapters. Serial RTU
will only work if the device is already exposed to the add-on by Home Assistant
configuration.

## Packet Capture

`tcpdump` can help confirm whether the add-on is sending or receiving Modbus
TCP packets:

```bash
tcpdump -ni any tcp port 502
```

Packet capture is limited to what the add-on container can see. It is not a
host-wide network tap.

## Safety

This toolbox is read-only by default. It does not include Modbus write helpers.
Writes to Schneider Electric devices can change live inverter, charger, meter,
relay, or building-controller behavior. Add write support only with a separate
confirmation gate and a verified register map.
