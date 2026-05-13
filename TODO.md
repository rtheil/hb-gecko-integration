# TODO

Tracking ideas and investigations that aren't yet PRs or GitHub issues.

## Probe watercare schedule API via mobile-app traffic capture

Watercare modes (Away / Standard / Energy Savings / Super Energy Savings / Weekender) have built-in schedules: peak/off-peak windows, setpoint offsets, and weekday/weekend day masks. The official HA plugin and the community plugin both ignore these — the only watercare interaction either touches is writing `state.desired.features.operationMode` (a single int 0–4). The schedules themselves live somewhere the clients don't reach (spa controller storage or server-side).

Gecko's mobile app can edit these schedules. Some of that functionality is paywalled.

### Plan

1. Subscribe to the paid tier for a month.
2. Capture mobile-app traffic while editing each watercare mode's schedule (mitmproxy / Charles / Wireshark with the right certs).
3. Identify the shadow path and JSON payload format used for schedule writes.
4. Replay those writes from the plugin and verify the spa honors them.
5. If it works, expose schedule editing via config or a new accessory pattern.

### Also worth capturing while sniffing

- Date / RTC sync — the spa knows day-of-week somehow; no client code touches it.
- Any filter/maintenance reminder traffic (paywalled in the app, possibly server-side only).
- Anything else surprising that neither client uses.

## Surfacing unexposed library features

Found during the `gecko-iot-client` v0.2.5 audit. None of these are in our port today.

- **RGB lights + effects** — `LightingZone.set_color(r, g, b, i?)` and `LightingZone.set_effect(name)`. Library supports full color + named effects; we only do on/off. Effect names are spa-specific strings (need to enumerate from `spa-configuration` or by observing `reported.zones.lighting.{id}.effect` while cycling).
- **Heat-pump states** — `TemperatureControlZoneStatus` enum has `HEAT_PUMP_HEATING`, `HEAT_PUMP_AND_HEATER_HEATING`, `HEAT_PUMP_COOLING`, `HEAT_PUMP_DEFROSTING`, `HEAT_PUMP_ERROR`. Port (and HA plugin) collapse all to `HEATING`/`IDLE`.
- **Heat-pump fault sensor** — `HEAT_PUMP_ERROR` (enum value 8) could surface as a binary sensor.
- **Pump initiators** — `FlowZoneInitiator` enum: `USER_DEMAND / CHECKFLOW / PURGE / FILTRATION / HEATING / COOLDOWN / HEAT_PUMP`. Library exposes `FlowZone.initiators_`; HA plugin and our port both ignore it. Useful for "why did pump 2 just start" diagnostics.
- **Eco mode on temp zone** — `TemperatureControlMode.eco` boolean. Direct shadow write to `state.desired.zones.temperatureControl.{id}.mode_.eco`. Alternative to watercare for eco-vs-standard heating. Community plugin writes it; neither HA plugin nor port exposes it.

## Borrow from community plugin

- **Optimistic state caching** — return the just-set value from characteristic getters for ~10 seconds so HomeKit shows instant feedback before the MQTT round-trip confirms. Implemented in `gecko-intouch3-home-assistant/switch.py:236-243`. Cheap UX win.
