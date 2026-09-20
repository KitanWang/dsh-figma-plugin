/**
 * Figma OAuth 2.0 mechanics, as pure functions.
 *
 * This module owns protocol shape and nothing else: no storage, no HTTP
 * server, no Cordis. That split is deliberate — the authorization-code flow is
 * the one part of the connection that must be exactly right, and keeping it
 * free of I/O makes every branch testable without a network or a Figma
 * account.
 *
 * Two Figma constraints shape the whole design:
 *
 * 1. Figma only supports the authorization-code flow (`response_type=code`),
 *    and its token endpoint authenticates the client with HTTP Basic
 *    (`client_id:client_secret`). PKCE is supported and is sent as defence in
 *    depth, but it does not replace the secret: a public client with no secret
 *    is rejected. There is no way to ship a working built-in client secret, so
 *    the user registers their own OAuth app and supplies the pair.
 *
 * 2. Authorization codes expire after 30 seconds, so the exchange must happen
 *    immediately in the callback and must not queue behind anything slow.
 *
 * @module dsh-figma/oauth
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Figma's authorization page, where the human signs in and consents. */
export const DEFAULT_AUTHORIZATION_URL = 'https://www.figma.com/oauth';

/** Exchanges an authorization code for the first access/refresh token pair. */
export const DEFAULT_TOKEN_URL = 'https://api.figma.com/v1/oauth/token';

/** Mints a fresh access token from a stored refresh token. */
export const DEFAULT_REFRESH_URL = 'https://api.figma.com/v1/oauth/refresh';

/**
 * Scopes the bundled tools need, as one space-separated string.
 *
 * `file_variables:read` is Enterprise-only: a non-Enterprise account sees the
 * variable endpoints fail while every other tool keeps working, which the
 * variable tools already report as a plan limitation rather than a fault.
 */
export const DEFAULT_SCOPES = [
  'current_user:read',
  'file_content:read',
  'file_metadata:read',
  'file_comments:read',
  'file_comments:write',
  'file_dev_resources:read',
  'file_variables:read',
  'library_content:read',
  'library_assets:read',
].join(' ');

/** How long one pending authorization stays acceptable, in milliseconds. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/** Thrown when the OAuth protocol itself cannot proceed. */
export class FigmaOAuthError extends Error {
  /**
   * @param message - message safe to show the user.
   * @param details - Figma's machine code and the failing endpoint.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'FigmaOAuthError';
    this.code = details.code;
    this.endpoint = details.endpoint;
    this.status = details.status;
  }
}

/**
 * Whether an OAuth client can be used at all.
 *
 * The secret is mandatory for Figma's token endpoint. A configuration missing
 * either half is "not set up yet", which the UI reports as a setup step rather
 * than as a failure.
 *
 * @param client - candidate client credentials.
 * @returns true when both halves are present.
 */
export function hasClientCredentials(client) {
  return (
    client !== null &&
    typeof client === 'object' &&
    typeof client.clientId === 'string' &&
    client.clientId.trim().length > 0 &&
    typeof client.clientSecret === 'string' &&
    client.clientSecret.trim().length > 0
  );
}

/** URL-safe base64 without padding, the encoding PKCE and OAuth state use. */
function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh, high-entropy `state` value for one authorization attempt. */
export function createState() {
  return base64Url(randomBytes(32));
}

/** A fresh PKCE `code_verifier` (43–128 characters of unreserved alphabet). */
export function createCodeVerifier() {
  return base64Url(randomBytes(48));
}

/**
 * Derive the S256 `code_challenge` for a verifier.
 *
 * @param verifier - the `code_verifier` that will be replayed at exchange.
 * @returns the unpadded base64url SHA-256 digest.
 */
export function createCodeChallenge(verifier) {
  return base64Url(createHash('sha256').update(String(verifier), 'ascii').digest());
}

/**
 * Constant-time comparison for a returned `state`.
 *
 * The callback arrives as an unauthenticated top-level navigation, so `state`
 * is the only thing proving the response belongs to an attempt this process
 * started.
 *
 * @param received - the state Figma returned.
 * @param expected - the state this process generated.
 * @returns true when they match.
 */
export function stateMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Build the authorization URL the human is sent to.
 *
 * @param options - client id, redirect URI, scopes, state, and PKCE challenge.
 * @returns the absolute figma.com URL.
 */
export function authorizationUrl(options) {
  const url = new URL(options.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('scope', options.scopes);
  url.searchParams.set('state', options.state);
  url.searchParams.set('response_type', 'code');
  if (typeof options.codeChallenge === 'string' && options.codeChallenge.length > 0) {
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** HTTP Basic header value carrying the OAuth client identity. */
function basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

/** Read a JSON body, tolerating Figma's plain-text error pages. */
async function readBody(response) {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Turn a failed token response into a message that names the real cause. */
function describeTokenFailure(payload, status, endpoint) {
  const code = payload !== null && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error : undefined;
  const detail =
    payload !== null && typeof payload === 'object' && typeof payload.error_description === 'string'
      ? payload.error_description
      : typeof payload === 'string' && payload.trim().length > 0
        ? payload.trim().slice(0, 300)
        : undefined;
  const hints = {
    invalid_grant: 'the authorization code was already used, expired (Figma allows 30 seconds), or the redirect URI does not match the one registered on the app',
    invalid_client: 'the Client ID or Client Secret is wrong, or the app is still in draft state',
    unauthorized_client: 'this OAuth app is not permitted to use the authorization-code flow',
  };
  const hint = code !== undefined ? hints[code] : undefined;
  return [code === undefined ? `HTTP ${status}` : code, detail, hint].filter((part) => part !== undefined).join(' — ');
}

/**
 * Exchange an authorization code for the first token pair.
 *
 * @param options - URLs, client credentials, code, redirect URI, verifier, and cancellation.
 * @returns the normalized grant.
 * @throws {FigmaOAuthError} when Figma refuses the exchange.
 */
export async function exchangeAuthorizationCode(options) {
  const endpoint = options.tokenUrl ?? DEFAULT_TOKEN_URL;
  const body = new URLSearchParams({
    redirect_uri: options.redirectUri,
    code: options.code,
    grant_type: 'authorization_code',
  });
  if (typeof options.codeVerifier === 'string' && options.codeVerifier.length > 0) {
    body.set('code_verifier', options.codeVerifier);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: basicAuth(options.clientId, options.clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal: options.signal,
  });
  const payload = await readBody(response);
  if (!response.ok) {
    throw new FigmaOAuthError(
      `Figma refused the token exchange: ${describeTokenFailure(payload, response.status, endpoint)}`,
      { code: payload?.error, endpoint, status: response.status },
    );
  }
  return normalizeGrant(payload, options.now);
}

/**
 * Mint a fresh access token from a stored refresh token.
 *
 * Figma keeps exactly one access token per app per user, so a successful
 * refresh invalidates the previous one; the caller must persist the result.
 *
 * @param options - URLs, client credentials, refresh token, and cancellation.
 * @returns the normalized grant, carrying the old refresh token when Figma omits a new one.
 * @throws {FigmaOAuthError} when Figma refuses the refresh.
 */
export async function refreshAccessToken(options) {
  const endpoint = options.refreshUrl ?? DEFAULT_REFRESH_URL;
  const body = new URLSearchParams({ refresh_token: options.refreshToken });
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      authorization: basicAuth(options.clientId, options.clientSecret),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
    signal: options.signal,
  });
  const payload = await readBody(response);
  if (!response.ok) {
    throw new FigmaOAuthError(
      `Figma refused to refresh the access token: ${describeTokenFailure(payload, response.status, endpoint)}`,
      { code: payload?.error, endpoint, status: response.status },
    );
  }
  const grant = normalizeGrant(payload, options.now);
  if (grant.refreshToken === undefined && typeof options.refreshToken === 'string') {
    return { ...grant, refreshToken: options.refreshToken };
  }
  return grant;
}

/**
 * Normalize Figma's token response into the shape this plugin persists.
 *
 * @param payload - the decoded token response.
 * @param now - injectable clock, for tests.
 * @returns the grant with an absolute expiry when Figma sent `expires_in`.
 * @throws {FigmaOAuthError} when the response carries no access token.
 */
export function normalizeGrant(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object' || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new FigmaOAuthError('Figma returned no access token');
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token.length > 0
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
    ...(typeof payload.user_id_string === 'string' && payload.user_id_string.length > 0
      ? { userId: payload.user_id_string }
      : {}),
  };
}

/** How long before real expiry a token is treated as stale, in milliseconds. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether a stored grant needs refreshing before its next use.
 *
 * A grant with no recorded expiry is assumed valid: Figma only omits
 * `expires_in` for non-expiring credentials, and guessing an expiry there
 * would refresh needlessly.
 *
 * @param grant - the stored grant.
 * @param now - injectable clock.
 * @returns true when the access token should be refreshed first.
 */
export function needsRefresh(grant, now = Date.now()) {
  if (grant === null || typeof grant !== 'object') return true;
  if (typeof grant.accessToken !== 'string' || grant.accessToken.length === 0) return true;
  if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) return false;
  return grant.expiresAt - REFRESH_SKEW_MS <= now;
}

/**
 * Validate a persisted grant read back from the credential store.
 *
 * The store returns the payload verbatim, so a record written by an older or
 * foreign version must not be trusted blindly.
 *
 * @param payload - the decoded record payload.
 * @returns the grant, or undefined when the payload is not a usable grant.
 */
export function asGrant(payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  if (typeof payload.accessToken !== 'string' || payload.accessToken.length === 0) return undefined;
  return {
    accessToken: payload.accessToken,
    ...(typeof payload.refreshToken === 'string' && payload.refreshToken.length > 0
      ? { refreshToken: payload.refreshToken }
      : {}),
    ...(typeof payload.expiresAt === 'number' && Number.isFinite(payload.expiresAt) ? { expiresAt: payload.expiresAt } : {}),
    ...(typeof payload.tokenType === 'string' ? { tokenType: payload.tokenType } : {}),
    ...(typeof payload.userId === 'string' ? { userId: payload.userId } : {}),
    ...(typeof payload.obtainedAt === 'number' ? { obtainedAt: payload.obtainedAt } : {}),
    ...(typeof payload.scopes === 'string' ? { scopes: payload.scopes } : {}),
  };
}

/**
 * The redirect URI to register on the user's Figma OAuth app.
 *
 * Figma matches redirect URLs exactly, so this value is shown verbatim in the
 * connection panel for the user to paste into their app's configuration.
 *
 * @param options - explicit override, loopback host, port, and callback path.
 * @returns the absolute callback URL.
 */
export function defaultRedirectUri(options) {
  if (typeof options.redirectUri === 'string' && options.redirectUri.trim().length > 0) {
    return options.redirectUri.trim();
  }
  const host = options.host === '0.0.0.0' ? '127.0.0.1' : (options.host ?? '127.0.0.1');
  return `http://${host}:${String(options.port)}${options.callbackPath ?? '/figma/oauth/callback'}`;
}

/**
 * Whether a URL is an acceptable redirect target for this plugin.
 *
 * Only loopback HTTP is allowed by default: an OAuth callback carries a
 * one-time code in the query string, and accepting an arbitrary registered
 * URL would send that code somewhere this process cannot vouch for.
 *
 * @param value - the redirect URI to check.
 * @returns true when the URL is absolute http(s) on a loopback host.
 */
export function isLoopbackRedirect(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname === '::1';
}
