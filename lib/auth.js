/**
 * Figma connection state: the one authority on whether this plugin can talk to
 * Figma, and on what it should do about it.
 *
 * Everything that needs a token asks this module, so the precedence rules live
 * in exactly one place:
 *
 * 1. an OAuth grant in the harness credential store (the default, and the only
 *    mode that can refresh itself),
 * 2. a personal access token from config, environment, or the credential store
 *    (kept working for headless and CI use),
 * 3. nothing — which `figma_login` and the connection panel resolve.
 *
 * The store is consulted per call, never cached across calls, so a token
 * rotated outside this process reaches the next tool call without a restart.
 *
 * @module dsh-figma/auth
 */

import {
  AUTHORIZATION_TTL_MS,
  FigmaOAuthError,
  asGrant,
  authorizationUrl,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  defaultRedirectUri,
  exchangeAuthorizationCode,
  needsRefresh,
  refreshAccessToken,
  stateMatches,
} from './oauth.js';
import { resolveOAuthApp } from './oauth-app.js';

/** Credential-record scope: the registered name of the plugin that owns the record. */
export const RECORD_SCOPE = 'figma';

/** Credential-record id holding the OAuth grant. */
export const RECORD_ID = 'oauth';

/**
 * The connection's durable half: the OAuth grant and the authorization
 * attempts that produce it.
 *
 * The plugin ships its own OAuth app (see `lib/oauth-app.js`), so nothing here
 * takes user-supplied credentials: the user's only job is to approve the
 * request on Figma's consent page. Every method degrades rather than throws
 * when the credential service is absent.
 */
export class FigmaConnection {
  #ctx;

  #config;

  /** Pending authorization attempts, keyed by `state`. At most a couple live at once. */
  #pending = new Map();

  /** Serializes token acquisition so concurrent tool calls refresh once, not once each. */
  #flight = null;

  /** Set by the route layer so the panel can show the exact URL Figma must match. */
  #redirectUri;

  /** Fetch implementation used for token endpoints; injectable for tests and proxies. */
  #fetch;

  /**
   * Resolves the OAuth client. Injectable so a test can exercise the
   * "no client in this build" path without depending on what the shipped
   * `lib/oauth-app.js` happens to contain.
   */
  #resolveApp;

  /**
   * @param ctx - plugin context, for the optional credential service.
   * @param config - resolved plugin config.
   * @param options - redirect URI override, injectable fetch, and OAuth-client resolver.
   */
  constructor(ctx, config, options = {}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.#resolveApp = options.resolveApp ?? resolveOAuthApp;
    this.RecordScope = RECORD_SCOPE;
    this.RecordId = RECORD_ID;
  }

  /** The credential service, or undefined when this profile does not mount one. */
  get #credentials() {
    return this.#ctx?.get?.('credentials');
  }

  /** Whether the OAuth flow can run at all in this deployment. */
  get oauthSupported() {
    return this.#credentials !== undefined;
  }

  /**
   * The OAuth client this plugin signs users in with.
   *
   * It is a property of the deployment, not of the user: the plugin ships its
   * own app so nobody has to register one or paste a secret. See
   * `lib/oauth-app.js` for how a deployment supplies it.
   *
   * @returns the client credentials, or undefined when this build carries none.
   */
  client() {
    return this.#resolveApp(this.#config);
  }

  /** Whether this deployment has a usable OAuth client at all. */
  get appConfigured() {
    return this.client() !== undefined;
  }

  /** The credential-store address of the OAuth grant. */
  async #recordKey() {
    const { credentialKey } = await import('@deepseek-ai/dsh-credentials');
    return credentialKey(RECORD_SCOPE, RECORD_ID);
  }

  /**
   * Read the stored grant without touching the network.
   *
   * @returns the grant, or undefined when none is stored or no store is mounted.
   */
  async storedGrant() {
    const credentials = this.#credentials;
    if (credentials === undefined) return undefined;
    try {
      const record = await credentials.readRecord(await this.#recordKey());
      if (record === undefined || record.kind !== 'grant') return undefined;
      return asGrant(record.payload);
    } catch {
      return undefined;
    }
  }

  /**
   * Commit a grant to the credential store.
   *
   * `modifyRecord` is the seam's only write path, and it is a read-modify-write
   * under an exclusive lock — which is what makes a concurrent refresh safe.
   *
   * @param grant - the grant to persist.
   * @throws {FigmaOAuthError} when no store is mounted.
   */
  async #commit(grant) {
    const credentials = this.#credentials;
    if (credentials === undefined) {
      throw new FigmaOAuthError('this deployment mounts no credential store, so an OAuth grant cannot be saved');
    }
    const payload = { ...grant, obtainedAt: Date.now(), scopes: this.#config.scopes };
    try {
      await credentials.modifyRecord(await this.#recordKey(), async () => ({ kind: 'grant', payload }));
    } catch (error) {
      throw new FigmaOAuthError(`the OAuth grant could not be saved: ${error?.message ?? String(error)}`);
    }
  }

  /** Remove the stored grant; a no-op when nothing is stored. */
  async forget() {
    const credentials = this.#credentials;
    if (credentials === undefined) return;
    try {
      await credentials.deleteRecord(await this.#recordKey());
    } catch {
      // An absent record or an unwritable store both mean "already signed out".
    }
  }

  /**
   * Resolve an access token for one call, refreshing when needed.
   *
   * Precedence is OAuth first, then a personal access token. A failed refresh
   * does not delete the grant: the user may be offline, and the panel should
   * report a reconnect rather than silently forgetting a valid refresh token.
   *
   * @param options - cancellation.
   * @returns the token plus how it was obtained.
   * @throws {FigmaOAuthError} when nothing usable is configured.
   */
  async accessToken(options = {}) {
    const grant = await this.storedGrant();
    if (grant !== undefined) {
      if (!needsRefresh(grant)) {
        return { token: grant.accessToken, source: 'oauth', mode: 'oauth', grant };
      }
      if (typeof grant.refreshToken !== 'string' || grant.refreshToken.length === 0) {
        return { token: grant.accessToken, source: 'oauth (no refresh token)', mode: 'oauth', grant };
      }
      const refreshed = await this.#refresh(grant, options);
      return { token: refreshed.accessToken, source: 'oauth (refreshed)', mode: 'oauth', grant: refreshed };
    }
    throw new FigmaOAuthError(
      'Figma is not connected. The user can connect from Settings → Figma.',
    );
  }

  /** Refresh serially, so N concurrent tool calls produce one refresh. */
  async #refresh(grant, options) {
    if (this.#flight !== null) return this.#flight;
    const run = (async () => {
      // Re-read under the flight: another process (or a browser sign-in) may
      // have already rotated the token while this call waited.
      const current = await this.storedGrant();
      if (current !== undefined && !needsRefresh(current)) return current;
      const active = current ?? grant;
      const client = this.client();
      if (client === undefined) {
        throw new FigmaOAuthError('the stored Figma grant needs refreshing, but this build carries no OAuth client; reconnect from Settings → Figma');
      }
      let refreshed;
      try {
        refreshed = await refreshAccessToken({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          refreshToken: active.refreshToken,
          refreshUrl: this.#config.refreshUrl,
          signal: options.signal,
          now: Date.now(),
          fetch: this.#fetch,
        });
      } catch (error) {
        throw error instanceof FigmaOAuthError
          ? error
          : new FigmaOAuthError(`refreshing the Figma access token failed: ${error?.message ?? String(error)}`);
      }
      await this.#commit(refreshed);
      return refreshed;
    })();
    this.#flight = run;
    try {
      return await run;
    } finally {
      if (this.#flight === run) this.#flight = null;
    }
  }

  /**
   * The exact redirect URL registered on the user's Figma OAuth app.
   *
   * The route layer sets this from the live listening port, which is the only
   * place the real value is known (a port of 0 is chosen by the OS at bind).
   *
   * @returns the absolute callback URL, or a documented placeholder.
   */
  redirectUri() {
    if (typeof this.#redirectUri === 'string' && this.#redirectUri.length > 0) return this.#redirectUri;
    // The route is always registered on the GUI's own server, so the live GUI
    // port is the only correct value. A deployment behind a reverse proxy
    // overrides the whole URL with `redirectUri` instead.
    return defaultRedirectUri({
      redirectUri: this.#config.redirectUri,
      port: 3080,
      callbackPath: this.#config.callbackPath,
    });
  }

  /** Set the redirect URI once the HTTP server has actually bound. */
  setRedirectUri(value) {
    if (typeof value === 'string' && value.length > 0) this.#redirectUri = value;
  }

  /**
   * Start an authorization attempt and return where to send the human.
   *
   * The attempt is remembered under its `state`, so the callback route can
   * prove the response belongs to it and can complete the exchange in the
   * request that carries the code (Figma's codes expire in 30 seconds).
   *
   * @returns the authorization URL, its state, and whether it reuses a live attempt.
   * @throws {FigmaOAuthError} when this build has no OAuth app or no credential store.
   */
  async beginAuthorization() {
    if (!this.oauthSupported) {
      throw new FigmaOAuthError('this deployment mounts no credential store, so OAuth sign-in is unavailable');
    }
    const client = this.client();
    if (client === undefined) {
      throw new FigmaOAuthError(
        'this build carries no Figma OAuth client, so sign-in cannot start. A deployment can supply one in lib/oauth-app.js or through FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET.',
      );
    }
    const active = [...this.#pending.values()].find((attempt) => attempt.status === 'pending');
    if (active !== undefined) {
      return { url: active.url, state: active.state, startedAt: active.startedAt, reused: true };
    }
    const state = createState();
    const verifier = createCodeVerifier();
    const redirectUri = this.redirectUri();
    const url = authorizationUrl({
      authorizationUrl: this.#config.authorizationUrl,
      clientId: client.clientId,
      redirectUri,
      scopes: this.#config.scopes,
      state,
      codeChallenge: createCodeChallenge(verifier),
    });
    const attempt = {
      state,
      verifier,
      url,
      redirectUri,
      startedAt: Date.now(),
      status: 'pending',
      error: undefined,
    };
    this.#pending.set(state, attempt);
    this.#sweep();
    return { url, state, startedAt: attempt.startedAt, reused: false };
  }

  /** Drop expired attempts so a long-idle process does not accumulate them. */
  #sweep() {
    const cutoff = Date.now() - AUTHORIZATION_TTL_MS;
    for (const [state, attempt] of this.#pending) {
      if (attempt.status === 'pending' && attempt.startedAt < cutoff) {
        attempt.status = 'expired';
        attempt.error = 'the authorization attempt expired before Figma redirected back';
      }
    }
  }

  /**
   * Which attempt, if any, a returned `state` names.
   *
   * @param state - the `state` query parameter from the callback.
   * @returns the pending attempt, or undefined when the state is unknown.
   */
  findAttempt(state) {
    this.#sweep();
    for (const attempt of this.#pending.values()) {
      if (stateMatches(state, attempt.state)) return attempt;
    }
    return undefined;
  }

  /**
   * Complete an attempt from the callback's query parameters.
   *
   * Runs the exchange with the verifier stored on the attempt, persists the
   * grant, and records the outcome so a polling panel sees it. Never throws:
   * the HTTP handler must always be able to render a result page.
   *
   * @param params - the callback query parameters and any Figma-reported error.
   * @returns the settled attempt.
   */
  async completeAuthorization(params) {
    const attempt = this.findAttempt(params.state);
    if (attempt === undefined) {
      return {
        status: 'unknown-state',
        error: 'this callback does not match any pending Figma authorization; start the connection again from Settings → Figma',
      };
    }
    if (attempt.status !== 'pending') {
      return { status: attempt.status, error: attempt.error, state: attempt.state };
    }
    // The human pressed "Cancel" on Figma's consent screen.
    if (typeof params.error === 'string' && params.error.length > 0) {
      attempt.status = 'denied';
      attempt.error =
        params.error === 'access_denied'
          ? 'access was declined on Figma\'s consent screen'
          : `${params.error}${typeof params.errorDescription === 'string' ? `: ${params.errorDescription}` : ''}`;
      return { status: attempt.status, error: attempt.error, state: attempt.state };
    }
    if (typeof params.code !== 'string' || params.code.length === 0) {
      attempt.status = 'failed';
      attempt.error = 'Figma redirected back without an authorization code';
      return { status: attempt.status, error: attempt.error, state: attempt.state };
    }
    const client = this.client();
    if (client === undefined) {
      attempt.status = 'failed';
      attempt.error = 'this build carries no Figma OAuth client, so the code cannot be exchanged';
      return { status: attempt.status, error: attempt.error, state: attempt.state };
    }
    try {
      const grant = await exchangeAuthorizationCode({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code: params.code,
        redirectUri: attempt.redirectUri,
        codeVerifier: attempt.verifier,
        tokenUrl: this.#config.tokenUrl,
        now: Date.now(),
        fetch: this.#fetch,
      });
      await this.#commit(grant);
      attempt.status = 'authorized';
      attempt.grant = grant;
      attempt.error = undefined;
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = error?.message ?? String(error);
    }
    return { status: attempt.status, error: attempt.error, state: attempt.state };
  }

  /** The live attempt, for a panel that polls while the browser is away. */
  currentAttempt() {
    this.#sweep();
    const attempts = [...this.#pending.values()].sort((a, b) => b.startedAt - a.startedAt);
    const attempt = attempts[0];
    if (attempt === undefined) return undefined;
    return { state: attempt.state, status: attempt.status, error: attempt.error, startedAt: attempt.startedAt };
  }

  /** Cancel a pending attempt, so the panel can offer "Cancel". */
  cancelAuthorization(state) {
    const attempt = state === undefined ? [...this.#pending.values()].at(-1) : this.findAttempt(state);
    if (attempt === undefined || attempt.status !== 'pending') return false;
    attempt.status = 'cancelled';
    attempt.error = 'the authorization attempt was cancelled';
    return true;
  }

  /**
   * One snapshot describing everything the connection page renders.
   *
   * It reports state, never secrets: no access token, no refresh token, and no
   * part of the OAuth client. The callback URL is included because it is a
   * public value that must be registered on the OAuth app, and it is the only
   * way a user can diagnose a non-default GUI port.
   *
   * @param options - include the authenticated account (one Figma request).
   * @returns the connection status.
   */
  async status(options = {}) {
    const grant = await this.storedGrant();
    const attempt = this.currentAttempt();
    const status = {
      // Whether a usable grant is stored. This is the whole user-facing fact.
      connected: grant !== undefined,
      // Whether this build can sign in at all — a deployment fact, reported so
      // a missing OAuth client shows an explanation instead of a dead button.
      available: this.oauthSupported && this.appConfigured,
      pending: attempt === undefined ? null : attempt,
      // Public, not a credential: the exact callback URL that must appear on
      // the OAuth app. Figma matches it verbatim, so a GUI running on a port
      // the app does not list fails with no other clue.
      redirectUri: this.redirectUri(),
    };
    // The account is the user's own identity, shown only to confirm which
    // Figma account is connected. No token, secret, or app credential is ever
    // part of this payload.
    if (options.verify === true && grant !== undefined) {
      status.account = await this.#describeAccount(options);
    }
    return status;
  }

  /** Ask Figma who the current token belongs to; failures become a stated reason. */
  async #describeAccount(options) {
    try {
      const { token } = await this.accessToken(options);
      const fetchImpl = this.#fetch;
      const response = await fetchImpl(`${String(this.#config.apiBaseUrl).replace(/\/+$/, '')}/v1/me`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: options.signal,
      });
      if (response.status === 403) {
        return { verified: true, note: 'the token lacks the current_user:read scope, so the account cannot be read' };
      }
      if (!response.ok) return { verified: false, note: `Figma returned HTTP ${response.status} for /v1/me` };
      const me = await response.json();
      return {
        verified: true,
        id: typeof me?.id === 'string' ? me.id : undefined,
        handle: typeof me?.handle === 'string' ? me.handle : undefined,
        email: typeof me?.email === 'string' ? me.email : undefined,
      };
    } catch (error) {
      return { verified: false, note: error?.message ?? String(error) };
    }
  }
}

