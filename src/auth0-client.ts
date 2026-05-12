import { randomBytes, createHash } from 'crypto';
import type { Logger } from 'homebridge';
import {
  AUTH0_DOMAIN,
  MOBILE_USER_AGENT,
  OAUTH2_AUDIENCE,
  OAUTH2_CLIENT_ID,
  OAUTH2_REDIRECT_URI,
  OAUTH2_SCOPE,
  type Auth0TokenResponse,
} from './settings';

/**
 * Minimal cookie jar — Auth0 only needs short-lived session cookies preserved
 * across the identifier → password → resume redirect chain.
 */
class CookieJar {
  private cookies = new Map<string, string>();

  ingest(response: Response): void {
    // Node 20+ supports headers.getSetCookie()
    const setCookies =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get('set-cookie') ?? ''].filter(Boolean);

    for (const sc of setCookies) {
      const firstPair = sc.split(';')[0];
      const eq = firstPair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function randomState(): string {
  return base64UrlEncode(randomBytes(32));
}

/**
 * Auth0 client that emulates the Gecko mobile app's PKCE + identifier-first
 * login flow. This is the same approach used by the community HA integration
 * (gecko-intouch3-home-assistant).
 */
export class Auth0Client {
  constructor(private readonly log: Logger) {}

  async authenticate(username: string, password: string): Promise<Auth0TokenResponse> {
    this.log.info('Auth0 authentication starting...');

    const { verifier, challenge } = generatePkcePair();
    const jar = new CookieJar();

    const state = await this.getAuthState(challenge, jar);
    const code = await this.submitCredentials(username, password, state, jar);
    const tokens = await this.exchangeCodeForTokens(code, verifier);

    this.log.info('Auth0 authentication successful');
    return tokens;
  }

  async refreshTokens(refreshToken: string): Promise<Auth0TokenResponse> {
    const url = `https://${AUTH0_DOMAIN}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: OAUTH2_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        'User-Agent': MOBILE_USER_AGENT,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    return (await res.json()) as Auth0TokenResponse;
  }

  // ── Step 1: GET /authorize, follow redirects, extract state from URL ──

  private async getAuthState(codeChallenge: string, jar: CookieJar): Promise<string> {
    const params = new URLSearchParams({
      client_id: OAUTH2_CLIENT_ID,
      scope: OAUTH2_SCOPE,
      display: 'touch',
      audience: OAUTH2_AUDIENCE,
      redirect_uri: OAUTH2_REDIRECT_URI,
      prompt: 'login',
      response_type: 'code',
      response_mode: 'query',
      state: randomState(),
      nonce: randomState(),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      auth0Client: Buffer.from('{"name":"auth0-vue","version":"2.3.1"}').toString('base64'),
    });

    const authorizeUrl = `https://${AUTH0_DOMAIN}/authorize?${params.toString()}`;

    // Follow redirect chain manually so we can collect cookies along the way.
    let currentUrl = authorizeUrl;
    for (let hops = 0; hops < 6; hops++) {
      const res = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': MOBILE_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          Cookie: jar.header(),
        },
      });
      jar.ingest(res);

      // Look for the state param in either the current URL (after redirect) or the Location header.
      const stateMatch = /[?&]state=([^&]+)/.exec(currentUrl);
      if (
        stateMatch &&
        (currentUrl.includes('/u/login/identifier') || currentUrl.includes('/u/login'))
      ) {
        return decodeURIComponent(stateMatch[1]);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          break;
        }
        currentUrl = loc.startsWith('/') ? `https://${AUTH0_DOMAIN}${loc}` : loc;
        continue;
      }

      // Final URL after redirects — check for state param.
      const final = (res.url ?? currentUrl);
      const finalMatch = /[?&]state=([^&]+)/.exec(final);
      if (finalMatch) {
        return decodeURIComponent(finalMatch[1]);
      }
      break;
    }

    throw new Error('Could not extract Auth0 state from /authorize redirects');
  }

  // ── Step 2: POST username then password, capture auth code ──

  private async submitCredentials(
    username: string,
    password: string,
    state: string,
    jar: CookieJar,
  ): Promise<string> {
    // 2a. Submit identifier
    const identifierUrl = `https://${AUTH0_DOMAIN}/u/login/identifier?state=${encodeURIComponent(state)}`;
    const identifierBody = new URLSearchParams({
      state,
      username,
      'js-available': 'true',
      'webauthn-available': 'true',
      'is-brave': 'false',
      'webauthn-platform-available': 'false',
      action: 'default',
    });

    const idRes = await fetch(identifierUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: `https://${AUTH0_DOMAIN}`,
        Referer: identifierUrl,
        'User-Agent': MOBILE_USER_AGENT,
        Cookie: jar.header(),
      },
      body: identifierBody,
    });
    jar.ingest(idRes);

    if (idRes.status === 400) {
      throw new Error('Invalid username');
    }
    if (idRes.status === 429) {
      throw new Error('Auth0 rate limit — try again later');
    }
    if (idRes.status !== 302 && idRes.status !== 303) {
      const txt = await idRes.text();
      throw new Error(`Identifier submission failed (${idRes.status}): ${txt.slice(0, 200)}`);
    }

    // 2b. Submit password
    const passwordUrl = `https://${AUTH0_DOMAIN}/u/login/password?state=${encodeURIComponent(state)}`;
    const passwordBody = new URLSearchParams({
      state,
      username,
      password,
      action: 'default',
    });

    const pwRes = await fetch(passwordUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: `https://${AUTH0_DOMAIN}`,
        Referer: passwordUrl,
        'User-Agent': MOBILE_USER_AGENT,
        Cookie: jar.header(),
      },
      body: passwordBody,
    });
    jar.ingest(pwRes);

    if (pwRes.status === 400) {
      throw new Error('Invalid username or password');
    }
    if (pwRes.status === 429) {
      throw new Error('Auth0 rate limit — try again later');
    }
    if (pwRes.status !== 302 && pwRes.status !== 303) {
      const txt = await pwRes.text();
      throw new Error(`Password submission failed (${pwRes.status}): ${txt.slice(0, 200)}`);
    }

    // 2c. Follow the redirect chain until we land on the redirect_uri with code=…
    let location = pwRes.headers.get('location');
    if (!location) {
      throw new Error('No Location header after password submission');
    }

    for (let hops = 0; hops < 6; hops++) {
      const nextUrl = location.startsWith('/') ? `https://${AUTH0_DOMAIN}${location}` : location;

      // If we landed on the redirect_uri, extract the code.
      if (nextUrl.startsWith(OAUTH2_REDIRECT_URI) || nextUrl.includes('code=')) {
        const codeMatch = /[?&]code=([^&]+)/.exec(nextUrl);
        if (codeMatch) {
          return decodeURIComponent(codeMatch[1]);
        }
      }

      const res = await fetch(nextUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': MOBILE_USER_AGENT,
          Cookie: jar.header(),
        },
      });
      jar.ingest(res);

      const loc = res.headers.get('location');
      if (loc) {
        location = loc;
        continue;
      }

      // Some Auth0 deployments embed the code in the response body's <script> tag.
      const body = await res.text();
      const codeInBody = /code=([A-Za-z0-9_-]+)/.exec(body);
      if (codeInBody) {
        return codeInBody[1];
      }

      break;
    }

    throw new Error('Could not extract authorization code from redirect chain');
  }

  // ── Step 3: exchange code for tokens ──

  private async exchangeCodeForTokens(code: string, verifier: string): Promise<Auth0TokenResponse> {
    const url = `https://${AUTH0_DOMAIN}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH2_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OAUTH2_REDIRECT_URI,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: '*/*',
        'User-Agent': MOBILE_USER_AGENT,
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }

    return (await res.json()) as Auth0TokenResponse;
  }
}

// Helper — decode `sub` claim from a JWT access token without verification.
export function extractSubFromJwt(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4 !== 0) {
      payload += '=';
    }
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Record<string, unknown>;
    return typeof decoded.sub === 'string' ? decoded.sub : null;
  } catch {
    return null;
  }
}
