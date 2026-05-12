# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.15] - 2026-05-12

### Added
- This changelog so the Homebridge UI shows release notes on updates.
- `CHANGELOG.md` added to the npm tarball `files` allow-list.

## [1.0.14] - 2026-05-12

### Added
- First npm-published release. No functional changes from 1.0.13.
- Package metadata for the npm registry: `author`, `homepage`, `repository`, `bugs`.
- Explicit `files` allow-list keeps the published tarball lean (`dist/`, `config.schema.json`, `LICENSE`, `README.md`).
- Expanded keywords (`gecko-alliance`, `intouch`, `intouch3`) for plugin-search discoverability.

## [1.0.13] - 2026-05-12

First version validated end-to-end on real spa hardware.

### Added
- **Rewrite guard**: shadow updates that contradict a recent publish (within 5 seconds) are now ignored. The spa firmware periodically rewrites `state.desired` to its own preferred values (e.g. `speed: 99`); without this, user setpoints would be silently clobbered. External app changes still flow through because they happen outside the 5-second window.

### Changed
- Off command now includes `speed: 100` alongside `active: false`. The spa firmware appears to need both fields to honour deactivation reliably (matches behavior used by the community plugin).

## [1.0.12] - 2026-05-12

### Changed
- Shadow merge now uses field-by-field source rules:
  - Setpoints (pump `active`/`speed`, watercare mode, target temp, eco mode) come from `state.desired`.
  - Observations (current temperature, heating status, gateway/vessel connectivity) come from `state.reported`.
- This prevents motor-RPM noise in `reported.speed` (~99 when running) from masking the user's actual setpoint (50 or 100) and stops `reported.active` oscillation during pump transitions.

## [1.0.10] - 2026-05-12

### Fixed
- `Active.onSet` no longer carries a `speed` value. When iOS Home fires both `Active` and `RotationSpeed` for a slider tap, the speed from `RotationSpeed.onSet` now survives the debounce regardless of event order.
- Shadow state updates use MERGE semantics instead of REPLACE, so partial `/update/accepted` messages don't reset fields they don't mention.
- `/update/delta` (desired-state diff) is no longer ignored — it's processed as a `desired` update.

## [1.0.8] - 2026-05-12

### Added
- Proactive broker URL refresh every 50 minutes. AWS IoT custom-authorizer tokens expire after ~60 minutes; refreshing pre-emptively avoids the ~6-second reconnect outage that used to happen at each hourly boundary.
- Per-zone debounce on flow-zone commands (350 ms). Coalesces the burst of characteristic-write events iOS Home fires for a single slider tap, so the spa sees one clean command instead of several conflicting ones.

## [1.0.7] - 2026-05-11

### Changed
- Password and refresh-token fields in the config UI are now masked.
- Tightened the JSON schema (`required` array at the object level instead of inline) to silence Homebridge UI's validation warning.

## [1.0.5] - 2026-05-11

### Changed
- One-time UUID seed bump (`gecko_v2_…`) to force iOS Home to rediscover all accessories with their current names. After this version, accessory UUIDs are stable.

## [1.0.4] - 2026-05-11

### Added
- Pump speed auto-detection from `spa-configuration.zones.flow.X.speed.{maximum, minimum, stepIncrement}`:
  - `step=0` or `min==max` → single speed → HomeKit `Switch`.
  - Otherwise → `Fanv2` with `(max-min)/step + 1` discrete RotationSpeed steps.
- Manual override available via the `pumps` config array.

### Fixed
- Accessory services are configured before registering with the bridge (the prior order caused new accessories to appear "empty" in the Homebridge UI).

## [1.0.3] - 2026-05-11

### Changed
- Multi-bridged-accessory architecture: each function (Thermostat, each Light zone, each Flow zone, each Watercare mode) is now its own HomeKit accessory with a unique UUID. The previous one-accessory-with-many-services approach caused every tile in iOS Home to display the spa's name with no way to distinguish them.

## [1.0.0] - 2026-05-11

Initial release.

- OAuth2 emulated mobile-app login (PKCE) with refresh-token fallback.
- AWS IoT Device Shadow MQTT over WebSocket using the device's named shadow (`name/state`).
- HomeKit services: Thermostat, Lightbulb (per lighting zone), `Fanv2`/`Switch` (per flow zone), Switch (per watercare mode).
- 106°F support via the `maxTempOverrideC` config option.
- Declares Homebridge 1.8+ and 2.0+ compatibility in `engines`.
