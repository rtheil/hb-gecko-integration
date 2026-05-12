import type { PlatformAccessory, Service } from 'homebridge';
import type { GeckoConnection } from './gecko-connection';
import type { GeckoPlatform } from './platform';
import {
  WATERCARE_MODE_NAMES,
  WATERCARE_MODE_VALUES,
  type GeckoVessel,
  type SpaConfiguration,
  type SpaFlowZone,
  type SpaLightZone,
  type SpaState,
  type SpaTempZone,
} from './settings';

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

function setupAccessoryInfo(
  platform: GeckoPlatform,
  accessory: PlatformAccessory,
  vessel: GeckoVessel,
  serialSuffix: string,
): void {
  const { Characteristic, Service } = platform;
  const info =
    accessory.getService(Service.AccessoryInformation) ??
    accessory.addService(Service.AccessoryInformation);
  info
    .setCharacteristic(Characteristic.Name, accessory.displayName)
    .setCharacteristic(Characteristic.Manufacturer, 'Gecko Alliance')
    .setCharacteristic(Characteristic.Model, vessel.type ?? 'in.touch3')
    .setCharacteristic(
      Characteristic.SerialNumber,
      `${vessel.monitorId ?? vessel.vesselId}_${serialSuffix}`,
    )
    .setCharacteristic(Characteristic.FirmwareRevision, vessel.protocolName ?? '1.0.0');
}

// ──────────────────────────────────────────────────────────────
// Thermostat accessory
// ──────────────────────────────────────────────────────────────

class ThermostatAccessory {
  private readonly service: Service;
  private cached: SpaTempZone;

  constructor(
    private readonly platform: GeckoPlatform,
    public readonly accessory: PlatformAccessory,
    vessel: GeckoVessel,
    initialZone: SpaTempZone,
    private readonly getConn: () => GeckoConnection | null,
  ) {
    this.cached = initialZone;
    setupAccessoryInfo(platform, accessory, vessel, `thermostat_${initialZone.id}`);

    const { Characteristic, Service } = platform;
    this.service =
      accessory.getService(Service.Thermostat) ?? accessory.addService(Service.Thermostat);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    const cfg = platform.geckoConfig;
    const minTemp = cfg.minTempOverrideC ?? initialZone.minTemp;
    const maxTemp = cfg.maxTempOverrideC ?? initialZone.maxTemp;

    this.service
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .setProps({
        validValues: [
          Characteristic.CurrentHeatingCoolingState.OFF,
          Characteristic.CurrentHeatingCoolingState.HEAT,
        ],
      })
      .onGet(() =>
        this.cached.isHeating
          ? Characteristic.CurrentHeatingCoolingState.HEAT
          : Characteristic.CurrentHeatingCoolingState.OFF,
      );

    this.service
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [Characteristic.TargetHeatingCoolingState.HEAT] })
      .onGet(() => Characteristic.TargetHeatingCoolingState.HEAT)
      .onSet(() => {
        // HEAT only
      });

    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.cached.currentTemp ?? 0);

    this.service
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 0.5 })
      .onGet(() => this.cached.targetTemp ?? minTemp)
      .onSet((value) => {
        this.getConn()?.setTargetTemperature(this.cached.id, value as number);
      });

    this.service
      .getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(() => Characteristic.TemperatureDisplayUnits.CELSIUS)
      .onSet(() => {
        // Underlying value is always Celsius
      });
  }

  update(zone: SpaTempZone): void {
    this.cached = zone;
    const { Characteristic } = this.platform;
    if (zone.currentTemp != null) {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, zone.currentTemp);
    }
    if (zone.targetTemp != null) {
      this.service.updateCharacteristic(Characteristic.TargetTemperature, zone.targetTemp);
    }
    this.service.updateCharacteristic(
      Characteristic.CurrentHeatingCoolingState,
      zone.isHeating
        ? Characteristic.CurrentHeatingCoolingState.HEAT
        : Characteristic.CurrentHeatingCoolingState.OFF,
    );
  }
}

// ──────────────────────────────────────────────────────────────
// Lightbulb accessory
// ──────────────────────────────────────────────────────────────

class LightbulbAccessory {
  private readonly service: Service;
  private cached: SpaLightZone;

  constructor(
    private readonly platform: GeckoPlatform,
    public readonly accessory: PlatformAccessory,
    vessel: GeckoVessel,
    initialZone: SpaLightZone,
    private readonly getConn: () => GeckoConnection | null,
  ) {
    this.cached = initialZone;
    setupAccessoryInfo(platform, accessory, vessel, `light_${initialZone.id}`);

    const { Characteristic, Service } = platform;
    this.service =
      accessory.getService(Service.Lightbulb) ?? accessory.addService(Service.Lightbulb);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.cached.active)
      .onSet((value) => {
        this.getConn()?.setLightActive(this.cached.id, value as boolean);
      });
  }

  update(zone: SpaLightZone): void {
    this.cached = zone;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, zone.active);
  }
}

// ──────────────────────────────────────────────────────────────
// Pump accessory — Switch (1-speed) or Fanv2 (multi-speed)
// ──────────────────────────────────────────────────────────────

class PumpAccessory {
  private readonly service: Service;
  private readonly isSwitch: boolean;
  private cached: SpaFlowZone;

  constructor(
    private readonly platform: GeckoPlatform,
    public readonly accessory: PlatformAccessory,
    vessel: GeckoVessel,
    initialZone: SpaFlowZone,
    speeds: number, // 1 = Switch, 2+ = Fanv2 with steps
    private readonly getConn: () => GeckoConnection | null,
  ) {
    this.cached = initialZone;
    this.isSwitch = speeds <= 1;
    setupAccessoryInfo(platform, accessory, vessel, `pump_${initialZone.id}`);

    const { Characteristic, Service } = platform;

    // If a service of the wrong type lingers from a previous run with different
    // pump config, remove it so we can add the correct one.
    if (this.isSwitch) {
      const stale = accessory.getService(Service.Fanv2);
      if (stale) {
        accessory.removeService(stale);
      }
      this.service =
        accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch);
    } else {
      const stale = accessory.getService(Service.Switch);
      if (stale) {
        accessory.removeService(stale);
      }
      this.service =
        accessory.getService(Service.Fanv2) ?? accessory.addService(Service.Fanv2);
    }

    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    if (this.isSwitch) {
      // Plain on/off
      this.service
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.cached.active)
        .onSet((value) => {
          this.getConn()?.setFlowZone(this.cached.id, value as boolean, 100);
        });
    } else {
      // Multi-speed fan with discrete steps
      // speeds=2 → minStep=50 (0, 50, 100)
      // speeds=3 → minStep≈33 (0, 33, 66, 100)
      const minStep = Math.floor(100 / speeds);

      this.service
        .getCharacteristic(Characteristic.Active)
        .onGet(() =>
          this.cached.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
        )
        .onSet((value) => {
          const active = value === Characteristic.Active.ACTIVE;
          this.platform.log.info(
            '[Pump %s] HK→ Active=%s (cached active=%s, speed=%s)',
            this.cached.id,
            active ? 'ACTIVE' : 'INACTIVE',
            this.cached.active,
            this.cached.speed,
          );
          // Toggle only — never carry a speed. If a RotationSpeed.onSet has
          // already queued a speed in the debounce buffer, setFlowZone will
          // preserve it. The spa retains its previously-set speed otherwise.
          this.getConn()?.setFlowZone(this.cached.id, active);
        });

      this.service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep })
        .onGet(() => this.cached.speed)
        .onSet((value) => {
          const speed = value as number;
          this.platform.log.info(
            '[Pump %s] HK→ RotationSpeed=%s (cached active=%s, speed=%s)',
            this.cached.id,
            speed,
            this.cached.active,
            this.cached.speed,
          );
          if (speed === 0) {
            this.getConn()?.setFlowZone(this.cached.id, false);
          } else {
            this.getConn()?.setFlowZone(this.cached.id, true, speed);
          }
        });
    }
  }

  update(zone: SpaFlowZone): void {
    this.cached = zone;
    const { Characteristic } = this.platform;
    if (this.isSwitch) {
      this.service.updateCharacteristic(Characteristic.On, zone.active);
    } else {
      this.service.updateCharacteristic(
        Characteristic.Active,
        zone.active ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
      );
      this.service.updateCharacteristic(Characteristic.RotationSpeed, zone.speed);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Watercare mode switch accessory
// ──────────────────────────────────────────────────────────────

class WatercareSwitchAccessory {
  private readonly service: Service;
  private lastActiveMode: number | null = null;

  constructor(
    private readonly platform: GeckoPlatform,
    public readonly accessory: PlatformAccessory,
    vessel: GeckoVessel,
    private readonly mode: number,
    private readonly getConn: () => GeckoConnection | null,
    private readonly notifySiblings: (chosenMode: number) => void,
  ) {
    setupAccessoryInfo(platform, accessory, vessel, `watercare_${mode}`);

    const { Characteristic, Service } = platform;
    this.service =
      accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.lastActiveMode === this.mode)
      .onSet((value) => {
        if (value === true) {
          this.getConn()?.setWatercareMode(this.mode);
          this.lastActiveMode = this.mode;
          this.notifySiblings(this.mode);
        }
        // Turning a mode switch off is a no-op — the spa always has a mode.
      });
  }

  update(currentMode: number | null): void {
    this.lastActiveMode = currentMode;
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.On, currentMode === this.mode);
  }
}

// ──────────────────────────────────────────────────────────────
// Orchestrator
// ──────────────────────────────────────────────────────────────

export class SpaAccessoryGroup {
  private connection: GeckoConnection | null = null;
  private spaConfig: SpaConfiguration = {};

  private thermostats = new Map<string, ThermostatAccessory>();
  private lights = new Map<string, LightbulbAccessory>();
  private pumps = new Map<string, PumpAccessory>();
  private watercare = new Map<number, WatercareSwitchAccessory>();

  // Track every UUID we own so the platform can clean up stale ones.
  readonly ownedUuids = new Set<string>();

  constructor(
    private readonly platform: GeckoPlatform,
    private readonly vessel: GeckoVessel,
  ) {
    this.ensureWatercareAccessories();
  }

  setConnection(conn: GeckoConnection): void {
    this.connection = conn;
  }

  setSpaConfiguration(config: SpaConfiguration): void {
    this.spaConfig = config;
    this.ensureFromConfig();
  }

  updateFromSpaState(state: SpaState): void {
    for (const zone of state.tempZones) {
      this.ensureThermostat(zone);
      this.thermostats.get(zone.id)?.update(zone);
    }
    for (const zone of state.lightZones) {
      this.ensureLight(zone);
      this.lights.get(zone.id)?.update(zone);
    }
    for (const zone of state.flowZones) {
      this.ensurePump(zone);
      this.pumps.get(zone.id)?.update(zone);
    }
    for (const wc of this.watercare.values()) {
      wc.update(state.watercareMode);
    }
  }

  // ── Eager creation from spa-config (so accessories exist before first MQTT) ──

  private ensureFromConfig(): void {
    const tempZones = this.spaConfig.zones?.temperatureControl ?? {};
    for (const [id, cfg] of Object.entries(tempZones)) {
      this.ensureThermostat({
        id,
        currentTemp: null,
        targetTemp: null,
        isHeating: false,
        ecoMode: false,
        minTemp: cfg.minTemperatureSetPointC ?? 20,
        maxTemp: cfg.maxTemperatureSetPointC ?? 40,
      });
    }

    const lightingZones = this.spaConfig.zones?.lighting ?? {};
    for (const [id, cfg] of Object.entries(lightingZones)) {
      const label =
        cfg.lights && cfg.lights.length > 0
          ? cfg.lights.map((n) => `Light ${n}`).join(' + ')
          : `Light Zone ${id}`;
      this.ensureLight({ id, active: false, label });
    }

    const flowZones = this.spaConfig.zones?.flow ?? {};
    for (const [id, cfg] of Object.entries(flowZones)) {
      const labelParts: string[] = [];
      let icon: SpaFlowZone['icon'] = 'pump';
      if (cfg.pumps && cfg.pumps.length > 0) {
        labelParts.push(...cfg.pumps.map((n) => `Pump ${n}`));
      }
      if (cfg.waterfalls && cfg.waterfalls.length > 0) {
        labelParts.push(...cfg.waterfalls.map((n) => `Waterfall ${n}`));
        icon = 'waterfall';
      }
      if (cfg.blowers && cfg.blowers.length > 0) {
        labelParts.push(...cfg.blowers.map((n) => `Blower ${n}`));
        if (icon === 'pump') {
          icon = 'blower';
        }
      }
      this.ensurePump({
        id,
        active: false,
        speed: 0,
        label: labelParts.length > 0 ? labelParts.join(' + ') : `Flow Zone ${id}`,
        icon,
      });
    }
  }

  // ── Per-function ensure methods ──────────────────────────────

  private ensureThermostat(zone: SpaTempZone): void {
    if (this.thermostats.has(zone.id)) {
      return;
    }
    const name = `${this.vessel.name} Thermostat`;
    const { accessory, isNew } = this.claimAccessory(`thermostat_${zone.id}`, name);
    // Services configured first
    this.thermostats.set(
      zone.id,
      new ThermostatAccessory(this.platform, accessory, this.vessel, zone, () => this.connection),
    );
    // Then registered (so HAP sees a complete accessory)
    this.platform.publishAccessory(accessory, isNew);
  }

  private ensureLight(zone: SpaLightZone): void {
    if (this.lights.has(zone.id)) {
      return;
    }
    const name = `${this.vessel.name} ${zone.label}`;
    const { accessory, isNew } = this.claimAccessory(`light_${zone.id}`, name);
    this.lights.set(
      zone.id,
      new LightbulbAccessory(this.platform, accessory, this.vessel, zone, () => this.connection),
    );
    this.platform.publishAccessory(accessory, isNew);
  }

  private ensurePump(zone: SpaFlowZone): void {
    if (this.pumps.has(zone.id)) {
      return;
    }
    const speeds = this.lookupPumpSpeeds(zone.id);
    const name = `${this.vessel.name} ${zone.label}`;
    const { accessory, isNew } = this.claimAccessory(`flow_${zone.id}`, name);
    this.pumps.set(
      zone.id,
      new PumpAccessory(this.platform, accessory, this.vessel, zone, speeds, () => this.connection),
    );
    this.platform.publishAccessory(accessory, isNew);
  }

  private ensureWatercareAccessories(): void {
    for (const mode of WATERCARE_MODE_VALUES) {
      const modeName = WATERCARE_MODE_NAMES[mode];
      const name = `${this.vessel.name} ${modeName}`;
      const { accessory, isNew } = this.claimAccessory(`watercare_${mode}`, name);
      const wc = new WatercareSwitchAccessory(
        this.platform,
        accessory,
        this.vessel,
        mode,
        () => this.connection,
        (chosen) => {
          for (const [m, sibling] of this.watercare) {
            if (m !== chosen) {
              sibling.update(chosen);
            }
          }
        },
      );
      this.watercare.set(mode, wc);
      this.platform.publishAccessory(accessory, isNew);
    }
  }

  // ── Pump speed lookup ────────────────────────────────────────

  private lookupPumpSpeeds(zoneId: string): number {
    // 1. User config takes precedence
    const userCfg = this.platform.geckoConfig.pumps?.find((p) => p.zoneId === zoneId);
    if (userCfg?.speeds && userCfg.speeds >= 1) {
      return userCfg.speeds;
    }

    // 2. Auto-detect from spa-configuration's flow zone speed range:
    //    speed: { maximum, minimum, stepIncrement }
    //    stepIncrement of 0 (or all-same min/max) → single speed (Switch)
    //    otherwise: number of positions = (max - min) / step + 1
    const flowZone = this.spaConfig.zones?.flow?.[zoneId] as
      | {
          speed?: { maximum?: number; minimum?: number; stepIncrement?: number };
        }
      | undefined;
    const speedSpec = flowZone?.speed;
    if (speedSpec) {
      const max = speedSpec.maximum ?? 100;
      const min = speedSpec.minimum ?? 100;
      const step = speedSpec.stepIncrement ?? 0;
      if (step <= 0 || max === min) {
        return 1;
      }
      return Math.max(1, Math.floor((max - min) / step) + 1);
    }

    // 3. Default: smooth slider
    return 0;
  }

  // ── Accessory claim helper ───────────────────────────────────

  private claimAccessory(suffix: string, name: string): { accessory: PlatformAccessory; isNew: boolean } {
    // UUID seed includes a version tag — bump this to force iOS Home to treat
    // all Gecko accessories as brand-new (used to refresh stale display names).
    const uuid = this.platform.api.hap.uuid.generate(
      `gecko_v2_${this.vessel.vesselId}_${suffix}`,
    );
    this.ownedUuids.add(uuid);

    const cached = this.platform.findCachedAccessory(uuid);
    if (cached) {
      cached.displayName = name;
      return { accessory: cached, isNew: false };
    }
    return {
      accessory: new this.platform.api.platformAccessory(name, uuid),
      isNew: true,
    };
  }
}
