import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type { Logger } from 'homebridge';
import {
  emptySpaState,
  type ShadowReportedState,
  type SpaConfiguration,
  type SpaFlowZone,
  type SpaState,
} from './settings';

/**
 * Manages a single AWS IoT MQTT WebSocket connection to a Gecko monitor's
 * named device shadow ("state").
 *
 * The broker URL (from /v2/monitors/{id}/liveStream) is a pre-signed WSS URL
 * with AWS IoT Custom Authorizer parameters baked into the query string —
 * `mqtt.connect(url)` over WSS uses these during the WebSocket upgrade.
 */
const PROACTIVE_REFRESH_MS = 50 * 60 * 1000; // refresh broker URL every 50 min
const FLOW_DEBOUNCE_MS = 350; // coalesce rapid setFlowZone calls
const REWRITE_GUARD_MS = 5000; // after publishing, ignore spa-side desired rewrites for this long

export class GeckoConnection extends EventEmitter {
  private client: MqttClient | null = null;
  private _connected = false;
  private state: SpaState;
  private config: SpaConfiguration = {};
  private readonly clientId: string;
  private proactiveRefreshTimer?: ReturnType<typeof setInterval>;
  private readonly flowDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flowDebouncePending = new Map<string, { active: boolean; speed?: number }>();
  // Tracks the most recently published setpoint per zone so we can ignore the
  // spa's habit of rewriting state.desired back to weird values (e.g. speed=99)
  // shortly after our publish lands.
  private readonly flowLastPublished = new Map<string, { active: boolean; speed?: number; at: number }>();

  constructor(
    private readonly monitorId: string,
    private brokerUrl: string,
    private readonly log: Logger,
    private readonly refreshBrokerUrl: () => Promise<string>,
  ) {
    super();
    this.state = emptySpaState();
    this.clientId = `homebridge-gecko-${randomBytes(4).toString('hex')}`;
  }

  setSpaConfiguration(config: SpaConfiguration): void {
    this.config = config;
  }

  get connected(): boolean {
    return this._connected;
  }

  getSpaState(): SpaState {
    return this.state;
  }

  // ── Topics ───────────────────────────────────────────────────

  private get topicGet() {
    return `$aws/things/${this.monitorId}/shadow/name/state/get`;
  }
  private get topicUpdate() {
    return `$aws/things/${this.monitorId}/shadow/name/state/update`;
  }
  private get subscribeTopics() {
    const base = `$aws/things/${this.monitorId}/shadow/name/state`;
    return [
      `${base}/update/accepted`,
      `${base}/update/rejected`,
      `${base}/update/delta`,
      `${base}/update/documents`,
      `${base}/get/accepted`,
    ];
  }

  // ── Lifecycle ────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.log.info('AWS IoT MQTT connecting to monitor %s ...', this.monitorId);

    this.client = mqtt.connect(this.brokerUrl, {
      clientId: this.clientId,
      protocolVersion: 5,
      keepalive: 30,
      reconnectPeriod: 5_000,
      clean: true,
      rejectUnauthorized: true,
    });

    this.client.on('connect', () => {
      this._connected = true;
      this.log.info('AWS IoT MQTT connected (monitor %s)', this.monitorId);
      this.subscribeAll();
      this.requestShadowGet();
      this.startProactiveRefresh();
      this.emit('connected');
    });

    this.client.on('reconnect', () => {
      this.log.debug('AWS IoT MQTT reconnecting (monitor %s)', this.monitorId);
    });

    this.client.on('close', () => {
      if (this._connected) {
        this.log.warn('AWS IoT MQTT connection closed (monitor %s)', this.monitorId);
      }
      this._connected = false;
      this.emit('disconnected');
    });

    this.client.on('error', async (err) => {
      this.log.error('MQTT error (monitor %s): %s', this.monitorId, err.message);

      // The custom-authorizer tokens in the WSS URL expire (typically ~1h).
      // On auth failure, refresh the broker URL and reconnect.
      if (/not authorized|unauthorized|forbidden|connack/i.test(err.message)) {
        try {
          this.log.info('Refreshing broker URL after auth error...');
          this.brokerUrl = await this.refreshBrokerUrl();
          await this.reconnectInternal();
        } catch (refreshErr) {
          this.log.error('Broker URL refresh failed: %s', refreshErr);
        }
      }
    });

    this.client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload);
    });
  }

  async disconnect(): Promise<void> {
    this.stopProactiveRefresh();
    if (!this.client) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.client!.end(false, {}, () => {
        this.client = null;
        this._connected = false;
        resolve();
      });
    });
  }

  // ── Proactive token refresh (AWS IoT custom-auth tokens expire ~1h) ──

  private startProactiveRefresh(): void {
    this.stopProactiveRefresh();
    this.proactiveRefreshTimer = setInterval(() => {
      this.proactiveReconnect().catch((err) =>
        this.log.error('Proactive reconnect failed: %s', err),
      );
    }, PROACTIVE_REFRESH_MS);
  }

  private stopProactiveRefresh(): void {
    if (this.proactiveRefreshTimer) {
      clearInterval(this.proactiveRefreshTimer);
      this.proactiveRefreshTimer = undefined;
    }
  }

  private async proactiveReconnect(): Promise<void> {
    this.log.info('Proactively refreshing broker URL (monitor %s)', this.monitorId);
    try {
      const newUrl = await this.refreshBrokerUrl();
      this.brokerUrl = newUrl;
      await this.reconnectInternal();
    } catch (err) {
      this.log.error('Broker URL refresh failed: %s', err);
    }
  }

  private async reconnectInternal(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  // ── Commands (publish desired-state shadow updates) ──────────

  setTargetTemperature(zoneId: string, temperature: number): void {
    this.publishDesired(
      { zones: { temperatureControl: { [zoneId]: { setPoint: temperature } } } },
      `set temperature zone ${zoneId} → ${temperature}°C`,
    );
  }

  setEcoMode(zoneId: string, eco: boolean): void {
    this.publishDesired(
      { zones: { temperatureControl: { [zoneId]: { mode_: { eco } } } } },
      `set eco zone ${zoneId} → ${eco}`,
    );
  }

  setLightActive(zoneId: string, active: boolean): void {
    this.publishDesired(
      { zones: { lighting: { [zoneId]: { active } } } },
      `set light zone ${zoneId} → ${active}`,
    );
  }

  setFlowZone(zoneId: string, active: boolean, speed?: number): void {
    // Coalesce rapid calls — iOS Home's Fanv2 slider fires both Active and
    // RotationSpeed onSet handlers within milliseconds of each other, and on
    // a tap (vs drag) the events can arrive out of order.
    //
    // Speed merging: if this call doesn't carry a speed (Active toggle alone),
    // preserve any speed already pending from a prior RotationSpeed call so
    // the Active event doesn't clobber the user's intended speed.
    const existingPending = this.flowDebouncePending.get(zoneId);
    const finalSpeed = speed !== undefined ? speed : existingPending?.speed;
    this.flowDebouncePending.set(zoneId, { active, speed: finalSpeed });

    const existingTimer = this.flowDebounceTimers.get(zoneId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const pending = this.flowDebouncePending.get(zoneId);
      if (!pending) {
        return;
      }
      this.flowDebouncePending.delete(zoneId);
      this.flowDebounceTimers.delete(zoneId);

      // Spa firmware (community plugin's experience) requires both `active`
      // and `speed` in the off command, otherwise the off can be ignored.
      // Off keeps speed=100 as a no-op placeholder so deactivation lands.
      const desired: Record<string, unknown> = { active: pending.active };
      desired.speed = pending.active ? (pending.speed ?? 100) : 100;

      this.log.info(
        '[Pump %s] DEBOUNCE → publish: active=%s, speed=%s',
        zoneId,
        pending.active,
        desired.speed,
      );

      // Remember the setpoint so we can ignore spa-side rewrites that contradict it.
      this.flowLastPublished.set(zoneId, {
        active: pending.active,
        speed: pending.active ? pending.speed : undefined,
        at: Date.now(),
      });

      this.publishDesired(
        { zones: { flow: { [zoneId]: desired } } },
        `set flow zone ${zoneId} → active=${pending.active}, speed=${desired.speed}`,
      );
    }, FLOW_DEBOUNCE_MS);

    this.flowDebounceTimers.set(zoneId, timer);
  }

  setFlowZoneSpeed(zoneId: string, speed: number): void {
    this.publishDesired(
      { zones: { flow: { [zoneId]: { speed } } } },
      `set flow zone ${zoneId} speed → ${speed}`,
    );
  }

  setWatercareMode(mode: number): void {
    this.publishDesired(
      { features: { operationMode: mode } },
      `set watercare mode → ${mode}`,
    );
  }

  private publishDesired(desired: Record<string, unknown>, description: string): void {
    if (!this.client || !this._connected) {
      this.log.warn('Cannot publish (%s) — MQTT not connected', description);
      return;
    }

    const payload = {
      state: { desired },
      clientToken: `${Date.now()}-${this.clientId}`,
    };

    this.log.debug('MQTT publish %s: %s', this.topicUpdate, description);
    this.client.publish(this.topicUpdate, JSON.stringify(payload), { qos: 1 }, (err) => {
      if (err) {
        this.log.error('Publish failed (%s): %s', description, err.message);
      }
    });
  }

  // ── Subscriptions & initial state fetch ──────────────────────

  private subscribeAll(): void {
    if (!this.client) {
      return;
    }
    for (const topic of this.subscribeTopics) {
      this.client.subscribe(topic, { qos: 1 }, (err, granted) => {
        if (err) {
          this.log.error('Subscribe failed for %s: %s', topic, err.message);
          return;
        }
        if (granted && granted.length > 0) {
          const g = granted[0];
          if (typeof g.qos === 'number' && g.qos > 2) {
            this.log.warn('Subscribe REJECTED for %s (reason code %d)', topic, g.qos);
          } else {
            this.log.debug('Subscribed to %s (qos %d)', topic, g.qos);
          }
        }
      });
    }
  }

  private requestShadowGet(): void {
    if (!this.client) {
      return;
    }
    this.client.publish(this.topicGet, '{}', { qos: 1 }, (err) => {
      if (err) {
        this.log.warn('Shadow GET publish failed: %s', err.message);
      }
    });
  }

  // ── Incoming messages ────────────────────────────────────────

  private handleMessage(topic: string, payload: Buffer): void {
    const payloadStr = payload.toString();
    this.log.debug('MQTT ← %s (%d bytes)', topic, payload.length);

    if (topic.endsWith('/update/rejected')) {
      return;
    }

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(payloadStr) as Record<string, unknown>;
    } catch {
      this.log.warn('Non-JSON message on %s', topic);
      return;
    }

    // Pull both reported and desired from whichever message format this is:
    //   /update/documents → doc.current.state.{reported,desired}
    //   /update/delta     → doc.state            (delta fields, treat as desired)
    //   /update/accepted  → doc.state.{reported,desired}
    //   /get/accepted     → doc.state.{reported,desired}
    let reported: ShadowReportedState | null = null;
    let desired: ShadowReportedState | null = null;

    if (topic.endsWith('/update/documents')) {
      const current = doc.current as { state?: { reported?: ShadowReportedState; desired?: ShadowReportedState } } | undefined;
      reported = current?.state?.reported ?? null;
      desired = current?.state?.desired ?? null;
    } else if (topic.endsWith('/update/delta')) {
      desired = (doc.state as ShadowReportedState | null) ?? null;
    } else {
      const state = doc.state as { reported?: ShadowReportedState; desired?: ShadowReportedState } | undefined;
      reported = state?.reported ?? null;
      desired = state?.desired ?? null;
    }

    if (!reported && !desired) {
      this.log.debug('No reported/desired state in message on %s', topic);
      return;
    }

    // Apply reported first (gives us actual observable state — active, current
    // temperature, connectivity), then desired (overrides shared fields with
    // the user's setpoint). This matters because the spa's reported.speed is
    // motor RPM (~99 when running), not the user's selected speed (50/100).
    if (reported) {
      this.mergeReportedState(reported, 'reported');
    }
    if (desired) {
      this.mergeReportedState(desired, 'desired');
    }

    this.emit('stateUpdate', this.state);
  }

  // ── Normalise shadow → SpaState (MERGE semantics) ────────────
  // AWS IoT shadow /update/accepted contains only the FIELDS that just
  // changed — never replace whole sub-trees, always merge per-field.

  private mergeReportedState(state: ShadowReportedState, source: 'reported' | 'desired'): void {
    if (state.zones?.temperatureControl) {
      this.mergeTempZones(state.zones.temperatureControl, source);
    }
    if (state.zones?.flow) {
      this.mergeFlowZones(state.zones.flow, source);
    }
    if (state.zones?.lighting) {
      this.mergeLightZones(state.zones.lighting, source);
    }
    // operationMode is a setpoint — only trust desired
    if (source === 'desired' && state.features?.operationMode !== undefined) {
      this.state.watercareMode = state.features.operationMode;
    }
    // connectivity is observed — only trust reported
    if (source === 'reported') {
      if (state.connectivity_?.gatewayStatus !== undefined) {
        this.state.gatewayConnected =
          String(state.connectivity_.gatewayStatus).toUpperCase() === 'CONNECTED';
      }
      if (state.connectivity_?.vesselStatus !== undefined) {
        this.state.vesselRunning =
          String(state.connectivity_.vesselStatus).toUpperCase() === 'RUNNING';
      }
    }
  }

  private mergeTempZones(
    updates: NonNullable<ShadowReportedState['zones']>['temperatureControl'],
    source: 'reported' | 'desired',
  ): void {
    const tempConfig = this.config.zones?.temperatureControl ?? {};
    for (const [id, data] of Object.entries(updates ?? {})) {
      let existing = this.state.tempZones.find((z) => z.id === id);
      if (!existing) {
        const cfg = tempConfig[id] ?? {};
        existing = {
          id,
          currentTemp: null,
          targetTemp: null,
          isHeating: false,
          ecoMode: false,
          minTemp: cfg.minTemperatureSetPointC ?? 20,
          maxTemp: cfg.maxTemperatureSetPointC ?? 40,
        };
        this.state.tempZones.push(existing);
      }
      // Observed fields — only trust reported
      if (source === 'reported') {
        if (data.temperature_ !== undefined) {
          existing.currentTemp = data.temperature_;
        }
        if (data.status_ !== undefined) {
          existing.isHeating = data.status_ !== 0;
        }
      }
      // Setpoint fields — only trust desired
      if (source === 'desired') {
        if (data.setPoint !== undefined) {
          existing.targetTemp = data.setPoint;
        }
        if (data.mode_?.eco !== undefined) {
          existing.ecoMode = data.mode_.eco;
        }
      }
    }
  }

  private mergeFlowZones(
    updates: NonNullable<ShadowReportedState['zones']>['flow'],
    source: 'reported' | 'desired',
  ): void {
    // Flow zones (active and speed) are entirely setpoint-driven for our
    // purposes. The spa's reported.speed is motor RPM, not the user's
    // selected speed, and reported.active oscillates during pump transitions.
    // Trust desired only — physical button presses on the spa update desired
    // too, so we won't miss external changes.
    if (source !== 'desired') {
      return;
    }
    for (const [id, data] of Object.entries(updates ?? {})) {
      let existing = this.state.flowZones.find((z) => z.id === id);
      if (!existing) {
        existing = this.createFlowZoneStub(id);
        this.state.flowZones.push(existing);
      }

      const last = this.flowLastPublished.get(id);
      const recentlyPublished = last !== undefined && Date.now() - last.at < REWRITE_GUARD_MS;

      if (data.active !== undefined && data.active !== existing.active) {
        if (recentlyPublished && last!.active !== data.active) {
          this.log.info(
            '[Pump %s] ignoring shadow active=%s (we just published active=%s)',
            id, data.active, last!.active,
          );
        } else {
          this.log.info('[Pump %s] desired active: %s → %s', id, existing.active, data.active);
          existing.active = data.active;
        }
      }

      if (typeof data.speed === 'number' && data.speed !== existing.speed) {
        if (recentlyPublished && last!.speed !== undefined && last!.speed !== data.speed) {
          this.log.info(
            '[Pump %s] ignoring shadow speed=%s (we just published speed=%s)',
            id, data.speed, last!.speed,
          );
        } else {
          this.log.info('[Pump %s] desired speed: %s → %s', id, existing.speed, data.speed);
          existing.speed = data.speed;
        }
      }
    }
  }

  private createFlowZoneStub(id: string): SpaFlowZone {
    const cfg = this.config.zones?.flow?.[id] ?? {};
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
    return {
      id,
      active: false,
      speed: 0,
      label: labelParts.length > 0 ? labelParts.join(' + ') : `Flow Zone ${id}`,
      icon,
    };
  }

  private mergeLightZones(
    updates: NonNullable<ShadowReportedState['zones']>['lighting'],
    source: 'reported' | 'desired',
  ): void {
    // Lighting is a setpoint (on/off command) — trust desired only.
    if (source !== 'desired') {
      return;
    }
    const lightConfig = this.config.zones?.lighting ?? {};
    for (const [id, data] of Object.entries(updates ?? {})) {
      let existing = this.state.lightZones.find((z) => z.id === id);
      if (!existing) {
        const cfg = lightConfig[id] ?? {};
        const label =
          cfg.lights && cfg.lights.length > 0
            ? cfg.lights.map((n) => `Light ${n}`).join(' + ')
            : `Light Zone ${id}`;
        existing = { id, active: false, label };
        this.state.lightZones.push(existing);
      }
      if (data.active !== undefined) {
        existing.active = data.active;
      }
    }
  }
}
