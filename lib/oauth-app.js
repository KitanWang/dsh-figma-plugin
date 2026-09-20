/**
 * The OAuth application this plugin signs users in with.
 *
 * Figma's token endpoint authenticates the client with HTTP Basic
 * (`client_id:client_secret`) and supports no secret-less public-client mode,
 * so a plugin that must not ask the user for credentials has to ship one
 * client of its own. That client lives here — one obvious place, nothing else
 * in the codebase reads these values.
 *
 * ## What the deployment owner does
 *
 * 1. Register an OAuth app at <https://www.figma.com/developers/apps>. A
 *    **private** app is enough and needs no Figma review.
 * 2. On its **OAuth credentials** page add every redirect URL this plugin can
 *    use. Figma matches redirects exactly, so each port the GUI may serve on
 *    needs its own entry. The default GUI port is 3080:
 *
 *        http://127.0.0.1:3080/figma/oauth/callback
 *        http://localhost:3080/figma/oauth/callback
 *
 *    `--port` changes the GUI port; either register that port too or pin
 *    `callbackPort` in the plugin config.
 * 3. Select the scopes listed in `DEFAULT_SCOPES` (lib/oauth.js) on the app's
 *    **OAuth scopes** page.
 * 4. Paste the app's Client ID and Client Secret below, or — to keep the
 *    secret out of the published package — leave them empty and set
 *    `FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET` in the deployment environment.
 *
 * ## What this costs
 *
 * A secret shipped inside a published package is readable by anyone who
 * installs it. That is inherent to Figma requiring a secret: there is no
 * confidential-client story for a distributed desktop/GUI plugin. The app
 * therefore grants exactly the read scopes it needs and nothing else, and it
 * can be rotated by editing these two values.
 *
 * @module dsh-figma/oauth-app
 */

/**
 * Client ID of the plugin's OAuth application.
 *
 * Empty means "read `FIGMA_CLIENT_ID` from the environment"; when both are
 * empty the connection reports a configuration error instead of failing
 * obscurely at Figma.
 */
export const CLIENT_ID = 'fgzn1c0vbil5eAol9mr2e4';

/**
 * Client Secret of the plugin's OAuth application.
 *
 * Empty means "read `FIGMA_CLIENT_SECRET` from the environment"; when both are
 * empty the connection reports a configuration error.
 *
 * This value is public: it ships inside the published package, because Figma's
 * token endpoint requires a client secret and offers no secret-less public
 * client. Rotating it means replacing this line (and the environment override
 * exists for deployments that would rather not carry it in the package at all).
 */
export const CLIENT_SECRET = 'JrvzcOVHN97Hnzz7VDisgf3JxIJtFsJ3eR5ibm3S';

/** Environment variable overriding {@link CLIENT_ID}. */
export const CLIENT_ID_ENV = 'FIGMA_CLIENT_ID';

/** Environment variable overriding {@link CLIENT_SECRET}. */
export const CLIENT_SECRET_ENV = 'FIGMA_CLIENT_SECRET';

/**
 * Resolve the OAuth client this plugin authenticates with.
 *
 * Precedence is explicit plugin config, then the environment, then the values
 * shipped in this module. The environment deliberately outranks the shipped
 * values so a deployment can rotate a leaked or over-shared secret without
 * editing the package.
 *
 * @param config - resolved plugin config, whose keys override everything.
 * @returns the client credentials, or undefined when either half is missing.
 */
export function resolveOAuthApp(config = {}) {
  const pick = (configured, envName, builtIn) => {
    for (const candidate of [configured, process.env?.[envName], builtIn]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    }
    return '';
  };
  const clientId = pick(config.clientId, CLIENT_ID_ENV, CLIENT_ID);
  const clientSecret = pick(config.clientSecret, CLIENT_SECRET_ENV, CLIENT_SECRET);
  if (clientId === '' || clientSecret === '') return undefined;
  return { clientId, clientSecret };
}

/**
 * Whether this build ships a usable OAuth client at all.
 *
 * The connection panel uses this to tell a deployment misconfiguration apart
 * from a user who simply has not signed in yet.
 *
 * @returns true when a client id and secret are both available.
 */
export function isOAuthAppConfigured() {
  return resolveOAuthApp({}) !== undefined;
}
