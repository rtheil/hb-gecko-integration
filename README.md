# homebridge-gecko

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Build](https://github.com/rtheil/hb-gecko-integration/actions/workflows/build.yml/badge.svg)](https://github.com/rtheil/hb-gecko-integration/actions/workflows/build.yml)

A [Homebridge](https://homebridge.io) plugin for Gecko Alliance spa and hot tub equipment with `in.touch 3` / `in.touch 3+` gateways. Exposes temperature control, lights, pumps (with speed where supported), and watercare modes to Apple HomeKit.

## Features

- **Thermostat** — set and read the spa target temperature
- **Lights** — one HomeKit `Lightbulb` per lighting zone
- **Pumps** — auto-detected from spa configuration: single-speed pumps appear as `Switch`, multi-speed pumps as `Fanv2` with discrete speed steps
- **Watercare modes** — Away, Standard, Energy Savings, Super Energy Savings, Weekender, each as a `Switch`
- **106°F (41°C) support** — via the `maxTempOverrideC` config option

## Installation

Until published to npm, install from a local tarball:

```bash
# On your Homebridge host
sudo hb-service add /path/to/homebridge-gecko-X.Y.Z.tgz
sudo hb-service restart
sudo hb-service logs | grep -i gecko
```

To build the tarball yourself:

```bash
git clone https://github.com/rtheil/hb-gecko-integration.git
cd hb-gecko-integration
npm install
npm run build
npm pack
# produces homebridge-gecko-X.Y.Z.tgz
```

## Configuration

Configure via the Homebridge Config UI X plugin settings panel, or add to the `platforms` array in `config.json`:

```json
{
  "platform": "GeckoSpa",
  "name": "Gecko Spa",
  "email": "your@email.com",
  "password": "your-gecko-password",
  "maxTempOverrideC": 41
}
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `email` | string | *(required)* | Gecko account email |
| `password` | string | *(required)* | Gecko account password |
| `refreshToken` | string | *(optional)* | Use a pre-obtained refresh token instead of email/password (advanced — used if Auth0 emulated login fails) |
| `maxTempOverrideC` | number | from spa config | Override max target temperature (°C). Set `41` for 106°F |
| `minTempOverrideC` | number | from spa config | Override min target temperature (°C) |
| `pollInterval` | number | 300 | Token keep-alive interval in seconds (state is pushed via MQTT, so this only refreshes the API token) |
| `pumps` | array | auto-detect | Override pump speed detection per flow zone (see below) |

### Pump speed auto-detection

Pump-speed handling is auto-detected from `spa-configuration.zones.flow.X.speed`:

- `min=100, max=100, step=0` → 1 speed → HomeKit `Switch`
- `min=50, max=100, step=50` → 2 speeds → HomeKit `Fanv2` with 3 positions (off / 50% / 100%)
- `min=33, max=100, step=33` → 3 speeds → HomeKit `Fanv2` with 4 positions

To override:

```json
"pumps": [
  { "zoneId": "1", "speeds": 2 },
  { "zoneId": "2", "speeds": 1 }
]
```

## Authentication

The plugin emulates the Gecko iOS app's Auth0 PKCE login flow (identifier → password → token exchange). If that breaks because Auth0 changes its login UI, supply a `refreshToken` obtained via the [community debug tool](https://github.com/grahamdavies/gecko-intouch3-home-assistant/blob/master/gecko_debug_tool.py) instead.

## How it works

- **REST API** — authenticates with Auth0, fetches account/vessel info, fetches spa configuration, retrieves the AWS IoT broker URL with a custom-authorizer token.
- **MQTT over WSS** — connects to AWS IoT, subscribes to the device's named shadow (`name/state`), publishes desired-state updates as commands.
- **Per-function bridged accessories** — each thermostat zone, light zone, flow zone, and watercare mode is its own HomeKit accessory for clean naming and per-tile control.
- **Proactive token refresh** — the broker URL's auth token expires after ~1 hour; the plugin proactively refreshes at the 50-minute mark to avoid mid-session reconnects.
- **Rewrite guard** — the spa firmware occasionally overwrites `state.desired` with its own preferred values shortly after a publish. A 5-second per-zone guard ignores those rewrites so the user's setpoint sticks while still allowing external changes through.

## Known quirks

- **CF (Check Filter) auto-cycles**: when the spa starts the pump for a maintenance cycle, the shadow `desired` reflects the activation, but the corresponding auto-stop may only update `reported` — so HomeKit can lag on the deactivation. Toggle the tile to resync.
- **External Gecko app changes during a HomeKit command**: if you change the spa via the Gecko mobile app within ~5 seconds of using HomeKit, the change may flicker briefly before settling (a side-effect of the rewrite guard).

## Credits

Built on the protocol and behavior documented by these prior projects:

- [geckoal/ha-gecko-integration](https://github.com/geckoal/ha-gecko-integration) — Gecko Alliance's official Home Assistant integration
- [gecko-intouch3-home-assistant](https://github.com/grahamdavies/gecko-intouch3-home-assistant) — community Home Assistant integration that documented the Auth0 mobile flow and AWS IoT Device Shadow protocol

## License

[Apache-2.0](LICENSE)
