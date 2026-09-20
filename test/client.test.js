import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Client-half tests.
 *
 * The browser bundle is plain factory-form JavaScript written for the harness
 * module loader, so it can be exercised in Node: load it through the same
 * `window.__ModuleLoader__.load` contract, supply a React stub, and walk the
 * element tree the panels actually return. That catches reference errors,
 * bad hook usage, and wrong labels on every connection state — without a
 * browser or a Figma account.
 */

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** A minimal React stand-in with the hooks the bundle uses. */
function createReact() {
  const hookStack = [];
  const effects = [];
  return {
    effects,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useState(initial) {
      const frame = hookStack[hookStack.length - 1];
      if (frame !== undefined && frame.cursor < frame.values.length) {
        return [frame.values[frame.cursor++], () => {}];
      }
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useReducer(_reducer, initial) {
      return [initial, () => {}];
    },
    useEffect(effect) {
      effects.push(effect);
    },
  };
}

/** Load the bundle and run `apply` against a stub client context. */
function mount() {
  const React = createReact();
  const registrations = [];
  const dictionaries = new Map();
  let load = null;
  const insertedCss = [];

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (value) => { load = value; } } };
  // The style effect appends a tag; record it instead of touching a real DOM.
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (tag) => insertedCss.push(tag.textContent) },
    querySelector: () => null,
    baseURI: 'http://127.0.0.1:3080/',
  };

  try {
    new Function('require', SOURCE)((spec) => {
      if (spec === 'react') return React;
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'Button', Tooltip: 'Tooltip' };
      throw new Error(`unexpected require: ${spec}`);
    });
  } catch (error) {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    throw error;
  }

  assert.ok(load !== null, 'the bundle did not register through __ModuleLoader__.load');
  const mod = load.factory((spec) => {
    if (spec === 'react') return React;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Button: 'Button', Tooltip: 'Tooltip' };
    throw new Error(`unexpected require: ${spec}`);
  });

  const ctx = {
    effect: (fn) => {
      fn();
      return () => {};
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries.set(ns, dicts);
        return () => {};
      },
      bind: (ns) => (key) => dictionaries.get(ns)?.en?.[key] ?? key,
    },
    slots: {
      inject: (_key, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        registrations.push({ options, component, injected: options.inject?.() ?? {} });
        return () => {};
      },
    },
  };

  mod.apply(ctx);
  return { React, registrations, insertedCss, mod };
}

/** Walk a component tree, invoking function components and collecting text. */
function render(React, node, ownerProps = {}) {
  const texts = [];
  const labels = [];
  const visit = (element) => {
    if (element === null || element === undefined || typeof element === 'boolean') return;
    if (typeof element === 'string' || typeof element === 'number') {
      texts.push(String(element));
      return;
    }
    if (Array.isArray(element)) {
      for (const child of element) visit(child);
      return;
    }
    // Accessible names matter for icon-only controls, which carry no text.
    for (const key of ['aria-label', 'title']) {
      const value = element.props?.[key];
      if (typeof value === 'string') labels.push(value);
    }
    if (typeof element.type === 'function') {
      const produced = element.type({ ...ownerProps, ...element.props, children: element.children });
      visit(produced);
      return;
    }
    for (const child of element.children ?? []) visit(child);
  };
  visit(node);
  return { texts, labels, text: texts.join(' | '), labelText: labels.join(' | ') };
}

/** Register a status payload the store will observe through the panel API. */
function stubApi(store, payloads) {
  let index = 0;
  globalThis.fetch = async () => {
    const payload = Array.isArray(payloads) ? payloads[Math.min(index++, payloads.length - 1)] : payloads;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  return store;
}

/** The base status every state is derived from. */
function status(overrides = {}) {
  return {
    mode: 'none',
    connected: false,
    oauthSupported: true,
    clientConfigured: true,
    clientId: 'client-1',
    clientSecretSet: true,
    redirectUri: 'http://127.0.0.1:3080/figma/oauth/callback',
    scopes: 'file_content:read',
    tokenSource: null,
    expiresAt: null,
    personalAccessToken: false,
    pending: null,
    canDisconnect: false,
    ...overrides,
  };
}

/** Render a registered slot's component for a given status. */
async function renderSlot(slotName, payload) {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === slotName);
  assert.ok(registration !== undefined, `${slotName} was not registered`);
  const { store, t } = registration.injected;
  stubApi(store, payload);
  await store.refresh({});
  const result = render(React, React.createElement(registration.component, { t, store }), { wide: true });
  return { ...result, joined: `${result.text} || ${result.labelText}`, store, registration };
}

test('the bundle registers a settings page and a sidebar status action', () => {
  const { mod, registrations } = mount();
  assert.equal(mod.name, 'dsh-figma');
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  const byName = Object.fromEntries(registrations.map((entry) => [entry.options.name, entry.options]));
  assert.equal(byName['settings.section'].id, 'figma');
  assert.equal(byName['sidebar.footer.action'].id, 'figma');
  // The status action sits near the settings trigger at the sidebar foot.
  assert.ok(typeof byName['sidebar.footer.action'].order === 'number');
});

test('the bundle requires only modules the client seed table provides', () => {
  const requires = [...new Set([...SOURCE.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))];
  const seed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives']);
  for (const spec of requires) assert.ok(seed.has(spec), `require("${spec}") has no module source in a packaged bundle`);
});

test('the bundle registers under its package name', () => {
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(SOURCE);
  assert.equal(match?.[1], 'dsh-figma');
});

test('the panel injects its own stylesheet', () => {
  const { insertedCss } = mount();
  assert.equal(insertedCss.length, 1);
  assert.match(insertedCss[0], /\.figma-panel/);
  // Tokens, not hard-coded colors, so the panel follows the active theme.
  assert.match(insertedCss[0], /--dsw-alias-/);
});

test('a connected OAuth account renders its handle, expiry, and disconnect', async () => {
  const { joined } = await renderSlot(
    'settings.section',
    status({
      mode: 'oauth',
      connected: true,
      canDisconnect: true,
      expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      account: { verified: true, handle: 'designer', email: 'd@example.com' },
    }),
  );
  assert.match(joined, /Connected/);
  assert.match(joined, /OAuth sign-in/);
  assert.match(joined, /designer <d@example\.com>/);
  assert.match(joined, /Re-authorize/);
  assert.match(joined, /Disconnect/);
});

test('the settings page never shows a token or secret value', async () => {
  const { joined } = await renderSlot(
    'settings.section',
    status({ mode: 'oauth', connected: true, canDisconnect: true, expiresAt: null, account: { verified: true, handle: 'designer' } }),
  );
  // Only presence is ever rendered for secret material.
  assert.match(joined, /Client Secret is set/);
  assert.doesNotMatch(joined, /stored-secret|access_token|refresh_token/i);
});

test('a disconnected deployment renders the OAuth setup walkthrough', async () => {
  const { joined } = await renderSlot('settings.section', status({ clientConfigured: false, clientId: null, clientSecretSet: false }));
  assert.match(joined, /An OAuth app is required first/);
  // The exact redirect URL is the one thing that must be copied verbatim.
  assert.match(joined, /http:\/\/127\.0\.0\.1:3080\/figma\/oauth\/callback/);
  assert.match(joined, /Client ID/);
  assert.match(joined, /Client Secret/);
  assert.match(joined, /figma\.com\/developers\/apps|Open Figma developer apps/);
});

test('a pending authorization renders the waiting state and a cancel action', async () => {
  const { joined } = await renderSlot(
    'settings.section',
    status({ pending: { state: 'abc', status: 'pending', startedAt: Date.now() } }),
  );
  assert.match(joined, /Waiting for you to finish authorizing/);
  assert.match(joined, /Cancel authorization/);
});

test('a PAT connection is reported as such with its refresh caveat', async () => {
  const { joined } = await renderSlot(
    'settings.section',
    status({ mode: 'pat', connected: true, personalAccessToken: true, tokenSource: 'environment FIGMA_ACCESS_TOKEN' }),
  );
  assert.match(joined, /Personal access token/);
  assert.match(joined, /cannot refresh itself/);
  assert.match(joined, /switch to OAuth sign-in/);
});

test('OAuth setup reads as optional — not a blocker — while a PAT already works', async () => {
  const { joined } = await renderSlot(
    'settings.section',
    status({ mode: 'pat', connected: true, personalAccessToken: true, clientConfigured: false, clientId: null, clientSecretSet: false }),
  );
  // The upgrade path is offered, but framed as optional rather than required.
  assert.match(joined, /Optional: switch to OAuth sign-in/);
  assert.match(joined, /already works/);
  assert.doesNotMatch(joined, /An OAuth app is required first/);
});

test('OAuth setup reads as required when nothing else can authenticate', async () => {
  const { joined } = await renderSlot('settings.section', status({ clientConfigured: false, clientId: null, clientSecretSet: false }));
  assert.match(joined, /An OAuth app is required first/);
  assert.doesNotMatch(joined, /Optional: switch to OAuth sign-in/);
});

test('the setup form saves and continues into authorization in one action', async () => {
  const { registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === 'settings.section');
  const { store } = registration.injected;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    if (init?.method === 'POST') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ authorizationUrl: 'https://www.figma.com/oauth?x=1', state: 's' }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(status({ clientConfigured: false, clientId: null })) };
  };
  await store.refresh({});

  // The store must hand the URL back so the caller can open Figma's page;
  // otherwise the saved attempt sits pending with nobody sent to consent.
  const result = await store.saveClient('panel-id', 'panel-secret');
  assert.equal(result.saved, true);
  assert.equal(result.authorizationUrl, 'https://www.figma.com/oauth?x=1');
  const posted = calls.find((call) => call.method === 'POST');
  assert.match(posted.url, /\/figma\/api\/v1\/connect$/);
  assert.deepEqual(JSON.parse(posted.body), { clientId: 'panel-id', clientSecret: 'panel-secret' });
});

test('a failed credential save reports the error and offers no URL', async () => {
  const { registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === 'settings.section');
  const { store } = registration.injected;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'bad credentials' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(status({ clientConfigured: false })) };
  };
  await store.refresh({});
  const result = await store.saveClient('id', 'secret');
  assert.equal(result.saved, false);
  assert.equal(result.authorizationUrl, null);
  assert.equal(store.getSnapshot().error, 'bad credentials');
});

test('a deployment without a credential store explains why sign-in is unavailable', async () => {
  const { joined } = await renderSlot('settings.section', status({ oauthSupported: false, clientConfigured: false }));
  assert.match(joined, /mounts no credential store/);
});

test('the sidebar action reports the state and is labelled', async () => {
  const connected = await renderSlot('sidebar.footer.action', status({ mode: 'oauth', connected: true }));
  assert.match(connected.joined, /Figma/);
  const disconnected = await renderSlot('sidebar.footer.action', status({}));
  assert.match(disconnected.joined, /Figma/);
  // The compact seat drops the long explanatory copy.
  assert.doesNotMatch(disconnected.joined, /While disconnected/);
});

test('the sidebar action renders before any status arrives without throwing', () => {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === 'sidebar.footer.action');
  // No refresh: the snapshot is still loading, which must not crash the shell.
  const result = render(React, React.createElement(registration.component, registration.injected), { wide: false });
  // The collapsed seat is icon-only, so its name lives in the accessible label.
  assert.match(result.labelText, /Figma/);
});
