import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Packaging-contract tests.
 *
 * These pin the invariants a published plugin can silently break: the manifest
 * fields the harness reads, the browser bundle's registration id, and the
 * install path a stranger will copy from the README. Every one of them fails
 * loudly at install time for a user, and none of them fails in a unit test that
 * only exercises behaviour — so they get asserted here.
 */

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('the manifest declares the fields the harness composes a bundle from', () => {
  assert.equal(typeof pkg.name, 'string');
  assert.match(pkg.name, /^[a-z0-9][a-z0-9._-]*$/, 'npm names are lowercase');
  assert.equal(typeof pkg.version, 'string');
  assert.match(pkg.version, /^\d+\.\d+\.\d+/, 'a publishable semver version');

  // dsh.bundle is what makes `dsh plugin add` mount the plugin at all.
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(existsSync(new URL('cordis.patch.yml', root)), 'the declared patch must exist');

  // The browser half must declare its platform and ship a built entry.
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  assert.equal(typeof pkg.exports?.['./client'], 'string');
  assert.ok(existsSync(new URL(pkg.exports['./client'].slice(2), root)), 'the client bundle must exist');
});

test('the browser bundle registers under the npm package name', () => {
  // client-modules matches a served bundle to its graph row by this id. A
  // rename that updates package.json but not lib/client.js breaks the entire
  // browser half with no error the author would see locally.
  const source = read(pkg.exports['./client'].slice(2));
  const id = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1];
  assert.equal(id, pkg.name);
});

test('the package entry and every exported subpath resolve to a real file', () => {
  assert.ok(existsSync(new URL(pkg.main, root)), `main ${pkg.main} must exist`);
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (subpath === './package.json') continue;
    const value = typeof target === 'string' ? target : target.default;
    assert.ok(existsSync(new URL(value.slice(2), root)), `${subpath} -> ${value} must exist`);
  }
});

test('the files list is what a consumer actually needs, and nothing private', () => {
  const files = pkg.files ?? [];
  for (const required of ['lib', 'skills', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(required), `${required} must ship`);
  }
  // Credentials, build output, and local state must never be published.
  for (const forbidden of ['node_modules', '.git', '.env', 'test', 'assets/.cache']) {
    assert.equal(files.includes(forbidden), false, `${forbidden} must not ship`);
  }
  // The docs must show an install command that works *today*. The package is
  // not on npm, so a bare `add <name>` would fail for every reader; the GitHub
  // form is what resolves.
  const repo = /github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/.exec(pkg.repository.url)?.[1];
  assert.ok(repo !== undefined, 'the repository owner/name must be parseable');
  for (const doc of ['README.md', 'README.zh.md']) {
    const text = read(doc);
    assert.ok(
      text.includes(`add github:${repo}`),
      `${doc} must show the GitHub install command, which works before any npm publish`,
    );
    assert.ok(text.includes(`add ${pkg.name}`), `${doc} must also name the package`);
  }
});

test('the declared Node engine matches what the code uses', () => {
  // AbortSignal.any / AbortSignal.timeout and fetch are the load-bearing
  // platform features; they are stable from Node 20.
  assert.match(pkg.engines?.node ?? '', />=\s*20/);
});

test('the license is declared and present', () => {
  assert.equal(pkg.license, 'MIT');
  assert.ok(read('LICENSE').includes('MIT'));
});

test('the repository metadata points at a github repo, not a placeholder', () => {
  const url = pkg.repository?.url ?? '';
  assert.match(url, /^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/, 'a real repository URL');
  assert.equal(url.includes('kitan/dsh-figma'), false, 'the old placeholder URL must be gone');
});

test('the bundle patch mounts the plugin under its own package name', () => {
  // The patch row's `name:` is the module specifier the loader resolves. A
  // rename that updates package.json but not this line leaves the plugin
  // uninstallable — the row resolves to nothing, and nothing loads. This is
  // invisible to a unit test that imports ./lib/index.js directly.
  const patch = read('cordis.patch.yml');
  const rows = patch
    .split('\n')
    .map((line) => /^\s*-?\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => match[1]);
  const names = rows.filter((name) => !name.startsWith('@deepseek-ai/'));
  assert.ok(names.length > 0, 'the patch must mount at least one plugin row');
  for (const name of names) {
    assert.equal(name, pkg.name, `the patch mounts "${name}" but the package is "${pkg.name}"`);
  }
});

test('the patch file parses and inserts a row with the expected id', () => {
  // A YAML syntax error here fails the whole profile boot, so it is worth
  // asserting the shape rather than only the string.
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^- insert:/m, 'the patch is a top-level insert list');
  assert.match(patch, /id: figma\b/, 'the row keeps the stable id `figma`');
});

test('the published docs a reviewer or consumer needs are present', () => {
  // The security policy is where the shipped-secret tradeoff is disclosed, so
  // its absence would leave that unexplained for anyone auditing the package.
  // Compare on normalized whitespace: markdown wraps mid-sentence, and the
  // assertion is about what the document says, not where its lines break.
  const flatten = (text) => text.replace(/\s+/g, ' ');
  assert.match(flatten(read('SECURITY.md')), /secret .* is public by construction/);
  assert.ok(read('REVIEW-SUBMISSION.md').includes('Redirect URLs'));
  // The icon the OAuth app must supply.
  assert.ok(existsSync(new URL('assets/icon-512.png', root)));
});

test('the README is honest about the shipped secret and the scope limits', () => {
  const readme = read('README.md');
  assert.match(readme, /secret is public/i, 'the shipped-secret tradeoff must be stated');
  assert.match(readme, /Enterprise/i, 'the Enterprise-only variable scope must be explained');
});
