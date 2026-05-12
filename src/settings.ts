import type { PlatformConfig } from 'homebridge';

export const PLATFORM_NAME = 'GeckoSpa';
export const PLUGIN_NAME = 'homebridge-gecko';

// Auth0 (mobile-app client — matches what the Gecko iOS app uses)
export const AUTH0_DOMAIN = 'gecko-prod.us.auth0.com';
export const OAUTH2_CLIENT_ID = 'IlbhNGMeYfb8ovs0gK43CjPybltA3ogH';
export const OAUTH2_AUDIENCE = 'https://api.geckowatermonitor.com';
export const OAUTH2_REDIRECT_URI =
  'com.geckoportal.gecko://gecko-prod.us.auth0.com/capacitor/com.geckoportal.gecko/callback';
export const OAUTH2_SCOPE = 'openid profile email offline_access';

// Mobile-app user agent (some Auth0 endpoints behave differently for browsers vs apps)
export const MOBILE_USER_AGENT =
  'Gecko/1845930030 CFNetwork/1568.200.51 Darwin/24.0.0';

// Gecko REST API
export const API_BASE_URL = 'https://api.geckowatermonitor.com';

// Defaults
export const DEFAULT_POLL_INTERVAL = 300; // seconds — token keep-alive only; state is push via MQTT
export const SHADOW_INITIAL_WAIT_MS = 5_000;

// ───────── Config ─────────

export interface PumpConfig {
  /** Flow zone ID (matches the key in spa-configuration.zones.flow) */
  zoneId: string;
  /**
   * Number of speed levels. 1 = on/off only (Switch in HomeKit).
   * 2+ = multi-speed (Fanv2 with discrete RotationSpeed steps).
   */
  speeds: number;
}

export interface GeckoConfig extends PlatformConfig {
  email?: string;
  password?: string;
  refreshToken?: string;
  pollInterval?: number;
  /**
   * Override the maximum target temperature (Celsius). Use this to enable
   * temperatures above the spa-configuration-reported limit (e.g. 41 to reach
   * 106°F). The spa firmware still enforces its own ceiling — the override
   * only widens what HomeKit will let you ask for.
   */
  maxTempOverrideC?: number;
  /**
   * Override the minimum target temperature (Celsius).
   */
  minTempOverrideC?: number;
  /**
   * Per-flow-zone pump speed configuration. Pumps not listed default to a
   * smooth 0-100% Fanv2 slider.
   */
  pumps?: PumpConfig[];
}

// ───────── Auth0 token response ─────────

export interface Auth0TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}

// ───────── Gecko API response shapes ─────────

export interface GeckoAccount {
  accountId: number;
  name?: string;
}

export interface GeckoUserResponse {
  account: GeckoAccount;
}

export interface GeckoVessel {
  vesselId: number;
  monitorId: string;
  name: string;
  type?: string;
  protocolName?: string;
  [key: string]: unknown;
}

export interface GeckoVesselsResponse {
  vessels: GeckoVessel[];
}

export interface GeckoLiveStream {
  brokerUrl: string;
  expiresAt?: string;
  [key: string]: unknown;
}

// ───────── Spa configuration (from /spa-configuration endpoint) ─────────

export interface SpaConfiguration {
  accessories?: {
    pumps?: Record<string, AccessoryInfo>;
    lights?: Record<string, AccessoryInfo>;
    waterfalls?: Record<string, AccessoryInfo>;
    blowers?: Record<string, AccessoryInfo>;
  };
  zones?: {
    temperatureControl?: Record<string, TempZoneConfig>;
    flow?: Record<string, FlowZoneConfig>;
    lighting?: Record<string, LightingZoneConfig>;
  };
  [key: string]: unknown;
}

export type AccessoryInfo = Record<string, unknown>;

export interface TempZoneConfig {
  minTemperatureSetPointC?: number;
  maxTemperatureSetPointC?: number;
  [key: string]: unknown;
}

export interface FlowZoneConfig {
  pumps?: number[];
  waterfalls?: number[];
  blowers?: number[];
  [key: string]: unknown;
}

export interface LightingZoneConfig {
  lights?: number[];
  [key: string]: unknown;
}

// ───────── Shadow reported state ─────────

export interface ShadowDoc {
  state?: {
    reported?: ShadowReportedState;
    desired?: ShadowReportedState;
    current?: ShadowReportedState;
  };
}

export interface ShadowReportedState {
  zones?: {
    temperatureControl?: Record<string, ShadowTempControl>;
    lighting?: Record<string, ShadowLighting>;
    flow?: Record<string, ShadowFlow>;
  };
  features?: {
    operationMode?: number;
    rf?: { channel?: number; strength_?: number };
  };
  connectivity_?: {
    gatewayStatus?: string;
    vesselStatus?: string;
  };
}

export interface ShadowTempControl {
  temperature_?: number;
  setPoint?: number;
  status_?: number; // 0 = idle, non-zero = heating
  mode_?: { eco?: boolean };
  flo_?: string;
}

export interface ShadowLighting {
  active?: boolean;
}

export interface ShadowFlow {
  active?: boolean;
  speed?: number;
  initiators_?: string[];
}

// ───────── Normalised spa state for the accessory ─────────

export interface SpaTempZone {
  id: string;
  currentTemp: number | null;
  targetTemp: number | null;
  isHeating: boolean;
  ecoMode: boolean;
  minTemp: number;
  maxTemp: number;
}

export interface SpaFlowZone {
  id: string;
  active: boolean;
  speed: number;
  label: string;
  icon: 'pump' | 'waterfall' | 'blower';
}

export interface SpaLightZone {
  id: string;
  active: boolean;
  label: string;
}

export interface SpaState {
  tempZones: SpaTempZone[];
  flowZones: SpaFlowZone[];
  lightZones: SpaLightZone[];
  watercareMode: number | null;
  gatewayConnected: boolean;
  vesselRunning: boolean;
}

export function emptySpaState(): SpaState {
  return {
    tempZones: [],
    flowZones: [],
    lightZones: [],
    watercareMode: null,
    gatewayConnected: false,
    vesselRunning: false,
  };
}

// ───────── Watercare modes (operationMode integer ↔ name) ─────────

export const WATERCARE_MODE_NAMES: Record<number, string> = {
  0: 'Away',
  1: 'Standard',
  2: 'Energy Savings',
  3: 'Super Energy Savings',
  4: 'Weekender',
};

export const WATERCARE_MODE_VALUES: number[] = [0, 1, 2, 3, 4];
