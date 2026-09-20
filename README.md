# dsh-figma

Figma design context for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
English | [中文](README.zh.md)

Hand DSH a Figma link and it can read the design: the node tree with its
auto-layout, sizing, paints and typography, the design tokens the nodes are
bound to, and a rendered screenshot it can actually look at — then write UI
code that matches. Plus four bundled skills that carry the workflow.

Connect a Figma account with one button — **no token to create, copy, or
paste** — and the agent can read the design.

This is the DSH counterpart to the Figma plugin in Codex. See
[How this compares](#how-this-compares-to-the-codex-figma-plugin) for what is
the same and what is different.

## Install

```sh
dsh plugin --profile web add dsh-figma
```

Then restart `dsh web` (a newly added bundle is composed at boot).

## Connect Figma

Open **Settings → Figma** and press **Connect Figma**. Your browser opens
Figma's own sign-in and consent page; approve it and the page flips to
*Connected*, showing which Figma account you are using.

That is the whole flow. The plugin carries its own Figma OAuth application, so
you never register one, and nothing about credentials is ever shown in the
browser.

Already connected and want a different account? Press **Reconnect** — it starts
a fresh sign-in and replaces the stored grant.

You can also ask the agent:

> Connect to Figma.

The agent calls `figma_login`, which returns the authorization URL for you to
open. The agent never asks you to paste a token into chat.

### How the connection is stored

The granted access and refresh tokens are stored as one credential *record*
(`figma/oauth`) in the harness credential store
(`$DSH_HOME/.credentials.yaml`), and the access token is refreshed
automatically before it expires. The browser only ever learns whether the
connection is live and which account it belongs to — never a token, an expiry,
or any part of the OAuth client.

**No personal access token path.** A PAT would mean asking you to create a
token in Figma's settings and paste it in, which is exactly the friction this
plugin exists to remove. If you need token-based authentication for CI, use a
separate integration.


```sh
export FIGMA_ACCESS_TOKEN=figd_xxx
dsh web
```

To set config explicitly, target the row by id in the profile's
`cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: figma
  config:
    outputDir: .figma
    callbackPort: 3080
```

## Tools

| Tool | What it does |
| --- | --- |
| `figma_get_design_context` | **Start here.** One node as a compact structured tree + indented outline + rendered screenshot, with the Figma variables the node binds resolved to names and per-mode values. |
| `figma_get_screenshot` | Render one or more nodes to PNG/JPG/SVG/PDF, save them, and attach the image for viewing. |
| `figma_get_file` | List a file's pages and top-level frames — use it to find the node id when you only have a file link. |
| `figma_get_variables` | The file's local variables as design tokens: per-mode values with aliases resolved. Optionally write CSS and/or JSON. |
| `figma_get_styles` | Published paint, text, effect, and grid styles **with their values**. |
| `figma_get_components` | Components and component sets with keys, node ids, and variant properties. |
| `figma_get_dev_resources` | Dev resources (linked docs, tickets, code) attached to nodes. |
| `figma_get_comments` | Comment threads with their node anchors. |
| `figma_post_comment` | Post a comment anchored to a node or canvas position. Writes to Figma — confirm first. |
| `figma_whoami` | Verify the connection and report the authenticated account. |
| `figma_login` | Report the connection, or start sign-in and return the URL for the human to open. |

Every tool accepts either a full Figma URL (`url`) or a bare file key
(`fileKey`); node ids may be written `1-2` (URL form) or `1:2` (API form).
URLs for design, legacy file, proto, FigJam board, and Slides all parse.

### Example

> Implement this frame: `https://www.figma.com/design/AbC123/Home?node-id=12-345`

The agent calls `figma_get_design_context`, reads the outline and the
screenshot, checks the repo's existing components and tokens, and writes the
component. The `figma-design-to-code` skill drives that sequence.

## Skills

Four skills are registered into the harness-global skill layer, so every agent
and preset sees them:

| Skill | For |
| --- | --- |
| `figma-design-to-code` | Implement a frame with fidelity; map it onto the repo's components and tokens; verify against the screenshot. |
| `figma-design-system` | Inventory variables, styles, and components; emit tokens and a durable rules document. |
| `figma-code-connect` | Generate Code Connect templates binding Figma components to code components. |
| `figma-design-review` | Compare an implementation against its design and report measured deltas, optionally as Figma comments. |

## Configuration

All keys are optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | `https://api.figma.com` | Override for a proxy. |
| `requestTimeoutMs` | `30000` | Per-request timeout. |
| `maxRetries` | `2` | Retries for 429/5xx, honouring `Retry-After`. |
| `outputDir` | `.dsh-figma` | Where exports are written; relative paths resolve against the session workspace. |
| `maxNodes` | `400` | Default node budget for a design-context projection. |
| `maxDepth` | `8` | Default depth budget. |
| `skills` | `true` | Register the bundled skills. |
| `scopes` | see below | Space-separated OAuth scopes requested at authorization. |
| `callbackPort` | `0` | Port advertised in the redirect URL. `0` follows the live GUI port. |
| `redirectUri` | `''` | Absolute redirect URI override; must match the Figma app exactly. Only loopback URLs are accepted. |
| `callbackPath` | `/figma/oauth/callback` | Callback path appended to the redirect URI. |
| `connectionRoutes` | `true` | Serve the OAuth callback and connection page. Off means tools-only, with no HTTP surface. |
| `authorizationUrl` / `tokenUrl` / `refreshUrl` | Figma's endpoints | Overridable for a proxy, a test, or Figma for Government. |
| `clientId` / `clientSecret` | shipped values | The plugin's own OAuth app. Only a fork or a deployment that wants a different app sets these; they are never read from or written by the browser. |
| `tools` | all on | Per-tool switches: `whoami`, `file`, `designContext`, `screenshot`, `variables`, `styles`, `components`, `devResources`, `comments`, `postComment`, `login`. |

The default scopes are `current_user:read`, `file_content:read`,
`file_metadata:read`, `file_comments:read`, `file_comments:write`,
`file_dev_resources:read`, `library_content:read`, and `library_assets:read`.

Figma fails the whole authorization when it is asked for a scope the app does
not have enabled, so **these must all be selected on the app's OAuth scopes
page**. `file_variables:read` is intentionally excluded because Figma marks it
Enterprise-only: on any other plan it cannot be enabled at all, and requesting
it would break sign-in entirely. On Enterprise, enable it on the app and add it
through the `scopes` config to make `figma_get_variables` work.

### The plugin's OAuth app

Figma's token endpoint authenticates the client with HTTP Basic
(`client_id:client_secret`) and supports no secret-less public-client mode, so a
plugin that must not ask the user for credentials has to ship one client of its
own. It lives in one place — [`lib/oauth-app.js`](lib/oauth-app.js) — and a fork
or deployment can override it with config or with `FIGMA_CLIENT_ID` /
`FIGMA_CLIENT_SECRET`.

Because Figma matches redirect URLs exactly, the app must list every redirect a
deployment can use. The default GUI port is 3080:

```
http://127.0.0.1:3080/figma/oauth/callback
http://localhost:3080/figma/oauth/callback
```

If the GUI runs on another port, register that port on the app or pin
`callbackPort`.

### Tools-only deployments

A deployment with no web server (or `connectionRoutes: false`) registers the
tools but no HTTP route. `figma_login` then reports that sign-in is unavailable,
and the tools explain that Figma is not connected. There is no token fallback:
this plugin authenticates only through its own OAuth grant.

## Security notes

- The OAuth callback is an ordinary HTTP route, deliberately **not** behind the
  harness's cross-origin API fence: Figma returns the browser with a top-level
  cross-site navigation, which that fence rejects. `state` is therefore the
  authentication — 32 random bytes generated in-process, compared in constant
  time, and required to match a pending attempt.
- Every state-changing route is same-origin POST only. A request with no
  `Origin` is refused rather than trusted, and a posted body cannot substitute
  client credentials.
- The browser never receives the access token, the refresh token, or any part of
  the OAuth client. The status payload is exactly `connected`, `available`, and
  the pending attempt's state — asserted against leakage in the test suite.
- The redirect URI must be a loopback http(s) URL, so a one-time code cannot be
  sent to a host this process does not own.
- Figma expires authorization codes after 30 seconds, so the exchange happens
  inside the callback request itself, before anything else is awaited.
- The shipped client secret is readable by anyone who installs the package.
  That is inherent to Figma requiring a secret; the app therefore requests only
  the scopes it needs, and a deployment can rotate it by setting its own values.

## How this compares to the Codex Figma plugin

The Codex plugin is three things bolted together: a `.codex-plugin/plugin.json`
manifest, an app connector (`.app.json` → Figma's hosted MCP server), and a
bundle of skills, agents, commands, and a post-write hook. The design
intelligence lives in Figma's MCP server; the plugin is mostly wiring plus
prompt material.

DSH has the same *primitives* — a skill registry (`ctx.skills`), a tool
registry (`ctx.tools`), subagents, and an MCP bridge
(`@deepseek-ai/dsh-mcp-client`) — but nothing packaged for Figma. This plugin
fills that gap natively rather than by proxying Figma's MCP server, so it needs
no running Figma desktop:

| | Codex + Figma plugin | dsh-figma |
| --- | --- | --- |
| Design reads | Figma MCP server (OAuth) | Figma REST API (OAuth) |
| Sign-in | browser authorization, hosted by Figma | browser authorization, hosted by Figma |
| OAuth client | Figma's own, shipped in the connector | the plugin's own, shipped in `lib/oauth-app.js` |
| Credential storage | connector-managed | harness credential store (`records`), auto-refreshed |
| Credentials the user handles | none | none |
| Requires Figma desktop running | No (hosted MCP) | No |
| Skills | 7 bundled, Figma-authored | 4 bundled, written for these tools |
| Design tokens | via MCP `get_variable_defs` | `figma_get_variables` (modes + alias resolution + CSS/JSON export) |
| Code Connect | MCP + Figma CLI | skill guides template generation; publish with the Figma CLI |
| Write back to canvas | Yes (MCP + Plugin API) | **No** — see below |
| Setup | install plugin, authorize Figma | install plugin, click **Connect Figma** |

### Why the plugin ships its own OAuth app

Figma's token endpoint authenticates the client with HTTP Basic
(`client_id:client_secret`) and supports no secret-less public-client mode, so
there is no way to sign a user in without some client secret. Shipping one in
the package keeps the user's side to a single button; the tradeoff is that the
secret is readable by anyone who installs the plugin. Figma also restricts
hosted-MCP dynamic client registration to clients in its MCP Catalog, so a
third-party plugin cannot mint a shared client either.

### Want Figma's own MCP tools too?

They coexist. Point the harness MCP bridge at Figma's local Dev Mode server
(Figma desktop → Preferences → **Enable Dev Mode MCP Server**) and you get
`mcp__figma__*` tools alongside the `figma_*` ones:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: figma-devmode-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: streamable-http
        serverName: figma
        url: http://127.0.0.1:3845/mcp
        headers: {}
        toolCallTimeoutMs: 60000
        failOnStartupError: false
```

That is the closest thing to a drop-in replacement for Codex's app connector,
and it is what you want if you need canvas write-back. The bridge's HTTP
transport takes headers, not an OAuth flow, so Figma's *hosted* MCP endpoint
(`https://mcp.figma.com/mcp`) is not usable through it without a bearer token
of your own.

## Limitations

- **No canvas write-back.** Creating or editing nodes in Figma is only
  possible through the Plugin API (which runs inside Figma) or Figma's MCP
  server. Use the MCP bridge above if you need it. This plugin reads.
- **Variables need Figma Enterprise.** `figma_get_variables` calls an endpoint
  restricted to full members of Enterprise orgs. On a lower plan it fails with
  a clear message; `figma_get_styles` still works.
- **Code Connect is guided, not automated.** There is no Code Connect endpoint
  in the Figma REST API. The skill reads the component inventory and writes
  template files; publishing them is the Figma CLI's job.
- **Exports land on disk.** Screenshots are written under `outputDir`
  (default `<workspace>/.dsh-figma/`). Add that to your `.gitignore`. An image
  is also attached inline whenever the current model accepts image input.
- **Rate limits are Figma's.** The client retries 429/5xx with backoff, but a
  large file walked node by node can still hit the limit.
- **Sign-in needs a credential store and a web server.** Both are in the default
  web profile. A tools-only composition registers the tools but cannot sign in,
  and says so.
- **The shipped OAuth secret is public.** Anyone who installs the package can
  read it. It grants only the scopes listed above, and a deployment can rotate
  it by supplying its own client in config or the environment.
- **The redirect port must be registered.** Figma matches redirect URLs exactly,
  so a GUI on an unregistered port cannot complete sign-in until that port is
  added to the app or pinned with `callbackPort`.

## Development

```sh
npm test                        # 116 unit + integration tests, no network
node scripts/smoke.mjs          # mount in a real Cordis context; assert registration
node scripts/routes-smoke.mjs   # drive the OAuth routes against a real WebServer
```

`npm test` runs a stub Figma API over a local socket, so the whole tool
surface — auth header, query building, rendering, file writes, token export —
is exercised without a Figma account. The OAuth half is covered by pure-function
tests (including the RFC 7636 PKCE vector), a state-machine suite over an
in-memory credential store, and HTTP tests for the callback and panel routes.

`scripts/smoke.mjs` mounts the plugin next to the harness's real `ToolRuntime`,
`SkillRegistry`, and `SystemPrompt` services and asserts the tools, skills, and
prompt section land. `scripts/routes-smoke.mjs` goes further: it mounts a real
`WebServer` plus a credential provider and then drives the connection API over
HTTP, asserting that the redirect URI uses the live port, that a cross-origin
connect is refused, that a forged callback state fails, and that no secret
crosses the wire.

The plugin has no build step and no runtime dependencies beyond the harness's
own packages. `lib/client.js` is hand-written plain browser JavaScript in the
module-loader's factory form, so no bundler is needed.

## License

MIT. See [LICENSE](LICENSE).
