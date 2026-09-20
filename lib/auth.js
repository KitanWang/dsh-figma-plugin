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
  hasClientCredentials,
  needsRefresh,
  refreshAccessToken,
  stateMatches,
} from './oauth.js';

/** Credential-record scope: the registered name of the plugin that owns the record. */
export const RECORD_SCOPE = 'figma';

/** Credential-record id holding the OAuth grant. */
export const RECORD_ID = 'oauth';

/** Fastest a failed refresh may be retried, so a broken token cannot spin. */
const REFRESH_RETRY_MS = 30 * 1000;

/**
 * The connection's durable half: client credentials, the grant, and the
 * out-of-band edits the credential store reports.
 *
 * Every method degrades rather than throws when the credential service is
 * absent — a profile without `dsh-credentials-local` still gets PAT support
 * and a clear reason on the connection panel.
 */
export class FigmaConnection {
  #ctx;

  #config;

  /** Pending authorization attempts, keyed by `state`. At most a couple live at once. */
  #pending = new Map();

  /** Serializes token acquisition so concurrent tool calls refresh once, not once each. */
  #flight = null;

  /** Resolved client credentials, cached briefly to avoid re-reading the store per call. */
  #clientCache = null;

  #clientCacheAt = 0;

  /** Set by the route layer so the panel can show the exact URL Figma must match. */
  #redirectUri;

  /** Settings scope owning the non-secret half of the connection (the client id). */
  #settings;

  /** Fetch implementation used for token endpoints; injectable for tests and proxies. */
  #fetch;

  /**
   * @param ctx - plugin context, for the optional credential service.
   * @param config - resolved plugin config.
   * @param options - redirect URI override, settings scope, and injectable helpers.
   */
  constructor(ctx, config, options = {}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#redirectUri = options.redirectUri;
    this.#settings = options.settings;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
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
   * Resolve the OAuth client id/secret pair.
   *
   * Config wins, then the credential store (so a shared settings file can hold
   * the non-secret client id while the secret stays in `.credentials.yaml`),
   * then the environment.
   *
   * @param options - set `fresh` to bypass the short cache after a failed exchange.
   * @returns the client credentials, or undefined when either half is missing.
   */
  async client(options = {}) {
    const now = Date.now();
    if (options.fresh !== true && this.#clientCache !== null && now - this.#clientCacheAt < 5_000) {
      return this.#clientCache;
    }
    const configuredId = typeof this.#config.clientId === 'string' ? this.#config.clientId.trim() : '';
    const configuredSecret = typeof this.#config.clientSecret === 'string' ? this.#config.clientSecret.trim() : '';
    let clientId = configuredId;
    let secret = configuredSecret;

    // The settings document outranks composition config for the client id: the
    // panel writes there, and a stored user choice must beat the row default.
    if (this.#settings !== undefined) {
      try {
        const stored = this.#settings.get();
        if (typeof stored?.clientId === 'string' && stored.clientId.trim().length > 0) {
          clientId = stored.clientId.trim();
        }
      } catch {
        // An unreadable section falls back to composition config.
      }
    }

    if (clientId === '' || secret === '') {
      const credentials = this.#credentials;
      if (credentials !== undefined) {
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
        for (const [target, ref] of [
          ['id', this.#config.clientIdRef],
          ['secret', this.#config.clientSecretRef],
        ]) {
          if (typeof ref !== 'string' || ref.trim().length === 0) continue;
          if (target === 'id' && clientId !== '') continue;
          if (target === 'secret' && secret !== '') continue;
          try {
            const hit = await credentials.resolve(credentialRef(ref.trim()));
            if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim().length > 0) {
              if (target === 'id') clientId = hit.value.trim();
              else secret = hit.value.trim();
            }
          } catch {
            // A missing or unwritable reference layer is not fatal; try the next one.
          }
        }
      }
    }

    if (clientId === '') clientId = process.env.FIGMA_CLIENT_ID?.trim() ?? '';
    if (secret === '') secret = process.env.FIGMA_CLIENT_SECRET?.trim() ?? '';

    const resolved = { clientId, clientSecret: secret };
    this.#clientCache = hasClientCredentials(resolved) ? resolved : null;
    this.#clientCacheAt = now;
    return this.#clientCache ?? undefined;
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

  /**
   * Persist OAuth client credentials entered in the connection panel.
   *
   * The client id is not a secret, so it goes to the ordinary plugin config;
   * the secret goes to the credential store under its reference, which is the
   * seam's whole purpose. Both halves are optional — the panel may submit only
   * the one the user just typed.
   *
   * @param input - `clientId` and/or `clientSecret` as entered.
   * @throws {FigmaOAuthError} when a secret is given with no writable store.
   */
  async saveClient(input) {
    const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
    const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
    if (clientId === '' && clientSecret === '') return;
    if (clientId !== '') {
      this.#config.clientId = clientId;
      // Persist through the official settings seam when one is mounted, so the
      // value survives a restart without the user re-entering it.
      if (this.#settings !== undefined) {
        try {
          await this.#settings.update({ clientId });
        } catch (error) {
          throw new FigmaOAuthError(`the Client ID could not be saved: ${error?.message ?? String(error)}`);
        }
      }
    }
    if (clientSecret !== '') {
      const credentials = this.#credentials;
      if (credentials === undefined) {
        throw new FigmaOAuthError('this deployment mounts no credential store, so the Client Secret cannot be saved');
      }
      const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
      const ref = typeof this.#config.clientSecretRef === 'string' && this.#config.clientSecretRef.trim().length > 0
        ? this.#config.clientSecretRef.trim()
        : 'FIGMA_CLIENT_SECRET';
      await credentials.set(credentialRef(ref), clientSecret);
    }
    // The next read must observe what was just written.
    this.#clientCache = null;
    this.#clientCacheAt = 0;
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
    const pat = await this.personalAccessToken();
    if (pat !== undefined) return { token: pat.token, source: pat.source, mode: 'pat' };
    throw new FigmaOAuthError(
      'Figma is not connected. Ask the user to connect from Settings → Figma, or set FIGMA_ACCESS_TOKEN (or FIGMA_TOKEN) in the environment or the harness credential store.',
    );
  }

  /**
   * Resolve a personal access token from config, the credential store, or the environment.
   *
   * @returns the token and the layer that supplied it, when one exists.
   */
  async personalAccessToken() {
    if (typeof this.#config.accessToken === 'string' && this.#config.accessToken.trim().length > 0) {
      return { token: this.#config.accessToken.trim(), source: 'plugin config' };
    }
    const credentials = this.#credentials;
    if (credentials !== undefined) {
      const { credentialRef } = await import('@deepseek-ai/dsh-credentials');
      for (const ref of ['FIGMA_ACCESS_TOKEN', 'FIGMA_TOKEN']) {
        try {
          const resolved = await credentials.resolve(credentialRef(ref));
          if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.trim().length > 0) {
            return { token: resolved.value.trim(), source: `credential store (${resolved.source})` };
          }
        } catch {
          // Try the next layer.
        }
      }
    }
    for (const ref of ['FIGMA_ACCESS_TOKEN', 'FIGMA_TOKEN']) {
      const value = process.env[ref];
      if (typeof value === 'string' && value.trim().length > 0) {
        return { token: value.trim(), source: `environment ${ref}`, mode: 'pat' };
      }
    }
    return undefined;
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
      const client = await this.client();
      if (client === undefined) {
        throw new FigmaOAuthError('the stored Figma grant needs refreshing, but no OAuth client is configured; reconnect from Settings → Figma');
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
    return defaultRedirectUri({
      redirectUri: this.#config.redirectUri,
      port: this.#config.callbackPort === 0 ? 3080 : this.#config.callbackPort,
      callbackPath: this.#config.callbackPath,
    });
  }

  /** Set the redirect URI once the HTTP server has actually bound. */
  setRedirectUri(value) {
    if (typeof value === 'string' && value.length > 0) this.#redirectUri = value;
  }

  /**
   * Attach the settings scope that persists the non-secret half of the
   * connection.
   *
   * The settings service may mount after this plugin, so the scope arrives
   * through a late callback rather than the constructor.
   *
   * @param scope - the registered `figma` settings scope.
   */
  attachSettings(scope) {
    this.#settings = scope;
  }

  /**
   * Start an authorization attempt and return where to send the human.
   *
   * The attempt is remembered under its `state`, so the callback route can
   * prove the response belongs to it and can complete the exchange in the
   * request that carries the code (Figma's codes expire in 30 seconds).
   *
   * @returns the authorization URL, its state, and a promise settling when the attempt finishes.
   * @throws {FigmaOAuthError} when no client is configured or one attempt is already in flight.
   */
  async beginAuthorization() {
    if (!this.oauthSupported) {
      throw new FigmaOAuthError('this deployment mounts no credential store, so OAuth sign-in is unavailable');
    }
    const client = await this.client();
    if (client === undefined) {
      throw new FigmaOAuthError(
        'no Figma OAuth client is configured. Create an OAuth app at https://www.figma.com/developers/apps, add the redirect URL shown below, then enter its Client ID and Client Secret — or set FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET.',
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
    let client = await this.client();
    if (client === undefined) {
      // A fresh read: the user may have just pasted credentials in the panel.
      client = await this.client({ fresh: true });
    }
    if (client === undefined) {
      attempt.status = 'failed';
      attempt.error = 'the OAuth client credentials disappeared before the code could be exchanged';
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
   * One snapshot describing everything the connection panel renders.
   *
   * It reports presence, never secrets: the access token is reduced to a
   * yes/no plus its expiry, and the client secret to whether it is set.
   *
   * @param options - include the authenticated account (one Figma request).
   * @returns the connection status.
   */
  async status(options = {}) {
    const client = await this.client();
    const grant = await this.storedGrant();
    const pat = await this.personalAccessToken();
    const attempt = this.currentAttempt();
    let tokenSource;
    let mode = 'none';
    let expiresAt;
    if (grant !== undefined) {
      mode = 'oauth';
      tokenSource = needsRefresh(grant) ? 'oauth (needs refresh)' : 'oauth';
      expiresAt = grant.expiresAt;
    } else if (pat !== undefined) {
      mode = 'pat';
      tokenSource = pat.source;
    }
    const status = {
      mode,
      connected: mode !== 'none',
      oauthSupported: this.oauthSupported,
      clientConfigured: client !== undefined,
      clientId: client?.clientId ?? null,
      // Never the secret itself — only whether one is stored.
      clientSecretSet: client !== undefined,
      redirectUri: this.redirectUri(),
      scopes: this.#config.scopes,
      tokenSource: tokenSource ?? null,
      expiresAt: expiresAt ?? null,
      personalAccessToken: pat !== undefined,
      pending: attempt === undefined ? null : attempt,
      canDisconnect: grant !== undefined,
    };
    if (options.verify === true && mode !== 'none') {
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

export { REFRESH_RETRY_MS };
