import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Client-half tests.
 *
 * The browser bundle is plain factory-form JavaScript written for the harness
 * module loader, so it can be exercised in Node: load it through the same
 * `window.__ModuleLoader__.load` contract, supply a React stub, and walk the
 * element tree the page actually returns. That catches reference errors, bad
 * hook usage, and wrong labels on every state — without a browser.
 *
 * Two invariants get the most attention, because they are the redesign's whole
 * point: the sidebar carries no Figma entry, and the browser never renders a
 * credential of any kind.
 */

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** The npm package name. The loader resolves a browser bundle by exactly this
 * string, so the bundle's registration id and the manifest must never drift. */
const PACKAGE_NAME = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

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
  const insertedCss = [];
  let load = null;

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (value) => { load = value; } } };
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: "", remove() {} }),
    head: { appendChild: (tag) => insertedCss.push(tag.textContent) },
    querySelector: () => null,
    baseURI: "http://127.0.0.1:3080/",
  };

  const requireStub = (spec) => {
    if (spec === "react") return React;
    if (spec === "@deepseek-ai/dsh-client-ui-primitives") return { Button: "Button" };
    throw new Error(`unexpected require: ${spec}`);
  };

  try {
    new Function("require", SOURCE)(requireStub);
    assert.ok(load !== null, "the bundle did not register through __ModuleLoader__.load");
    const mod = load.factory(requireStub);
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
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
}

/** Walk a component tree, invoking function components and collecting text. */
function render(React, node, ownerProps = {}) {
  const texts = [];
  const labels = [];
  const attributes = [];
  const visit = (element) => {
    if (element === null || element === undefined || typeof element === "boolean") return;
    if (typeof element === "string" || typeof element === "number") {
      texts.push(String(element));
      return;
    }
    if (Array.isArray(element)) {
      for (const child of element) visit(child);
      return;
    }
    for (const [key, value] of Object.entries(element.props ?? {})) {
      if (typeof value === "string") attributes.push(`${key}=${value}`);
      if (key === "aria-label" || key === "title") labels.push(value);
    }
    if (typeof element.type === "function") {
      visit(element.type({ ...ownerProps, ...element.props, children: element.children }));
      return;
    }
    for (const child of element.children ?? []) visit(child);
  };
  visit(node);
  return {
    texts,
    labels,
    text: texts.join(" | "),
    labelText: labels.join(" | "),
    markup: `${texts.join(" | ")} || ${attributes.join(" | ")}`,
  };
}

/** The base status every state derives from. */
function status(overrides = {}) {
  return { connected: false, available: true, pending: null, ...overrides };
}

/** Render the settings page for a given status payload. */
async function renderPage(payload, options = {}) {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === "settings.section");
  assert.ok(registration !== undefined, "settings.section was not registered");
  const { store, t } = registration.injected;

  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).includes("/connect")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ authorizationUrl: "https://www.figma.com/oauth?state=s", state: "s" }) };
    }
    const body = typeof payload === "function" ? payload() : payload;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  if (options.seed !== false) await store.refresh({});
  const result = render(React, React.createElement(registration.component, { t, store }), {});
  return { ...result, store, registration, urls };
}

test("the bundle registers exactly one surface: the Settings page", () => {
  const { mod, registrations } = mount();
  assert.equal(mod.name, "dsh-figma");
  assert.deepEqual(mod.inject, ["slots", "locale"]);

  const names = registrations.map((entry) => entry.options.name);
  assert.deepEqual(names, ["settings.section"], "the Figma page must be the only browser surface");
  // The sidebar seat was removed on request.
  assert.equal(names.includes("sidebar.footer.action"), false);
  assert.equal(names.includes("sidebar.panellist"), false);

  const section = registrations[0].options;
  assert.equal(section.id, "figma");
  assert.equal(typeof section.order, "number");
});

test("the bundle requires only modules the client seed table provides", () => {
  const requires = [...new Set([...SOURCE.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))];
  const seed = new Set(["react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/dsh-client-ui-primitives"]);
  for (const spec of requires) assert.ok(seed.has(spec), `require("${spec}") has no module source in a packaged bundle`);
});

test("the bundle registers under its npm package name", () => {
  // client-modules matches a served bundle to its graph row by this id, so a
  // rename that misses lib/client.js silently breaks the whole browser half.
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(SOURCE);
  assert.equal(match?.[1], PACKAGE_NAME);
});

test("the page injects a theme-token stylesheet", () => {
  const { insertedCss } = mount();
  assert.equal(insertedCss.length, 1);
  assert.match(insertedCss[0], /\.figma-page/);
  // Tokens, not hard-coded colors, so the page follows the active theme.
  assert.match(insertedCss[0], /--dsw-alias-/);
});

test("a disconnected page invites the user to connect", async () => {
  const { text, markup } = await renderPage(status({ connected: false }));
  assert.match(text, /Figma is not connected/);
  assert.match(text, /Connect Figma/);
  assert.doesNotMatch(text, /Reconnect/);
  // The action is a real button, not a link to a credential form.
  assert.match(markup, /variant=primary/);
});

test("a connected page shows the account and offers reconnect", async () => {
  const { text } = await renderPage(
    status({ connected: true, account: { verified: true, handle: "designer", email: "d@example.com" } }),
  );
  assert.match(text, /Figma is connected/);
  assert.match(text, /Signed in as/);
  assert.match(text, /designer <d@example\.com>/);
  assert.match(text, /Reconnect/);
  assert.doesNotMatch(text, /Connect Figma/);
});

test("a connected page with an unreadable account still reports connected", async () => {
  const { text } = await renderPage(status({ connected: true, account: { verified: false, note: "nope" } }));
  assert.match(text, /Figma is connected/);
  assert.match(text, /Connected \(account details unavailable\)/);
});

test("the browser is never shown a token, a secret, or an expiry", async () => {
  const { markup } = await renderPage(
    status({ connected: true, account: { verified: true, handle: "designer" } }),
  );
  for (const forbidden of [
    /access[_ ]?token/i,
    /refresh[_ ]?token/i,
    /client[_ ]?secret/i,
    /client[_ ]?id/i,
    /expires/i,
    /expiry/i,
    /personal access token/i,
    /\bPAT\b/,
    /redirect uri/i,
    /scope/i,
  ]) {
    assert.doesNotMatch(markup, forbidden, `the page must not mention ${forbidden}`);
  }
});

test("the page issues no request that could carry credentials to the browser", async () => {
  const { urls } = await renderPage(status({ connected: true, account: { verified: true, handle: "d" } }));
  assert.ok(urls.length > 0, "the page should read the status");
  for (const call of urls) {
    assert.match(call, /^GET .*\/figma\/api\/v1\/status/);
  }
  // Nothing in the module posts credentials anywhere.
  assert.doesNotMatch(SOURCE, /clientSecret\s*:/);
  assert.doesNotMatch(SOURCE, /clientId\s*:/);
});

test("a pending authorization shows the waiting state with cancel and reopen", async () => {
  const { text } = await renderPage(status({ pending: { state: "abc", status: "pending", startedAt: Date.now() } }));
  assert.match(text, /Waiting for you to finish in the browser/);
  assert.match(text, /Cancel/);
  assert.match(text, /Reopen authorization page/);
});

test("each settled authorization outcome is reported in plain language", async () => {
  const cases = [
    ["denied", /declined/],
    ["cancelled", /cancelled/],
    ["expired", /timed out/],
    ["unknown-state", /did not match this sign-in/],
    ["failed", /Authorization failed/],
  ];
  for (const [state, expected] of cases) {
    const { text } = await renderPage(status({ pending: { state: "abc", status: state, error: state === "failed" ? "boom" : undefined } }));
    assert.match(text, expected, `the ${state} outcome should be explained`);
  }
  const authorized = await renderPage(status({ connected: true, pending: { state: "abc", status: "authorized" } }));
  assert.match(authorized.text, /Authorized — Figma is connected/);
});

test("a deployment without an OAuth client explains the fault instead of showing a dead button", async () => {
  const { text, markup } = await renderPage(status({ available: false }));
  assert.match(text, /no Figma OAuth client/);
  assert.doesNotMatch(markup, /variant=primary/, "no action should be offered when sign-in cannot work");
});

test("a blocked popup keeps the authorization link reachable", async () => {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === "settings.section");
  const { store, t } = registration.injected;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(status({})) });
  await store.refresh({});
  store.notifyBlocked("https://www.figma.com/oauth?state=blocked");
  // useStore reads a live snapshot, so a fresh render must see the blocked URL.
  const result = render(React, React.createElement(registration.component, { t, store }), {});
  assert.match(result.text, /blocked the popup/);
  assert.match(result.text, /Open authorization page/);
});

test("pressing connect starts authorization and opens Figma's page", async () => {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === "settings.section");
  const { store, t } = registration.injected;

  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: previousWindow?.__ModuleLoader__, open: (url, ...rest) => { opened.push({ url, rest }); return {}; } };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/connect")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ authorizationUrl: "https://www.figma.com/oauth?state=s", state: "s" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(status({})) };
  };
  await store.refresh({});

  // Find the Connect button by expanding the tree exactly as render() does.
  const buttons = [];
  const walk = (element) => {
    if (element === null || element === undefined || typeof element !== "object") return;
    if (Array.isArray(element)) {
      for (const child of element) walk(child);
      return;
    }
    if (element.type === "Button") {
      // A Button's label is a child element, not a props string.
      const label = element.children.flat().map((child) => (typeof child === "string" ? child : "")).join("");
      buttons.push({ element, label });
    }
    if (typeof element.type === "function") {
      walk(element.type({ t, store, children: element.children }));
      return;
    }
    for (const child of element.children ?? []) walk(child);
  };
  walk(React.createElement(registration.component, { t, store }));

  const connectButton = buttons.find((button) => /Connect Figma/.test(button.label));
  assert.ok(connectButton !== undefined, "the page should render a Connect Figma button");
  await connectButton.element.props.onClick();

  assert.equal(opened.length, 1, "Figma's authorization page should have been opened");
  assert.equal(opened[0].url, "https://www.figma.com/oauth?state=s");
  // Opened in a separate browsing context, so the GUI stays put.
  assert.equal(opened[0].rest[0], "_blank");

  globalThis.window = previousWindow;
});

test("the page renders while the first status is still loading", () => {
  const { React, registrations } = mount();
  const registration = registrations.find((entry) => entry.options.name === "settings.section");
  // No refresh: the snapshot is still loading, which must not crash the shell.
  const result = render(React, React.createElement(registration.component, registration.injected), {});
  assert.match(result.text, /Checking the connection/);
});

test("the waiting state shows the callback URL so a port mismatch is diagnosable", async () => {
  const payload = status({ pending: { state: "abc", status: "pending", startedAt: Date.now() } });
  payload.redirectUri = "http://127.0.0.1:8080/figma/oauth/callback";
  const { text } = await renderPage(payload);
  // Figma matches redirect URLs verbatim; without this the only symptom is an
  // error on Figma's own page, with nothing to compare against.
  assert.match(text, /http:\/\/127\.0\.0\.1:8080\/figma\/oauth\/callback/);
  assert.match(text, /Current callback URL/);
});

test("the connected page does not surface the callback URL as chrome", async () => {
  // It is troubleshooting information, not part of the normal connected view.
  const { text } = await renderPage(status({ connected: true, account: { verified: true, handle: "d" } }));
  assert.doesNotMatch(text, /Current callback URL/);
  assert.doesNotMatch(text, /oauth\/callback/);
});
