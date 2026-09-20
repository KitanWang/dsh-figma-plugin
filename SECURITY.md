# Security policy

## Reporting a vulnerability

Open a private report through GitHub's
[Security Advisories](https://github.com/KitanWang/dsh-figma-plugin/security/advisories/new)
rather than a public issue. If you cannot use that, open a minimal issue asking
for a private channel and include no details.

Please include the version, what you did, and what happened. A proof of concept
helps but is not required.

## What this plugin handles

It is worth being precise about the trust surface, because this plugin asks a
user to authorize access to their Figma account.

**It stores one credential record.** The OAuth access and refresh tokens live as
a single record (`figma/oauth`) in the harness credential store, on the user's
own machine (`$DSH_HOME/.credentials.yaml`, file mode 0600). It reads no other
credential.

**It ships a public OAuth client secret.** Figma's token endpoint authenticates
with `client_id:client_secret` over HTTP Basic and has no secret-less
public-client mode, so a plugin that must not ask the user for credentials has
to ship one. **The secret in [`lib/oauth-app.js`](lib/oauth-app.js) is public by
construction** and is not a vulnerability on its own. It is reported here so
nobody wastes time reporting it, and so forks know to supply their own.

What limits the exposure: the app requests only the read scopes listed in
[REVIEW-SUBMISSION.md](REVIEW-SUBMISSION.md), plus `file_comments:write` for the
opt-in review feature; authorization uses PKCE (S256); and the callback is a
loopback URL. A third party holding the secret still cannot receive a user's
authorization code, because the redirect goes to the user's own machine.

A deployment that would rather not carry the secret can override it without
editing the package, through `FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET` or the
plugin's `clientId` / `clientSecret` config. Rotating a leaked secret is done on
the Figma app page, then by setting those values.

## What would be a vulnerability

Genuine issues worth reporting:

- A way to read a token, the client secret, or another user's design data from
  the plugin's HTTP routes or the browser bundle.
- A way to complete an authorization with a forged or replayed `state`, or to
  make the callback exchange an attacker-supplied code.
- A way to make the plugin send design data, tokens, or credentials anywhere
  other than Figma's own API and the user's configured model provider.
- A path traversal or arbitrary write through the export/`outputDir` handling.
- A request-forgery path into the state-changing routes (they are intended to be
  same-origin POST only).

## Automated checks in this repository

- The browser bundle is asserted to require only modules the shell's platform
  table provides, so it cannot pull in unexpected code.
- The status payload is asserted to contain no token, secret, or expiry, in the
  unit suite and again in the HTTP smoke test.
- The OAuth callback is asserted to reject a forged `state`; the mutating routes
  are asserted to reject cross-origin and origin-less requests.
- CI runs the suite on Node 20, 22, and 24.
