/**
 * Route smoke test: mount the plugin in a real Cordis context alongside the
 * harness's own WebServer, ToolRuntime, SkillRegistry, and SystemPrompt, then
 * drive the OAuth connection routes over HTTP.
 *
 * `scripts/smoke.mjs` proves registration against the real service contracts;
 * this proves the browser-facing half — that the callback and the panel API
 * actually serve, that the redirect URL uses the live port, and that no secret
 * crosses the wire.
 *
 * Usage: node scripts/routes-smoke.mjs
 */

import { Context } from '@deepseek-ai/cordis';
import * as credentialsService from '@deepseek-ai/dsh-credentials';
import * as webServerService from '@deepseek-ai/dsh-host-webserver';
import * as skillService from '@deepseek-ai/dsh-skill';
import * as systemPromptService from '@deepseek-ai/dsh-system-prompt';
import * as toolsService from '@deepseek-ai/dsh-tools';

import * as figma from '../lib/index.js';

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** In-memory credential provider, standing in for dsh-credentials-local. */
class MemoryCredentials extends credentialsService.CredentialProvider {
  records = new Map();

  async readRecord(key) {
    return this.records.get(String(key));
  }

  async describeRecord(key) {
    return { configured: this.records.has(String(key)), writable: true };
  }

  async listRecords() {
    return [];
  }

  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(String(key)));
    if (next !== undefined) this.records.set(String(key), next);
    return this.records.get(String(key));
  }

  async deleteRecord(key) {
    this.records.delete(String(key));
  }
}

const ctx = new Context();
ctx.plugin(systemPromptService.default);
ctx.plugin(toolsService.default);
ctx.plugin(skillService.default);
ctx.plugin(webServerService.default, { host: '127.0.0.1', port: 0 });
ctx.plugin(MemoryCredentials);
ctx.plugin(figma, { clientId: 'smoke-client', clientSecret: 'smoke-client-secret' });

await new Promise((resolve) => setTimeout(resolve, 1200));

const webServer = ctx.get('webServer');
check(webServer !== undefined, 'ctx.webServer was not mounted');
const origin = `http://127.0.0.1:${webServer.port}`;

const status = await fetch(`${origin}/figma/api/v1/status`);
const statusBody = await status.json();
check(status.status === 200, `GET /figma/api/v1/status returned ${status.status}`);
check(statusBody.connected === false, 'a fresh connection should report not-connected');
check(statusBody.available === true, 'a build with an OAuth client should report sign-in as available');
// The browser contract is state only: no credential may ride along.
check(
  Object.keys(statusBody).sort().join(',') === 'available,connected,pending',
  `the status payload must expose state only, got ${Object.keys(statusBody).join(',')}`,
);
const statusText = JSON.stringify(statusBody);
for (const forbidden of ['stored-secret', 'smoke-client-secret']) {
  check(!statusText.includes(forbidden), `${forbidden} must never reach the browser`);
}

const connect = await fetch(`${origin}/figma/api/v1/connect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: '{}',
});
const connectBody = await connect.json();
check(connect.status === 200, `POST /figma/api/v1/connect returned ${connect.status}`);
check(
  typeof connectBody.authorizationUrl === 'string' && connectBody.authorizationUrl.startsWith('https://www.figma.com/oauth'),
  'connect must return a Figma authorization URL',
);
check(
  typeof connectBody.authorizationUrl === 'string' &&
    connectBody.authorizationUrl.includes(encodeURIComponent(`http://127.0.0.1:${webServer.port}/figma/oauth/callback`)),
  'the authorization URL must carry the redirect URI Figma will match, on the live port',
);
check(typeof connectBody.state === 'string' && connectBody.state.length >= 32, 'connect must return a high-entropy state');
check(
  typeof connectBody.authorizationUrl === 'string' && connectBody.authorizationUrl.includes('code_challenge_method=S256'),
  'the authorization URL must carry a PKCE challenge',
);

const crossOrigin = await fetch(`${origin}/figma/api/v1/connect`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: '{}',
});
check(crossOrigin.status === 403, `a cross-origin connect must be refused, got ${crossOrigin.status}`);

const forged = await fetch(`${origin}/figma/oauth/callback?state=forged&code=x`);
const forgedText = await forged.text();
check(forged.status === 400, `a forged callback state must fail, got ${forged.status}`);
check(forgedText.includes('Figma was not connected'), 'the callback must render a human-readable failure page');

const tools = ctx.get('tools');
check(tools?.get('figma_login') !== undefined, 'figma_login is not registered');

if (failures.length > 0) {
  console.error('route smoke FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`route smoke passed: web server on ${origin}`);
console.log(`  GET  /figma/api/v1/status        → connected=${statusBody.connected}, available=${statusBody.available}, state-only payload`);
console.log(`  POST /figma/api/v1/connect       → Figma authorization URL with state + PKCE`);
console.log(`  POST /figma/api/v1/connect (evil) → 403`);
console.log(`  GET  /figma/oauth/callback (forged state) → 400 with a rendered page`);
console.log('  no credential crossed the wire');
process.exit(0);
