# dsh-figma

Figma design context for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
English | [中文](README.zh.md)

Hand DSH a Figma link and it can read the design: the node tree with its
auto-layout, sizing, paints and typography, the design tokens the nodes are
bound to, and a rendered screenshot it can actually look at — then write UI
code that matches. Plus four bundled skills that carry the workflow.

Connect a Figma account by signing in through the browser — **no token to copy
and paste** — or keep using a personal access token for headless and CI use.

This is the DSH counterpart to the Figma plugin in Codex. See
[How this compares](#how-this-compares-to-the-codex-figma-plugin) for what is
the same and what is different.

## Install

```sh
dsh plugin --profile web add dsh-figma
```

Then restart `dsh web` (a newly added bundle is composed at boot).

## Connect Figma

Open **Settings → Figma** (the sidebar foot also carries a Figma status button
that opens the same panel). The panel reports the connection state, the
authorized account, and the token's expiry, and offers Connect / Re-authorize /
Disconnect.

Figma requires each integration to bring **its own OAuth app**: the token
endpoint authenticates with the client's secret, and a secret cannot be shipped
inside a plugin. Creating one is a one-time, two-minute step:

1. Open <https://www.figma.com/developers/apps> and **Create a new app**.
   Associate it with any team or organization; leaving it **private** is fine —
   private apps need no Figma review.
2. On its **OAuth credentials** page, add the redirect URL the panel shows you.
   It looks like `http://127.0.0.1:3080/figma/oauth/callback` and must match
   exactly, including the port.
3. On the **OAuth scopes** page select the read scopes the panel lists (file
   content, comments, dev resources, variables, library content). Add
   `file_comments:write` if you want `figma_post_comment`.
4. Paste the app's **Client ID** and **Client Secret** into the panel and press
   Connect. Your browser opens Figma's consent screen, and the panel flips to
   *Connected* when you approve.

The Client ID is stored in the harness settings document; the Client Secret goes
to the credential store (`$DSH_HOME/.credentials.yaml`), never to settings and
never back to the browser. The granted access/refresh token is stored as a
credential *record*, and the access token is refreshed automatically before it
expires.

Ask the agent instead if you prefer:

> Connect to Figma.

The agent calls `figma_login`, which returns the authorization URL for you to
open. The agent never asks you to paste a token into chat.

### Personal access tokens

A PAT still works and is the right choice for headless runs, CI, and scripts —
it has no browser step. Any one of these is used when no OAuth grant is stored:

1. `accessToken` on the plugin's config
2. The harness credential store, under `FIGMA_ACCESS_TOKEN` or `FIGMA_TOKEN`
3. The process environment, under `FIGMA_ACCESS_TOKEN` or `FIGMA_TOKEN`

```sh
export FIGMA_ACCESS_TOKEN=figd_xxx
dsh web
```

Create one at **Figma → Settings → Security → Personal access tokens**
(<https://www.figma.com/developers/api#access-tokens>). Unlike an OAuth grant, a
PAT cannot refresh itself and expires according to Figma's policy.

To set config explicitly, target the row by id in the profile's
`cordis.patch.yml` (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: figma
  config:
    accessToken: !!js process.env.FIGMA_ACCESS_TOKEN
    outputDir: .figma
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
| `figma_whoami` | Verify the current credential and report the authenticated account. |
| `figma_login` | Report the connection, or start OAuth sign-in and return the URL for the human to open. |

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
| `accessToken` | `''` | Explicit personal access token. When empty, the credential store and environment are consulted. |
| `authMode` | `token` | `token` sends `X-Figma-Token`; `oauth` sends `Authorization: Bearer`. An OAuth grant always sends a bearer token regardless of this key. |
| `apiBaseUrl` | `https://api.figma.com` | Override for a proxy. |
| `requestTimeoutMs` | `30000` | Per-request timeout. |
| `maxRetries` | `2` | Retries for 429/5xx, honouring `Retry-After`. |
| `outputDir` | `.dsh-figma` | Where exports are written; relative paths resolve against the session workspace. |
| `maxNodes` | `400` | Default node budget for a design-context projection. |
| `maxDepth` | `8` | Default depth budget. |
| `skills` | `true` | Register the bundled skills. |
| `clientId` | `''` | OAuth app Client ID. Usually written by the connection panel, not here. |
| `clientSecret` | `''` | OAuth app Client Secret. Prefer `clientSecretRef`; the panel stores the secret in the credential store. |
| `clientIdRef` | `FIGMA_CLIENT_ID` | Credential reference consulted for the Client ID when `clientId` is empty. |
| `clientSecretRef` | `FIGMA_CLIENT_SECRET` | Credential reference consulted for the Client Secret when `clientSecret` is empty. |
| `scopes` | see below | Space-separated OAuth scopes requested at authorization. |
| `callbackPort` | `0` | Port advertised in the redirect URL. `0` follows the live GUI port, which is the correct default. |
| `redirectUri` | `''` | Absolute redirect URI override; must match the Figma app exactly. Only loopback URLs are accepted. |
| `callbackPath` | `/figma/oauth/callback` | Callback path appended to the redirect URI. |
| `connectionRoutes` | `true` | Serve the OAuth callback and connection panel. Off means tools-only, with no HTTP surface. |
| `authorizationUrl` / `tokenUrl` / `refreshUrl` | Figma's endpoints | Overridable for a proxy, a test, or Figma for Government. |
| `tools` | all on | Per-tool switches: `whoami`, `file`, `designContext`, `screenshot`, `variables`, `styles`, `components`, `devResources`, `comments`, `postComment`, `login`. |

The default scopes are `current_user:read`, `file_content:read`,
`file_metadata:read`, `file_comments:read`, `file_comments:write`,
`file_dev_resources:read`, `file_variables:read`, `library_content:read`, and
`library_assets:read`.

### Headless and tools-only deployments

A deployment with no web server (or `connectionRoutes: false`) registers the
tools but no HTTP route, so `figma_login` reports the connection and tells the
human to configure a PAT. Credentials resolve per call, so a token rotated
outside the process reaches the next tool call with no restart.

## Security notes

- The OAuth callback is an ordinary HTTP route, deliberately **not** behind the
  harness's cross-origin API fence: Figma returns the browser with a top-level
  cross-site navigation, which that fence rejects. `state` is therefore the
  authentication — 32 random bytes generated in-process, compared in constant
  time, and required to match a pending attempt.
- Every state-changing panel route is same-origin POST only. A request with no
  `Origin` is refused rather than trusted.
- The browser never receives the access token, the refresh token, or the Client
  Secret. The status payload carries presence and expiry only, and is asserted
  against secret leakage in the test suite.
- The redirect URI must be a loopback http(s) URL, so a one-time code cannot be
  sent to a host this process does not own.
- Figma expires authorization codes after 30 seconds, so the exchange happens
  inside the callback request itself, before anything else is awaited.

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
| Design reads | Figma MCP server (OAuth) | Figma REST API (OAuth, PAT fallback) |
| Sign-in | browser authorization, hosted by Figma | browser authorization, hosted by Figma |
| OAuth client | Figma's own, shipped in the connector | each user registers one (Figma requires the secret at exchange) |
| Credential storage | connector-managed | harness credential store (`records`), auto-refreshed |
| Requires Figma desktop running | No (hosted MCP) | No |
| Skills | 7 bundled, Figma-authored | 4 bundled, written for these tools |
| Design tokens | via MCP `get_variable_defs` | `figma_get_variables` (modes + alias resolution + CSS/JSON export) |
| Code Connect | MCP + Figma CLI | skill guides template generation; publish with the Figma CLI |
| Write back to canvas | Yes (MCP + Plugin API) | **No** — see below |
| Setup | install plugin, authorize Figma | install plugin, register one OAuth app, click Connect |

### Why you register your own OAuth app

Figma's token endpoint authenticates the client with HTTP Basic
(`client_id:client_secret`); PKCE is supported but does not replace the secret.
A shipped secret would be readable by everyone who installs the plugin, so each
user registers their own app once. Figma also restricts hosted-MCP dynamic
client registration to clients in its MCP Catalog, so a third-party plugin
cannot mint a shared client.

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
- **OAuth needs a credential store and a web server.** Both are in the default
  web profile. A tools-only composition without them still works with a PAT.

## Development

```sh
npm test                        # 97 unit + integration tests, no network
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
