import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { FigmaConnection } from '../lib/auth.js';
import { CALLBACK_PATH, API_BASE, createApiHandler, createCallbackHandler, resultPage, sameOrigin } from '../lib/routes.js';

/** In-memory credential service. */
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
      return [];
    },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(String(key)));
      if (next !== undefined) records.set(String(key), next);
      return records.get(String(key));
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

function config(overrides = {}) {
  return {
    accessToken: '',
    apiBaseUrl: 'https://api.figma.com',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    clientIdRef: 'FIGMA_CLIENT_ID',
    clientSecretRef: 'FIGMA_CLIENT_SECRET',
    authorizationUrl: 'https://www.figma.com/oauth',
    tokenUrl: 'https://api.figma.com/v1/oauth/token',
    refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
    scopes: 'file_content:read',
    redirectUri: '',
    callbackPath: CALLBACK_PATH,
    ...overrides,
  };
}

/** Build a connection whose token endpoints are stubbed. */
function makeConnection(options = {}) {
  const credentials = options.credentials ?? stubCredentials();
  const connection = new FigmaConnection({ get: (name) => (name === 'credentials' ? credentials : undefined) }, config(options.config), {
    fetch:
      options.fetch ??
      (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) })),
  });
  connection.setRedirectUri('http://127.0.0.1:3080/figma/oauth/callback');
  return { connection, credentials };
}

let server;
let origin;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const handler = request.__handler;
    if (handler === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Serve one handler for the duration of a request against the live server. */
async function request(handler, path, options = {}) {
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    req.__handler = handler;
    if (options.raw !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    handler(req, res);
  });
  const init = { method: options.method ?? 'GET', headers: options.headers ?? {} };
  if (options.body !== undefined) {
    init.method = options.method ?? 'POST';
    init.body = JSON.stringify(options.body);
    init.headers = { 'content-type': 'application/json', ...init.headers };
  }
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, headers: response.headers };
}

test('the status route reports the connection without leaking secrets', async () => {
  const { connection, credentials } = makeConnection();
  await credentials.modifyRecord('figma/oauth', async () => ({
    kind: 'grant',
    payload: { accessToken: 'top-secret', expiresAt: Date.now() + 3_600_000 },
  }));
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/status`);
  assert.equal(response.status, 200);
  assert.equal(response.json.connected, true);
  assert.equal(response.json.mode, 'oauth');
  assert.equal(response.text.includes('top-secret'), false);
  assert.equal(response.text.includes('secret-1'), false);
});

test('the connect route reports the authorization URL when the origin matches', async () => {
  const { connection } = makeConnection();
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/connect`, {
    method: 'POST',
    body: {},
    headers: { origin },
  });
  assert.equal(response.status, 200);
  assert.match(response.json.authorizationUrl, /figma\.com\/oauth/);
  assert.ok(response.json.state.length >= 32);
});

test('a mutating route refuses a cross-origin request', async () => {
  const { connection } = makeConnection();
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/connect`, {
    method: 'POST',
    body: {},
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(response.status, 403);
  assert.match(response.json.error, /did not come from this GUI/);
});

test('a mutating route refuses a request with no Origin at all', async () => {
  const { connection } = makeConnection();
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/disconnect`, { method: 'POST', body: {} });
  assert.equal(response.status, 403);
});

test('the connect route accepts client credentials submitted from the panel', async () => {
  const { connection, credentials } = makeConnection({ config: { clientId: '', clientSecret: '' } });
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/connect`, {
    method: 'POST',
    body: { clientId: 'panel-id', clientSecret: 'panel-secret' },
    headers: { origin },
  });
  assert.equal(response.status, 200);
  assert.equal(credentials.refs.get('FIGMA_CLIENT_SECRET'), 'panel-secret');
  assert.match(response.json.authorizationUrl, /client_id=panel-id/);
});

test('the disconnect route clears the stored grant', async () => {
  const { connection, credentials } = makeConnection();
  await credentials.modifyRecord('figma/oauth', async () => ({
    kind: 'grant',
    payload: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 },
  }));
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/disconnect`, { method: 'POST', body: {}, headers: { origin } });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal((await connection.status({})).connected, false);
});

test('an unknown API route is a 404 rather than a guess', async () => {
  const { connection } = makeConnection();
  const handler = createApiHandler(connection, { prefix: API_BASE });
  const response = await request(handler, `${API_BASE}/nope`);
  assert.equal(response.status, 404);
});

test('the callback route completes an authorization and renders a success page', async () => {
  const { connection, credentials } = makeConnection();
  const apiHandler = createApiHandler(connection, { prefix: API_BASE });
  const started = await request(apiHandler, `${API_BASE}/connect`, { method: 'POST', body: {}, headers: { origin } });

  const callback = createCallbackHandler(connection, { guiUrl: 'http://127.0.0.1:3080/' });
  const response = await request(callback, `${CALLBACK_PATH}?state=${encodeURIComponent(started.json.state)}&code=the-code`);
  assert.equal(response.status, 200);
  assert.match(response.text, /Figma connected/);
  // The page must never carry the code or the token it produced.
  assert.equal(response.text.includes('the-code'), false);
  assert.equal(response.text.includes('"at"'), false);
  assert.equal((await credentials.readRecord('figma/oauth')).payload.accessToken, 'at');
});

test('the callback route renders a failure page with a 400 for a forged state', async () => {
  const { connection } = makeConnection();
  const callback = createCallbackHandler(connection, {});
  const response = await request(callback, `${CALLBACK_PATH}?state=forged&code=x`);
  assert.equal(response.status, 400);
  assert.match(response.text, /Figma was not connected/);
  assert.match(response.text, /does not match any pending/);
});

test('the callback page escapes untrusted text so an error cannot inject markup', () => {
  const html = resultPage({ status: 'failed', error: '<script>alert(1)</script>' }, {});
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('sameOrigin compares the browser Origin against Host', () => {
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' } }), false);
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080' } }), false);
  assert.equal(sameOrigin({ headers: { origin: 'not-a-url', host: '127.0.0.1:3080' } }), false);
});
