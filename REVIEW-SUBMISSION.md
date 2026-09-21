# Figma OAuth app — review submission material

Figma requires a review before an OAuth app can act on behalf of users outside
the team it belongs to. This file holds the answers that submission asks for, so
they can be pasted in without re-deriving them.

The app itself is registered at <https://www.figma.com/developers/apps> and its
credentials live in [`lib/oauth-app.js`](lib/oauth-app.js).

---

## General

**App name**

```
DeepSeek Harness — Figma
```

**Logo**

[`assets/icon-512.png`](assets/icon-512.png) — 512×512 PNG.

It is an original mark (a selection frame holding stacked layers), generated
from [`scripts/generate-icon.py`](scripts/generate-icon.py). It deliberately
does **not** reuse Figma's logo or any other trademark.

**Category**

Developer tools.

---

## OAuth credentials

**Redirect URLs** (Figma matches these exactly, including the port):

```
http://127.0.0.1:3080/figma/oauth/callback
http://localhost:3080/figma/oauth/callback
```

These are loopback URLs. The GUI this plugin signs in runs on the user's own
machine, and the plugin serves the callback on that same server — it never asks
Figma to redirect anywhere it does not control. `3080` is the harness web GUI's
default port. A user who launches the GUI with `--port` gets a different
callback URL and must register that port on their own app copy; the plugin shows
the exact URL to register, which is why the default is what ships.

---

## OAuth scopes

Requested at authorization, and why each is needed:

| Scope | Why the integration needs it |
| --- | --- |
| `current_user:read` | Show which Figma account is connected, so a user can tell they authorized the right account. |
| `file_content:read` | Read a file's node tree — layout, sizing, fills, typography — which is the core feature: turning a design into code. |
| `file_metadata:read` | Read a file's name and structure to build the sheet outline a user picks a frame from. |
| `file_comments:read` | Read existing review comments so the agent can see design feedback in context. |
| `file_comments:write` | Post a design-review comment back to the file, only when the user explicitly asks. This is the single write scope. |
| `file_dev_resources:read` | Read dev resources (linked tickets, docs, code) attached to nodes. |
| `library_content:read` | Read published library components and styles so generated code reuses the real design system. |
| `library_assets:read` | Read individual published component and style data for the same reason. |

`file_variables:read` is **not** requested: Figma marks it Enterprise-only, and
requesting a scope the app cannot enable on a given plan fails the entire
authorization. Enterprise users can opt in through the plugin's `scopes`
configuration.

No scope is used to modify a user's files except `file_comments:write`, which
only creates a comment the user explicitly asked for.

---

## Describe your app

**Short description**

```
Read a Figma design in your coding agent: frames, components, variables, and a rendered screenshot, so the code it writes matches the design.
```

**Long description** (for the review form and the Community page)

```
DeepSeek Harness — Figma connects a Figma account to the DeepSeek Harness
coding agent. Hand the agent a Figma link and it can read the design and write
UI code that matches it.

What it reads:
- A frame's node tree: auto-layout, sizing, spacing, paints, and typography.
- The design tokens a node is bound to (Figma variables), resolving aliases and
  per-mode values.
- Published styles and components, so generated code reuses the real design
  system instead of inventing values.
- A rendered screenshot of the frame, which the agent compares its output
  against.

It also bundles four workflow skills (design-to-code, design-system inventory,
Code Connect templates, and design review) that carry the sequence.

Connecting takes one button. The plugin carries its own OAuth app, so a user
never registers an application, creates a token, or pastes a secret. The plugin
stores the granted tokens in the local harness credential store and refreshes
them automatically. Nothing about credentials is ever displayed in the browser.

What it does not do:
- It does not modify designs, except posting a comment when the user explicitly
  asks for one. There is no write-back to the canvas.
- It does not send design data anywhere except Figma's own REST API and the
  user's own configured model provider.
- It does not run a remote service. All processing is local to the user's
  machine.
```

---

## Testing instructions

For a reviewer verifying the integration:

1. **Install.** Requires Node.js 20+ and DeepSeek Harness (`dsh`). Install from
   the public GitHub repository — the npm name `dsh-figma` belongs to an
   unrelated reserved package, so the GitHub form is the one that installs this
   integration:

   ```sh
   dsh plugin --profile web add github:KitanWang/dsh-figma
   ```

   Then start the GUI: `dsh web` (serves on `http://127.0.0.1:3080`).

2. **Open the connection page.** In the GUI, open **Settings → Figma**.

3. **Sign in.** Press **Connect Figma**. A browser tab opens Figma's own
   sign-in and consent page. Sign in with any Figma account and approve the
   requested scopes. The tab lands on a local confirmation page, and the
   Settings page flips to *Connected*, showing the authorized account.

   > The consent screen must be opened in a real browser — Figma rejects
   > embedded webviews.

4. **Verify the read path.** In the GUI chat, paste any Figma design link, for
   example:

   ```
   Read this design and list the frames:
   https://www.figma.com/design/<file-key>/<name>?node-id=<node-id>
   ```

   The agent calls `figma_get_design_context` and returns the node tree, the
   bound variables, and a rendered screenshot of the frame.

5. **Verify refresh persists.** Restart `dsh web`, reopen **Settings → Figma**.
   The page still reports *Connected* from the stored grant.

6. **Verify disconnect/reconnect.** Press **Reconnect** and approve again; the
   stored grant is replaced.

**Note on `file_variables:read`.** This scope is Enterprise-only and is not
requested by default, because requesting a scope the app cannot enable fails the
whole authorization. On a non-Enterprise account, `figma_get_variables` reports
a plan limitation while every other tool works. On Enterprise, enable the scope
on the app and add it via the plugin's `scopes` config to exercise that tool.

**No credentials to prepare.** The reviewer needs only a Figma account; there is
no test token, no sandbox file, and no trial signup.

---

## Data handling

- **What is stored:** the OAuth access and refresh tokens, as one credential
  record (`figma/oauth`) in the harness credential store on the user's machine
  (`$DSH_HOME/.credentials.yaml`, file mode 0600).
- **What is sent to Figma:** read requests to `api.figma.com`, authorized with
  the user's own access token. No separate analytics or telemetry endpoint.
- **What is sent anywhere else:** nothing. The plugin has no backend service.
  Rendered screenshots are written to local disk under the session workspace.
- **Retention:** tokens persist until the user reconnects or removes the record.
  Exports persist on local disk until the user deletes them.

## On the shipped client secret

Figma's token endpoint authenticates the client with HTTP Basic
(`client_id:client_secret`) and supports no secret-less public-client mode, so
an integration that a user installs cannot hide its secret. The secret therefore
ships in the package and is public by construction. Mitigations, all of which
are deliberate:

- The app requests only the read scopes listed above, plus the single
  `file_comments:write` the review feature needs.
- The secret can be rotated at any time from the Figma app page; deployments can
  override it without editing the package, through `FIGMA_CLIENT_ID` /
  `FIGMA_CLIENT_SECRET` or plugin config.
- Authorization uses PKCE (S256) in addition to the secret, and the callback is
  a loopback URL, so an intercepted code is not usable by a third party that
  cannot reach the user's own machine.
