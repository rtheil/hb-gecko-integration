import type { Logger } from 'homebridge';
import { Auth0Client, extractSubFromJwt } from './auth0-client';
import {
  API_BASE_URL,
  type GeckoLiveStream,
  type GeckoUserResponse,
  type GeckoVessel,
  type GeckoVesselsResponse,
  type SpaConfiguration,
} from './settings';

export class GeckoApi {
  private readonly auth0: Auth0Client;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(log: Logger) {
    this.auth0 = new Auth0Client(log);
  }

  // ── Authentication ───────────────────────────────────────────

  async authenticateWithPassword(email: string, password: string): Promise<void> {
    const tokens = await this.auth0.authenticate(email, password);
    this.storeTokens(tokens);
  }

  async authenticateWithRefreshToken(refreshToken: string): Promise<void> {
    this.refreshToken = refreshToken;
    const tokens = await this.auth0.refreshTokens(refreshToken);
    this.storeTokens(tokens);
  }

  async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }
    const tokens = await this.auth0.refreshTokens(this.refreshToken);
    this.storeTokens(tokens);
  }

  async ensureValidToken(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - 60_000) {
      await this.refreshAccessToken();
    }
    return this.accessToken!;
  }

  getRefreshToken(): string | null {
    return this.refreshToken;
  }

  private storeTokens(tokens: { access_token: string; refresh_token?: string; expires_in: number }): void {
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }
    this.tokenExpiresAt = Date.now() + tokens.expires_in * 1000;
  }

  // ── Gecko REST API ───────────────────────────────────────────

  /**
   * PUT /v2/users — registers the device session and returns the account info.
   * This is the call the mobile app makes immediately after login.
   */
  async registerUserAndGetAccount(email: string): Promise<GeckoUserResponse> {
    const userId = extractSubFromJwt(this.accessToken ?? '');
    if (!userId) {
      throw new Error('Could not extract user ID from access token');
    }

    const payload = {
      user: { userId, email },
      deviceInfo: {
        deviceId: 'homebridge-gecko',
        platform: 'android',
        operatingSystem: 'android',
        model: 'Homebridge',
        manufacturer: 'homebridge-gecko',
        osVersion: '13',
        appVersion: '3.7.1',
        appBuild: '168',
      },
    };

    return this.apiRequest<GeckoUserResponse>('PUT', '/v2/users', payload);
  }

  /**
   * GET /v3/accounts/{accountId}/vessels — list vessels for the account.
   */
  async getVessels(accountId: number): Promise<GeckoVessel[]> {
    const data = await this.apiRequest<GeckoVesselsResponse>(
      'GET',
      `/v3/accounts/${accountId}/vessels?customActionsVersion=5`,
    );
    return data.vessels ?? [];
  }

  /**
   * GET /accounts/{accountId}/monitors/{monitorId}/spa-configuration
   * Note: this endpoint does NOT have a /v2 or /v3 prefix.
   */
  async getSpaConfiguration(accountId: number, monitorId: string): Promise<SpaConfiguration> {
    return this.apiRequest<SpaConfiguration>(
      'GET',
      `/accounts/${accountId}/monitors/${encodeURIComponent(monitorId)}/spa-configuration`,
    );
  }

  /**
   * GET /v2/monitors/{monitorId}/liveStream — returns the AWS IoT broker URL
   * with embedded custom-authorizer credentials.
   */
  async getMonitorLiveStream(monitorId: string): Promise<GeckoLiveStream> {
    return this.apiRequest<GeckoLiveStream>(
      'GET',
      `/v2/monitors/${encodeURIComponent(monitorId)}/liveStream`,
    );
  }

  // ── Helper ───────────────────────────────────────────────────

  private async apiRequest<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.ensureValidToken();

    const res = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gecko API ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    }

    return (await res.json()) as T;
  }
}
