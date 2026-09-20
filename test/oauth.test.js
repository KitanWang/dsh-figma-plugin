import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SCOPES,
  ENTERPRISE_VARIABLES_SCOPE,
  FigmaOAuthError,
  asGrant,
  authorizationUrl,
  createCodeChallenge,
  createCodeVerifier,
  createState,
  defaultRedirectUri,
  exchangeAuthorizationCode,
  hasClientCredentials,
  isLoopbackRedirect,
  needsRefresh,
  normalizeGrant,
  refreshAccessToken,
  stateMatches,
} from '../lib/oauth.js';

test('a state value is long, random, and URL-safe', () => {
  const first = createState();
  const second = createState();
  assert.notEqual(first, second);
  assert.ok(first.length >= 32);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test('the S256 challenge is the base64url SHA-256 of the verifier', () => {
  // RFC 7636 appendix B test vector.
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(createCodeChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('a verifier is long enough for Figma and URL-safe', () => {
  const verifier = createCodeVerifier();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('state comparison accepts the exact value and rejects anything else', () => {
  const state = createState();
  assert.equal(stateMatches(state, state), true);
  assert.equal(stateMatches(state, `${state}x`), false);
  assert.equal(stateMatches('', ''), false);
  assert.equal(stateMatches(undefined, state), false);
  assert.equal(stateMatches(`${state.slice(0, -1)}a`, state), false);
});

test('the authorization URL carries every parameter Figma requires', () => {
  const url = new URL(
    authorizationUrl({
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:3080/figma/oauth/callback',
      scopes: DEFAULT_SCOPES,
      state: 'state-1',
      codeChallenge: 'challenge-1',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://www.figma.com/oauth');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3080/figma/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /file_content:read/);
});

test('the authorization URL omits PKCE parameters when no challenge is given', () => {
  const url = new URL(
    authorizationUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1/cb', scopes: 'file_content:read', state: 's' }),
  );
  assert.equal(url.searchParams.get('code_challenge'), null);
  assert.equal(url.searchParams.get('code_challenge_method'), null);
});

test('hasClientCredentials requires both halves', () => {
  assert.equal(hasClientCredentials({ clientId: 'a', clientSecret: 'b' }), true);
  assert.equal(hasClientCredentials({ clientId: 'a', clientSecret: '' }), false);
  assert.equal(hasClientCredentials({ clientId: '', clientSecret: 'b' }), false);
  assert.equal(hasClientCredentials({ clientId: '   ', clientSecret: 'b' }), false);
  assert.equal(hasClientCredentials(null), false);
  assert.equal(hasClientCredentials(undefined), false);
});

/** A fetch stub recording calls and answering with a canned response. */
function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : new URLSearchParams(String(init.body)) });
    const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? {});
    return {
      ok: response.status === undefined ? true : response.status < 400,
      status: response.status ?? 200,
      text: async () => text,
    };
  };
  impl.calls = calls;
  return impl;
}

test('the code exchange posts the verifier and authenticates with HTTP Basic', async () => {
  const fetchImpl = stubFetch({
    body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'bearer', user_id_string: 'u-1' },
  });
  const grant = await exchangeAuthorizationCode({
    clientId: 'cid',
    clientSecret: 'sec',
    code: 'the-code',
    redirectUri: 'http://127.0.0.1:3080/figma/oauth/callback',
    codeVerifier: 'the-verifier',
    now: 1_000_000,
    fetch: fetchImpl,
  });
  assert.equal(grant.accessToken, 'at-1');
  assert.equal(grant.refreshToken, 'rt-1');
  assert.equal(grant.expiresAt, 1_000_000 + 3_600_000);
  assert.equal(grant.userId, 'u-1');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.figma.com/v1/oauth/token');
  assert.equal(call.init.method, 'POST');
  // The secret must be sent the way Figma requires: Basic, not a query param.
  assert.equal(call.init.headers.authorization, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(call.body.get('grant_type'), 'authorization_code');
  assert.equal(call.body.get('code'), 'the-code');
  assert.equal(call.body.get('code_verifier'), 'the-verifier');
  assert.equal(call.body.get('redirect_uri'), 'http://127.0.0.1:3080/figma/oauth/callback');
});

test('a refused exchange names the code and explains the cause', async () => {
  const fetchImpl = stubFetch({ status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } });
  await assert.rejects(
    () =>
      exchangeAuthorizationCode({
        clientId: 'c',
        clientSecret: 's',
        code: 'x',
        redirectUri: 'http://127.0.0.1/cb',
        fetch: fetchImpl,
      }),
    (error) => {
      assert.ok(error instanceof FigmaOAuthError);
      assert.equal(error.code, 'invalid_grant');
      assert.match(error.message, /30 seconds/);
      return true;
    },
  );
});

test('a refresh keeps the old refresh token when Figma omits a new one', async () => {
  const fetchImpl = stubFetch({ body: { access_token: 'at-2', expires_in: 3600, token_type: 'bearer' } });
  const grant = await refreshAccessToken({
    clientId: 'c',
    clientSecret: 's',
    refreshToken: 'rt-1',
    now: 5_000,
    fetch: fetchImpl,
  });
  assert.equal(grant.accessToken, 'at-2');
  assert.equal(grant.refreshToken, 'rt-1', 'the previous refresh token must survive');
  assert.equal(fetchImpl.calls[0].url, 'https://api.figma.com/v1/oauth/refresh');
  assert.equal(fetchImpl.calls[0].body.get('refresh_token'), 'rt-1');
});

test('a token response without an access token is rejected', () => {
  assert.throws(() => normalizeGrant({ token_type: 'bearer' }), FigmaOAuthError);
  assert.throws(() => normalizeGrant(null), FigmaOAuthError);
});

test('needsRefresh treats a missing or expired token as stale and a fresh one as usable', () => {
  const now = 10_000_000;
  assert.equal(needsRefresh(undefined, now), true);
  assert.equal(needsRefresh({ accessToken: '' }, now), true);
  // No recorded expiry means a non-expiring credential.
  assert.equal(needsRefresh({ accessToken: 't' }, now), false);
  // Well inside the validity window.
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now + 3_600_000 }, now), false);
  // Inside the refresh skew, so refresh early rather than fail mid-call.
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now + 60_000 }, now), true);
  assert.equal(needsRefresh({ accessToken: 't', expiresAt: now - 1 }, now), true);
});

test('asGrant round-trips a stored payload and rejects a malformed one', () => {
  const grant = asGrant({
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 42,
    tokenType: 'bearer',
    userId: 'u',
    obtainedAt: 7,
    scopes: 'file_content:read',
  });
  assert.deepEqual(grant, {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: 42,
    tokenType: 'bearer',
    userId: 'u',
    obtainedAt: 7,
    scopes: 'file_content:read',
  });
  assert.equal(asGrant({ refreshToken: 'rt' }), undefined);
  assert.equal(asGrant('nope'), undefined);
  assert.equal(asGrant(null), undefined);
});

test('the default redirect URI is loopback and uses the live port', () => {
  assert.equal(defaultRedirectUri({ port: 3080 }), 'http://127.0.0.1:3080/figma/oauth/callback');
  // A wildcard bind must still advertise loopback: the browser is local.
  assert.equal(defaultRedirectUri({ port: 1234, host: '0.0.0.0' }), 'http://127.0.0.1:1234/figma/oauth/callback');
  assert.equal(defaultRedirectUri({ port: 1234, callbackPath: '/cb' }), 'http://127.0.0.1:1234/cb');
  assert.equal(
    defaultRedirectUri({ port: 1, redirectUri: 'http://127.0.0.1:9/custom' }),
    'http://127.0.0.1:9/custom',
  );
});

test('isLoopbackRedirect accepts only absolute loopback http(s) URLs', () => {
  assert.equal(isLoopbackRedirect('http://127.0.0.1:3080/figma/oauth/callback'), true);
  assert.equal(isLoopbackRedirect('http://localhost:3080/cb'), true);
  assert.equal(isLoopbackRedirect('https://127.0.0.1/cb'), true);
  assert.equal(isLoopbackRedirect('https://evil.example/cb'), false);
  assert.equal(isLoopbackRedirect('file:///etc/passwd'), false);
  assert.equal(isLoopbackRedirect('not a url'), false);
  assert.equal(isLoopbackRedirect('/figma/oauth/callback'), false);
});

test('the default scopes exclude Enterprise-only scopes that would fail sign-in', () => {
  // Figma fails the entire authorization when asked for a scope the app cannot
  // enable ("Invalid scopes for app"). file_variables:read is Enterprise-only,
  // so requesting it by default would break sign-in for everyone else.
  const scopes = DEFAULT_SCOPES.split(' ');
  assert.equal(
    scopes.includes('file_variables:read'),
    false,
    'file_variables:read must not be requested by default; add it through the scopes config on Enterprise',
  );
  assert.equal(ENTERPRISE_VARIABLES_SCOPE, 'file_variables:read');
});

test('the default scopes cover every scope the tools need, and no more', () => {
  const scopes = DEFAULT_SCOPES.split(' ').filter((scope) => scope.length > 0);
  // Every tool's endpoint group must be reachable.
  for (const required of [
    'current_user:read',
    'file_content:read',
    'file_metadata:read',
    'file_comments:read',
    'file_comments:write',
    'file_dev_resources:read',
    'library_content:read',
    'library_assets:read',
  ]) {
    assert.ok(scopes.includes(required), `${required} is needed by a bundled tool`);
  }
  // No duplicates, and nothing outside the documented set.
  assert.equal(new Set(scopes).size, scopes.length, 'no scope may repeat');
});
