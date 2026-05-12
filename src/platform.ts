import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
} from 'homebridge';
import { GeckoApi } from './gecko-api';
import { GeckoConnection } from './gecko-connection';
import { SpaAccessoryGroup } from './spa-accessory';
import {
  DEFAULT_POLL_INTERVAL,
  PLATFORM_NAME,
  PLUGIN_NAME,
  type GeckoConfig,
  type GeckoVessel,
} from './settings';

export class GeckoPlatform implements DynamicPlatformPlugin {
  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly spaGroups = new Map<number, SpaAccessoryGroup>();
  private readonly connections = new Map<string, GeckoConnection>();
  public readonly api: API;
  private readonly geckoApi: GeckoApi;
  private readonly config: GeckoConfig;
  private tokenKeepAliveTimer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly log: Logging,
    config: GeckoConfig,
    api: API,
  ) {
    this.config = config;
    this.api = api;
    this.geckoApi = new GeckoApi(log);

    api.on('didFinishLaunching', () => {
      this.discoverDevices().catch((err) =>
        this.log.error('Device discovery failed: %s', err),
      );
    });

    api.on('shutdown', () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  // ── Helpers used by SpaAccessoryGroup ────────────────────────

  findCachedAccessory(uuid: string): PlatformAccessory | undefined {
    return this.cachedAccessories.find((a) => a.UUID === uuid);
  }

  /**
   * Publish an accessory to HomeKit AFTER its services have been configured.
   * For new accessories, this registers them with the bridge. For cached
   * accessories whose services we just updated, it syncs the change.
   */
  publishAccessory(accessory: PlatformAccessory, isNew: boolean): void {
    if (isNew) {
      this.log.info('Registering new accessory: %s', accessory.displayName);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cachedAccessories.push(accessory);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
  }

  // ── Discovery ────────────────────────────────────────────────

  private async discoverDevices(): Promise<void> {
    if (!(await this.authenticate())) {
      return;
    }

    let accountId: number;
    try {
      const userResp = await this.geckoApi.registerUserAndGetAccount(this.config.email ?? '');
      accountId = userResp.account.accountId;
      this.log.info('Logged in as account %d (%s)', accountId, userResp.account.name ?? 'Account');
    } catch (err) {
      this.log.error('Failed to register user / get account: %s', err);
      return;
    }

    let vessels: GeckoVessel[];
    try {
      vessels = await this.geckoApi.getVessels(accountId);
      if (vessels.length === 0) {
        this.log.warn('No vessels found on this account');
        return;
      }
      this.log.info('Found %d vessel(s)', vessels.length);
    } catch (err) {
      this.log.error('Failed to list vessels: %s', err);
      return;
    }

    for (const vessel of vessels) {
      const group = new SpaAccessoryGroup(this, vessel);
      this.spaGroups.set(vessel.vesselId, group);
      await this.setupVesselConnection(accountId, vessel, group);
    }

    this.cleanupStaleAccessories();
    this.startTokenKeepAlive();
  }

  private async authenticate(): Promise<boolean> {
    try {
      if (this.config.refreshToken) {
        await this.geckoApi.authenticateWithRefreshToken(this.config.refreshToken);
      } else if (this.config.email && this.config.password) {
        await this.geckoApi.authenticateWithPassword(this.config.email, this.config.password);
      } else {
        this.log.error(
          'No credentials configured. Set email + password (or a refreshToken) in the plugin config.',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.log.error('Authentication failed: %s', err);
      this.log.error(
        'If the emulated mobile-app login fails (Auth0 UI may have changed), obtain a refresh token externally and set it as `refreshToken` in the config.',
      );
      return false;
    }
  }

  private async setupVesselConnection(
    accountId: number,
    vessel: GeckoVessel,
    group: SpaAccessoryGroup,
  ): Promise<void> {
    const monitorId = vessel.monitorId;
    if (!monitorId) {
      this.log.warn('Vessel "%s" has no monitorId — skipping MQTT', vessel.name);
      return;
    }

    try {
      const spaConfig = await this.geckoApi.getSpaConfiguration(accountId, monitorId);
      const a = spaConfig.accessories ?? {};
      this.log.info(
        'Spa config for "%s": %d pumps, %d lights, %d waterfalls, %d blowers',
        vessel.name,
        Object.keys(a.pumps ?? {}).length,
        Object.keys(a.lights ?? {}).length,
        Object.keys(a.waterfalls ?? {}).length,
        Object.keys(a.blowers ?? {}).length,
      );
      // One-time dump so we can inspect the schema (truncated for log readability).
      this.log.info(
        'Spa config JSON (first 2000 chars): %s',
        JSON.stringify(spaConfig).slice(0, 2000),
      );
      group.setSpaConfiguration(spaConfig);
    } catch (err) {
      this.log.warn('Failed to fetch spa configuration for %s: %s', vessel.name, err);
    }

    let brokerUrl: string;
    try {
      const liveStream = await this.geckoApi.getMonitorLiveStream(monitorId);
      if (!liveStream.brokerUrl) {
        this.log.error('No brokerUrl returned for monitor %s', monitorId);
        return;
      }
      brokerUrl = liveStream.brokerUrl;
    } catch (err) {
      this.log.error('Failed to get liveStream for %s: %s', vessel.name, err);
      return;
    }

    const conn = new GeckoConnection(monitorId, brokerUrl, this.log, async () => {
      const ls = await this.geckoApi.getMonitorLiveStream(monitorId);
      if (!ls.brokerUrl) {
        throw new Error('No brokerUrl in refreshed liveStream');
      }
      return ls.brokerUrl;
    });

    conn.on('stateUpdate', (state) => {
      group.updateFromSpaState(state);
    });

    conn.on('connected', () => {
      this.log.info('Live connection to "%s"', vessel.name);
    });

    conn.on('disconnected', () => {
      this.log.warn('Lost connection to "%s"', vessel.name);
    });

    try {
      await conn.connect();
      this.connections.set(monitorId, conn);
      group.setConnection(conn);
    } catch (err) {
      this.log.error('MQTT connect failed for %s: %s', vessel.name, err);
    }
  }

  // ── Stale-accessory cleanup ──────────────────────────────────

  private cleanupStaleAccessories(): void {
    const owned = new Set<string>();
    for (const group of this.spaGroups.values()) {
      for (const uuid of group.ownedUuids) {
        owned.add(uuid);
      }
    }

    const stale = this.cachedAccessories.filter((a) => !owned.has(a.UUID));
    if (stale.length > 0) {
      this.log.info('Removing %d stale accessory/accessories from previous versions', stale.length);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        const idx = this.cachedAccessories.indexOf(a);
        if (idx >= 0) {
          this.cachedAccessories.splice(idx, 1);
        }
      }
    }
  }

  // ── Token keep-alive ─────────────────────────────────────────

  private startTokenKeepAlive(): void {
    const interval = (this.config.pollInterval ?? DEFAULT_POLL_INTERVAL) * 1000;
    this.tokenKeepAliveTimer = setInterval(() => {
      this.geckoApi.ensureValidToken().catch((err) =>
        this.log.debug('Token keep-alive refresh failed: %s', err),
      );
    }, interval);
  }

  private shutdown(): void {
    if (this.tokenKeepAliveTimer) {
      clearInterval(this.tokenKeepAliveTimer);
    }
    for (const [id, conn] of this.connections) {
      conn.disconnect().catch((err) =>
        this.log.debug('Error disconnecting %s: %s', id, err),
      );
    }
  }

  get Characteristic() {
    return this.api.hap.Characteristic;
  }

  get Service() {
    return this.api.hap.Service;
  }

  get geckoConfig(): GeckoConfig {
    return this.config;
  }
}
