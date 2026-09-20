import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigmaConnection, RECORD_ID, RECORD_SCOPE } from '../lib/auth.js';

/** An in-memory stand-in for the harness credential service. */
function stubCredentials() {
  const records = new Map();
  const refs = new Map();
  return {
    records,
    refs,
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
    async resolve(ref) {
      const hit = refs.get(String(ref));
      return hit === undefined ? undefined : { value: hit, source: 'file' };
    },
    async set(ref, value) {
      refs.set(String(ref), value);
    },
  };
}

/** A minimal Cordis-like context exposing one optional service. */
function stubCtx(services) {
  return { get: (name) => services[name] };
}

/** Config with the OAuth half filled in, mirroring a resolved plugin row. */
function config(overrides = {}) {
  return {
    accessToken: '',
    authMode: 'token',
    apiBaseUrl: 'https://api.figma.com',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    clientIdRef: 'FIGMA_CLIENT_ID',
    clientSecretRef: 'FIGMA_CLIENT_SECRET',
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

test('a connected OAuth grant is used as a bearer token', async () => {
  const credentials = stubCredentials();
  const connection = new FigmaConnection(stubCtx({ credentials }), config());
  await connection.storedGrant();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  }));
  const resolved = await connection.accessToken();
  assert.equal(resolved.token, 'at');
  assert.equal(resolved.mode, 'oauth');
});

test('an expiring OAuth grant is refreshed before use and the result is persisted', async () => {
  const credentials = stubCredentials();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 },
  }));
  const calls = [];
  const connection = new FigmaConnection(stubCtx({ credentials }), config(), {
    fetch: async (url, init) => {
      calls.push({ url, body: new URLSearchParams(String(init.body)) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'fresh', expires_in: 3600, token_type: 'bearer' }),
      };
    },
  });
  const resolved = await connection.accessToken();
  assert.equal(resolved.token, 'fresh');
  assert.equal(resolved.source, 'oauth (refreshed)');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /oauth\/refresh$/);

  // The rotated token must be durable, not just returned.
  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.payload.accessToken, 'fresh');
  assert.equal(stored.payload.refreshToken, 'rt-1', 'a refresh with no new refresh token keeps the old one');
});

test('concurrent calls refresh once, not once each', async () => {
  const credentials = stubCredentials();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1000 },
  }));
  let refreshes = 0;
  const connection = new FigmaConnection(stubCtx({ credentials }), config(), {
    fetch: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'fresh', expires_in: 3600 }),
      };
    },
  });
  const results = await Promise.all([connection.accessToken(), connection.accessToken(), connection.accessToken()]);
  assert.equal(refreshes, 1, 'three concurrent calls must share one refresh');
  for (const result of results) assert.equal(result.token, 'fresh');
});

test('a personal access token is used when no OAuth grant is stored', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config({ accessToken: 'pat-1' }));
  const resolved = await connection.accessToken();
  assert.equal(resolved.token, 'pat-1');
  assert.equal(resolved.mode, 'pat');
});

test('a personal access token is read from the environment as a last resort', async () => {
  await withEnv({ FIGMA_ACCESS_TOKEN: 'env-pat', FIGMA_TOKEN: undefined }, async () => {
    const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config({ clientId: '', clientSecret: '' }));
    const resolved = await connection.accessToken();
    assert.equal(resolved.token, 'env-pat');
    assert.match(resolved.source, /FIGMA_ACCESS_TOKEN/);
  });
});

test('nothing configured produces a message naming every way to connect', async () => {
  await withEnv({ FIGMA_ACCESS_TOKEN: undefined, FIGMA_TOKEN: undefined }, async () => {
    const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
    await assert.rejects(() => connection.accessToken(), /Settings → Figma/);
    await assert.rejects(() => connection.accessToken(), /FIGMA_ACCESS_TOKEN/);
  });
});

test('beginAuthorization returns a Figma URL carrying state and PKCE, then reuses the live attempt', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
  connection.setRedirectUri('http://127.0.0.1:3080/figma/oauth/callback');
  const started = await connection.beginAuthorization();
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, 'https://www.figma.com/oauth');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/figma/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), started.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge').length > 0);

  const again = await connection.beginAuthorization();
  assert.equal(again.reused, true);
  assert.equal(again.state, started.state);
});

test('beginAuthorization refuses to start without client credentials and explains the setup', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config({ clientId: '', clientSecret: '' }));
  await assert.rejects(() => connection.beginAuthorization(), /figma\.com\/developers\/apps/);
});

test('the full callback completes an authorization and stores the grant', async () => {
  const credentials = stubCredentials();
  const connection = new FigmaConnection(stubCtx({ credentials }), config(), {
    fetch: async (url, init) => {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('code'), 'the-code');
      assert.ok(body.get('code_verifier').length >= 43);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      };
    },
  });
  connection.setRedirectUri('http://127.0.0.1:3080/figma/oauth/callback');
  const started = await connection.beginAuthorization();

  const result = await connection.completeAuthorization({ state: started.state, code: 'the-code' });
  assert.equal(result.status, 'authorized');

  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.kind, 'grant');
  assert.equal(stored.payload.accessToken, 'at');
  assert.equal(stored.payload.scopes, 'file_content:read');
});

test('a callback with an unknown state is refused', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
  const result = await connection.completeAuthorization({ state: 'forged', code: 'x' });
  assert.equal(result.status, 'unknown-state');
  assert.match(result.error, /does not match any pending/);
});

test('a callback with no code and no error is reported as failed', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
  const started = await connection.beginAuthorization();
  const result = await connection.completeAuthorization({ state: started.state });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /without an authorization code/);
});

test('a declined consent screen settles as denied rather than failed', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
  const started = await connection.beginAuthorization();
  const result = await connection.completeAuthorization({ state: started.state, error: 'access_denied' });
  assert.equal(result.status, 'denied');
  assert.match(result.error, /declined/);
});

test('a callback can be completed only once', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config(), {
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at', expires_in: 3600 }) }),
  });
  const started = await connection.beginAuthorization();
  const first = await connection.completeAuthorization({ state: started.state, code: 'c' });
  assert.equal(first.status, 'authorized');
  const second = await connection.completeAuthorization({ state: started.state, code: 'c' });
  assert.equal(second.status, 'authorized', 'a repeated callback reports the settled outcome, not a second exchange');
});

test('cancelAuthorization stops a pending attempt', async () => {
  const connection = new FigmaConnection(stubCtx({ credentials: stubCredentials() }), config());
  const started = await connection.beginAuthorization();
  assert.equal(connection.cancelAuthorization(), true);
  const attempt = connection.currentAttempt();
  assert.equal(attempt.status, 'cancelled');
  assert.equal(connection.cancelAuthorization(), false, 'a settled attempt cannot be cancelled again');
  assert.equal(started.state, attempt.state);
});

test('saveClient persists the secret to the credential store and the id to settings', async () => {
  const credentials = stubCredentials();
  const updates = [];
  const settings = {
    get: () => ({ clientId: '' }),
    update: async (patch) => updates.push(patch),
  };
  const connection = new FigmaConnection(stubCtx({ credentials }), config({ clientId: '', clientSecret: '' }), { settings });
  await connection.saveClient({ clientId: 'new-id', clientSecret: 'new-secret' });
  assert.equal(credentials.refs.get('FIGMA_CLIENT_SECRET'), 'new-secret');
  assert.deepEqual(updates, [{ clientId: 'new-id' }]);
  const client = await connection.client();
  assert.equal(client.clientId, 'new-id');
  assert.equal(client.clientSecret, 'new-secret');
});

test('status reports presence without ever exposing the secret or the token', async () => {
  const credentials = stubCredentials();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'super-secret-token', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 },
  }));
  const connection = new FigmaConnection(stubCtx({ credentials }), config());
  const status = await connection.status({});
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'oauth');
  assert.equal(status.clientSecretSet, true);
  assert.equal(status.clientId, 'client-1');
  assert.equal(status.canDisconnect, true);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('super-secret-token'), false, 'the access token must never reach the browser');
  assert.equal(serialized.includes('secret-1'), false, 'the client secret must never reach the browser');
});

test('disconnect removes the stored grant', async () => {
  const credentials = stubCredentials();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 },
  }));
  const connection = new FigmaConnection(stubCtx({ credentials }), config());
  assert.equal((await connection.status({})).connected, true);
  await connection.forget();
  const status = await connection.status({});
  assert.equal(status.connected, false);
  assert.equal(status.mode, 'none');
});

test('every method degrades when no credential store is mounted', async () => {
  const connection = new FigmaConnection(stubCtx({}), config());
  assert.equal(connection.oauthSupported, false);
  assert.equal(await connection.storedGrant(), undefined);
  await connection.forget();
  const status = await connection.status({});
  assert.equal(status.oauthSupported, false);
  assert.equal(status.connected, false);
});

test('a failed refresh keeps the grant instead of silently signing the user out', async () => {
  const credentials = stubCredentials();
  await credentials.modifyRecord(`${RECORD_SCOPE}/${RECORD_ID}`, async () => ({
    kind: 'grant',
    payload: { accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() - 1000 },
  }));
  const connection = new FigmaConnection(stubCtx({ credentials }), config(), {
    fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_grant' }) }),
  });
  await assert.rejects(() => connection.accessToken(), /refresh/);
  const stored = await credentials.readRecord(`${RECORD_SCOPE}/${RECORD_ID}`);
  assert.equal(stored.payload.refreshToken, 'rt', 'the refresh token must survive a transient failure');
});
