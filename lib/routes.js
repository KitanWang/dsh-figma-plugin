/**
 * The browser-facing half of the connection: the OAuth callback Figma
 * redirects to, and the small JSON API the settings panel calls.
 *
 * Two rules shape this layer.
 *
 * First, the callback is deliberately NOT behind the harness's own
 * cross-origin fence. Figma sends the browser back with a top-level
 * cross-site navigation, which that fence rejects with 403 — so `state`
 * verification is what authenticates this route. `state` is 32 random bytes
 * generated in this process and never leaves it except through the
 * authorization URL, and it is compared in constant time.
 *
 * Second, the callback must complete the token exchange inside the request
 * that carries the code, because Figma expires authorization codes after 30
 * seconds. Nothing slow may be awaited before the exchange.
 *
 * @module dsh-figma/routes
 */

/** Path the OAuth redirect lands on. Fixed, because Figma matches redirect URLs exactly. */
export const CALLBACK_PATH = '/figma/oauth/callback';

/** Prefix for the panel's own JSON API. */
export const API_PREFIX = '/figma/api';

/** Base path the panel's `api()` helper resolves against. */
export const API_BASE = `${API_PREFIX}/v1`;


/** Escape text for interpolation into HTML, so a Figma error cannot inject markup. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Write a JSON response with no-store caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** Write an HTML response. */
export function sendHtml(response, status, html) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  });
  response.end(html);
}

/**
 * Whether a mutating request came from this GUI.
 *
 * Every state-changing route is same-origin POST-only, and this checks that
 * the browser's `Origin` names the same authority as `Host`. A request with no
 * `Origin` at all is refused: the panel always sends one, so its absence means
 * the caller is not the panel.
 *
 * @param request - the incoming request.
 * @returns true when the request may mutate state.
 */
export function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * The page Figma's redirect lands on.
 *
 * It is read by a human in a browser tab, so it says what happened in plain
 * language and offers a link back to the GUI. It carries no token and no code.
 *
 * @param result - the settled attempt.
 * @param options - the GUI URL to link back to.
 * @returns a complete HTML document.
 */
export function resultPage(result, options = {}) {
  const ok = result.status === 'authorized';
  const title = ok ? 'Figma connected' : 'Figma was not connected';
  const detail =
    result.error ??
    (ok
      ? 'You can close this tab and return to DeepSeek Harness.'
      : 'Return to DeepSeek Harness and try connecting again.');
  const back = typeof options.guiUrl === 'string' && options.guiUrl.length > 0 ? options.guiUrl : null;
  const accent = ok ? '#1f9d55' : '#d64545';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #0f1115; color: #e6e8eb; }
  main { max-width: 34rem; padding: 2.5rem; text-align: center; }
  .badge { display: inline-grid; place-items: center; width: 3rem; height: 3rem;
           border-radius: 999px; margin-bottom: 1.25rem; font-size: 1.5rem;
           background: ${accent}22; color: ${accent}; border: 1px solid ${accent}55; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 1.5rem; color: #a8b0bb; }
  a { display: inline-block; padding: .6rem 1.1rem; border-radius: .5rem;
      background: #2b6cb0; color: #fff; text-decoration: none; }
</style>
</head>
<body>
<main>
  <div class="badge">${ok ? '&#10003;' : '&#33;'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${back === null ? '' : `<a href="${escapeHtml(back)}">Back to DeepSeek Harness</a>`}
</main>
</body>
</html>
`;
}

/**
 * Build the callback handler.
 *
 * @param connection - the Figma connection.
 * @param options - resolved callback path and a GUI URL for the result page.
 * @returns an HTTP handler owning the full response.
 */
export function createCallbackHandler(connection, options = {}) {
  const path = options.callbackPath ?? CALLBACK_PATH;
  return async function handleCallback(request, response) {
    const url = new URL(request.url ?? path, 'http://127.0.0.1');
    const params = url.searchParams;
    let result;
    try {
      result = await connection.completeAuthorization({
        state: params.get('state') ?? undefined,
        code: params.get('code') ?? undefined,
        error: params.get('error') ?? undefined,
        errorDescription: params.get('error_description') ?? undefined,
      });
    } catch (error) {
      result = { status: 'failed', error: error?.message ?? String(error) };
    }
    sendHtml(response, result.status === 'authorized' ? 200 : 400, resultPage(result, { guiUrl: options.guiUrl }));
  };
}

/**
 * Build the panel's JSON API handler.
 *
 * Routes are addressed relative to {@link API_BASE} so the browser can resolve
 * them against `document.baseURI`, matching how the harness mounts the GUI.
 *
 * @param connection - the Figma connection.
 * @param options - the API prefix and a hook invoked after a successful change.
 * @returns an HTTP handler owning the full response.
 */
export function createApiHandler(connection, options = {}) {
  const prefix = options.prefix ?? API_BASE;
  return async function handleApi(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const method = request.method ?? 'GET';

    try {
      if (route === '/status' && method === 'GET') {
        const verify = url.searchParams.get('verify') === '1';
        sendJson(response, 200, await connection.status({ verify }));
        return;
      }

      if (route === '/connect' && method === 'POST') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'the connect request did not come from this GUI' });
          return;
        }
        const started = await connection.beginAuthorization();
        sendJson(response, 200, {
          authorizationUrl: started.url,
          state: started.state,
          reused: started.reused === true,
        });
        return;
      }

      if (route === '/cancel' && method === 'POST') {
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'the cancel request did not come from this GUI' });
          return;
        }
        const cancelled = connection.cancelAuthorization();
        sendJson(response, 200, { cancelled });
        return;
      }

      sendJson(response, 404, { error: `no Figma route ${method} ${route}` });
    } catch (error) {
      sendJson(response, 400, { error: error?.message ?? String(error) });
    }
  };
}
