import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigmaConnection, RECORD_ID, RECORD_SCOPE } from '../lib/auth.js';
import { resolveOAuthApp } from '../lib/oauth-app.js';

/**
 * Connection tests.
 *
 * The plugin's whole reason to exist is that a user never handles a token, so
 * the assertions here are largely about what the connection does NOT accept:
 * no personal access token, no user-supplied client credentials, and a status
 * payload that carries nothing secret.
 */

/** An in-memory stand-in for the harness credential service. */
function stubCredentials() {
  const records = new Map();
  return {
    records,
    async readRecord(key) {
      return records.get(String(key));
    },
    async describeRecord(key) {
      return { configured: records.has(String(key)), writable: true };
    },
    async listRecords() {
      return [...records.keys()].map((key) => ({ key, kind: 'grant' }));
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(String(key)));
      if (next === undefined) return records.get(String(key));
      records.set(String(key), next);
      return next;
    },
    async deleteRecord(key) {
      records.delete(String(key));
    },
  };
}

/** A minimal Cordis-like context exposing one optional service. */
function stubCtx(services) {
  return { get: (name) => services[name] };
}

/** The OAuth client every test signs in with. */
const TEST_CLIENT = { clientId: 'builtin-client', clientSecret: 'builtin-secret' };

/** Config as the plugin resolves it, with the built-in app supplied explicitly. */
function config(overrides = {}) {
  return {
    apiBaseUrl: 'https://api.figma.com',
    clientId: TEST_CLIENT.clientId,
    clientSecret: TEST_CLIENT.clientSecret,
    authorizationUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
    scopes: 'file_content:read',
    callbackPort: 0,
    redirectUri: '',
    callbackPath: '/figma/oauth/callback',
    ...overrides,
  };
}

/** A fetch stub answering the token endpoints. */
function tokenFetch(body = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(String(init.body)) });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  impl.calls = calls;
  return impl;
}

/**
 * Build a connection with a stubbed fetch and in-memory store.
 *
 * The OAuth client is injected rather than read from the shipped module, so
 * these tests pin the logic and not whatever credentials a build happens to
 * carry. Pass `app: null` to model a build with no client at all, and
 * `resolveApp` to inject a different resolver entirely.
 */
function makeConnection(options = {}) {
  const credentials = options.credentials ?? stubCredentials();
  const fetchImpl = options.fetch ?? tokenFetch();
  const app = options.app === undefined ? TEST_CLIENT : options.app;
  const resolveApp =
    options.resolveApp ??
    ((cfg) => {
      // Mirrors resolveOAuthApp's precedence: config, then environment, then
      // the build's app; either half missing means "no usable client".
      const pick = (configured, envName, builtIn) => {
        for (const candidate of [configured, process.env?.[envName], builtIn]) {
          if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
        }
        return '';
      };
      const clientId = pick(cfg?.clientId, 'FIGMA_CLIENT_ID', app?.clientId);
      const clientSecret = pick(cfg?.clientSecret, 'FIGMA_CLIENT_SECRET', app?.clientSecret);
      if (clientId === '' || clientSecret === '') return undefined;
      return { clientId, clientSecret };
    });
  const connection = new FigmaConnection(stubCtx({ credentials }), config(options.config), {
    fetch: fetchImpl,
    resolveApp,
  });
  connection.setRedirectUri('http://127.0.0.1:3080/figma/oauth/callback');
  return { connection, credentials, fetch: fetchImpl };
}

/** Store a usable grant directly. */
async function storeGrant(credentials, payload) {
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({ kind: 'grant', payload }));
}

/** Isolate environment variables a test touches, awaiting an async body. */
async function withEnv(vars, body) {
  const previous = new Map();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a stored grant is used as a bearer token', async () => {
  const { connection, credentials } = makeConnection();
  await storeGrant(credentials, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 });
  const resolved = await connection.accessToken();
  assert.equal(resolved.token, 'at');
  assert.equal(resolved.mode, 'oauth');
});

test('an expiring grant is refreshed before use and the result is persisted', async () => {
  const credentials = stubCredentials();
  await storeGrant(credentials, { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 });
  const fetchImpl = tokenFetch({ access_token: 'fresh', expires_in: 3600, token_type: 'bearer' });
  const { connection } = makeConnection({ credentials, fetch: fetchImpl });

  const resolved = await connection.accessToken();
  assert.equal(resolved.token, 'fresh');
  assert.equal(resolved.source, 'oauth (refreshed)');
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /oauth\/refresh$/);

  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.payload.accessToken, 'fresh');
  assert.equal(stored.payload.refreshToken, 'rt-1', 'a refresh with no new refresh token keeps the old one');
});

test('concurrent calls refresh once, not once each', async () => {
  const credentials = stubCredentials();
  await storeGrant(credentials, { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 });
  let refreshes = 0;
  const { connection } = makeConnection({
    credentials,
    fetch: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fresh', expires_in: 3600 }) };
    },
  });
  const results = await Promise.all([connection.accessToken(), connection.accessToken(), connection.accessToken()]);
  assert.equal(refreshes, 1, 'three concurrent calls must share one refresh');
  for (const result of results) assert.equal(result.token, 'fresh');
});

test('a failed refresh keeps the grant instead of silently signing the user out', async () => {
  const credentials = stubCredentials();
  await storeGrant(credentials, { accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() - 1000 });
  const { connection } = makeConnection({
    credentials,
    fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) }),
  });
  await assert.rejects(() => connection.accessToken(), /refresh/);
  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.payload.refreshToken, 'rt', 'the refresh token must survive a transient failure');
});

test('no personal access token is honoured, in the environment or anywhere else', async () => {
  await withEnv({ FIGMA_ACCESS_TOKEN: 'legacy-pat', FIGMA_TOKEN: 'legacy-pat-2' }, async () => {
    const { connection } = makeConnection({ config: { clientId: '', clientSecret: '' } });
    // A PAT in the environment must not silently authenticate the plugin: the
    // whole point of the redesign is that a user never handles a token.
    await assert.rejects(() => connection.accessToken(), (error) => {
      assert.match(error.message, /not connected/i);
      assert.doesNotMatch(error.message, /FIGMA_ACCESS_TOKEN/);
      return true;
    });
    assert.equal((await connection.status({})).connected, false);
  });
});

test('the connection exposes no personal-access-token entry point', () => {
  const { connection } = makeConnection();
  for (const name of ['personalAccessToken', 'saveClient']) {
    assert.equal(typeof connection[name], 'undefined', `${name} must not exist any more`);
  }
});

test('an unconnected plugin explains how to connect, not how to paste a token', async () => {
  const { connection } = makeConnection();
  await assert.rejects(() => connection.accessToken(), (error) => {
    assert.match(error.message, /Settings → Figma/);
    assert.doesNotMatch(error.message, /token/i);
    return true;
  });
});

test('beginAuthorization returns a Figma URL carrying state and PKCE', async () => {
  const { connection } = makeConnection();
  const started = await connection.beginAuthorization();
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://www.figma.com/oauth');
  assert.equal(url.searchParams.get('client_id'), TEST_CLIENT.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/figma/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), started.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge').length > 0);

  const again = await connection.beginAuthorization();
  assert.equal(again.reused, true, 'a live attempt is reused rather than duplicated');
  assert.equal(again.state, started.state);
});

test('beginAuthorization fails clearly when the build carries no OAuth client', async () => {
  const { connection } = makeConnection({ app: null, config: { clientId: '', clientSecret: '' } });
  await assert.rejects(() => connection.beginAuthorization(), /carries no Figma OAuth client/);
});

test('the full callback completes an authorization and stores the grant', async () => {
  const { connection, credentials } = makeConnection();
  const started = await connection.beginAuthorization();
  const result = await connection.completeAuthorization({ state: started.state, code: 'the-code' });
  assert.equal(result.status, 'authorized');

  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.kind, 'grant');
  assert.equal(stored.payload.accessToken, 'at');
});

test('a callback with an unknown state is refused', async () => {
  const { connection } = makeConnection();
  const result = await connection.completeAuthorization({ state: 'forged', code: 'x' });
  assert.equal(result.status, 'unknown-state');
  assert.match(result.error, /does not match any pending/);
});

test('a declined consent screen settles as denied rather than failed', async () => {
  const { connection } = makeConnection();
  const started = await connection.beginAuthorization();
  const result = await connection.completeAuthorization({ state: started.state, error: 'access_denied' });
  assert.equal(result.status, 'denied');
  assert.match(result.error, /declined/);
});

test('cancelAuthorization stops a pending attempt', async () => {
  const { connection } = makeConnection();
  await connection.beginAuthorization();
  assert.equal(connection.cancelAuthorization(), true);
  assert.equal(connection.currentAttempt().status, 'cancelled');
  assert.equal(connection.cancelAuthorization(), false, 'a settled attempt cannot be cancelled again');
});

test('reconnecting is possible while already connected', async () => {
  const { connection, credentials } = makeConnection();
  await storeGrant(credentials, { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 });
  assert.equal((await connection.status({})).connected, true);
  // The user pressing "Reconnect" must be able to start a fresh attempt.
  const started = await connection.beginAuthorization();
  assert.match(started.url, /figma\.com\/oauth/);
  assert.equal(started.reused, false);
});

test('status reports connection state without any credential material', async () => {
  const { connection, credentials } = makeConnection();
  await storeGrant(credentials, {
    accessToken: 'super-secret-token',
    refreshToken: 'super-secret-refresh',
    expiresAt: Date.now() + 3_600_000,
  });
  const status = await connection.status({});
  assert.equal(status.connected, true);
  assert.equal(status.available, true);
  assert.equal(status.pending, null);

  const serialized = JSON.stringify(status);
  for (const secret of ['super-secret-token', 'super-secret-refresh', TEST_CLIENT.clientSecret]) {
    assert.equal(serialized.includes(secret), false, `${secret} must never reach the browser`);
  }
  // Nor may the response advertise credential concepts the UI no longer has.
  for (const key of ['clientId', 'clientSecretSet', 'expiresAt', 'tokenSource', 'mode', 'scopes', 'redirectUri', 'personalAccessToken']) {
    assert.equal(key in status, false, `status must not expose ${key} any more`);
  }
});

test('status reports a deployment with no OAuth client as unavailable', async () => {
  const { connection } = makeConnection({ app: null, config: { clientId: '', clientSecret: '' } });
  const status = await connection.status({});
  assert.equal(status.available, false, 'the UI must tell a deployment fault from a signed-out user');
  assert.equal(status.connected, false);
});

test('status reports a missing credential store as unavailable', async () => {
  const connection = new FigmaConnection(stubCtx({}), config(), { fetch: tokenFetch() });
  const status = await connection.status({});
  assert.equal(status.available, false);
  assert.equal(status.connected, false);
});

test('the authorized account is reported only when asked, and never a token', async () => {
  const credentials = stubCredentials();
  await storeGrant(credentials, { accessToken: 'secret-access', expiresAt: Date.now() + 3_600_000 });
  const { connection } = makeConnection({
    credentials,
    fetch: async (url) => {
      if (String(url).endsWith('/v1/me')) {
        return { ok: true, status: 200, json: async () => ({ id: 'u1', handle: 'designer', email: 'd@example.com' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at', expires_in: 3600 }) };
    },
  });
  const plain = await connection.status({});
  assert.equal('account' in plain, false, 'a cheap status read must not call Figma');

  const verified = await connection.status({ verify: true });
  assert.equal(verified.account.handle, 'designer');
  assert.equal(verified.account.email, 'd@example.com');
  assert.equal(JSON.stringify(verified).includes('secret-access'), false);
});

test('the OAuth app resolves from explicit config first', () => {
  assert.deepEqual(resolveOAuthApp({ clientId: 'a', clientSecret: 'b' }), { clientId: 'a', clientSecret: 'b' });
});

test('the OAuth app falls back to the environment when config is empty', async () => {
  // Clear the shipped values' effect by overriding both halves from the env.
  await withEnv({ FIGMA_CLIENT_ID: 'env-id', FIGMA_CLIENT_SECRET: 'env-secret' }, async () => {
    const resolved = resolveOAuthApp({});
    assert.equal(resolved.clientId, 'env-id');
    assert.equal(resolved.clientSecret, 'env-secret');
    // Explicit config still wins over the environment.
    const mixed = resolveOAuthApp({ clientId: 'cfg' });
    assert.equal(mixed.clientId, 'cfg');
    assert.equal(mixed.clientSecret, 'env-secret');
  });
});

test('a half-configured OAuth client counts as none, rather than failing at Figma', () => {
  const { connection } = makeConnection({ app: { clientId: 'only-id' }, config: { clientId: '', clientSecret: '' } });
  assert.equal(connection.client(), undefined);
  assert.equal(connection.appConfigured, false);
});

test('the environment can rotate the shipped OAuth client without editing the package', async () => {
  // A deployment that must rotate a leaked secret sets these two variables;
  // they have to beat the values shipped in lib/oauth-app.js, or rotation
  // would be impossible.
  await withEnv({ FIGMA_CLIENT_ID: 'rotated-id', FIGMA_CLIENT_SECRET: 'rotated-secret' }, async () => {
    const resolved = resolveOAuthApp({});
    assert.equal(resolved.clientId, 'rotated-id');
    assert.equal(resolved.clientSecret, 'rotated-secret');
  });
});

test('explicit config still outranks the environment', async () => {
  await withEnv({ FIGMA_CLIENT_ID: 'env-id', FIGMA_CLIENT_SECRET: 'env-secret' }, async () => {
    const resolved = resolveOAuthApp({ clientId: 'cfg-id', clientSecret: 'cfg-secret' });
    assert.equal(resolved.clientId, 'cfg-id');
    assert.equal(resolved.clientSecret, 'cfg-secret');
  });
});
