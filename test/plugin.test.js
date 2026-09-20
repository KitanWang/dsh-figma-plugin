import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { Config, apply } from '../lib/index.js';

/** A 1×1 opaque PNG, used to prove the render path saves real bytes. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const FILE_KEY = 'AbC123XyZ';

const NODE_DOCUMENT = {
  id: '1:2',
  name: 'Home',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
  layoutMode: 'VERTICAL',
  itemSpacing: 24,
  paddingTop: 64,
  paddingRight: 64,
  paddingBottom: 64,
  paddingLeft: 64,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:4' } },
  children: [
    {
      id: '1:3',
      name: 'Title',
      type: 'TEXT',
      absoluteBoundingBox: { x: 64, y: 64, width: 400, height: 40 },
      characters: 'Welcome back',
      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 32, lineHeightPx: 40 },
    },
  ],
};

/** Requests the stub saw, so auth and query construction can be asserted. */
const seen = [];

/** Start a stub Figma API on an ephemeral port. */
function startStub() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        token: request.headers['x-figma-token'],
        body: chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });

      const json = (payload) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const path = url.pathname;

      if (path === '/v1/me') {
        // Two special tokens model the real scope failures: a valid token that
        // lacks current_user:read, and a revoked one.
        const token = request.headers['x-figma-token'];
        if (token === 'scoped-token') {
          response.writeHead(403, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: true,
              status: 403,
              message:
                'Invalid scope: ["file_comments:read"]. This endpoint requires the file_read or files:read or current_user:read scope.',
            }),
          );
          return;
        }
        if (token === 'bad-token') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ status: 401, err: 'Invalid token' }));
          return;
        }
        json({ id: '42', handle: 'kitan', email: 'kitan@example.com' });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/nodes`) {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
        const nodes = {};
        for (const id of ids) {
          if (id === '1:2') nodes[id] = { document: NODE_DOCUMENT, name: 'Home' };
          else if (id === '3:1') nodes[id] = { document: { id, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] } };
          else if (id === '3:2') nodes[id] = { document: { id, style: { fontFamily: 'Inter', fontSize: 16 } } };
          else if (id === '9:1') nodes[id] = { document: { id, componentPropertyDefinitions: { Variant: { type: 'VARIANT', variantOptions: ['Primary', 'Secondary'] } } } };
          else nodes[id] = { document: { id, type: 'FRAME', name: id } };
        }
        json({ nodes });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/variables/local`) {
        json({
          meta: {
            variableCollections: {
              'VariableCollectionId:1:1': {
                id: 'VariableCollectionId:1:1',
                name: 'Theme',
                defaultModeId: '1:0',
                modes: [{ modeId: '1:0', name: 'Light' }],
              },
            },
            variables: {
              'VariableID:1:4': {
                id: 'VariableID:1:4',
                name: 'space/200',
                variableCollectionId: 'VariableCollectionId:1:1',
                resolvedType: 'FLOAT',
                valuesByMode: { '1:0': 8 },
              },
              'VariableID:1:9': {
                id: 'VariableID:1:9',
                name: 'unused/token',
                variableCollectionId: 'VariableCollectionId:1:1',
                resolvedType: 'FLOAT',
                valuesByMode: { '1:0': 999 },
              },
            },
          },
        });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/styles`) {
        json({
          meta: {
            styles: [
              { key: 'k1', name: 'color/bg', style_type: 'FILL', node_id: '3:1' },
              { key: 'k2', name: 'text/body', style_type: 'TEXT', node_id: '3:2' },
            ],
          },
        });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/components`) {
        json({
          meta: {
            components: [
              { key: 'ck1', name: 'Button', node_id: '7:1', description: 'Primary button' },
            ],
          },
        });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/component_sets`) {
        json({ meta: { component_sets: [{ key: 'sk1', name: 'Button', node_id: '9:1' }] } });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/dev_resources`) {
        json({ dev_resources: [{ id: 'd1', name: 'Docs', url: 'https://example.com/docs', node_id: '1:2' }] });
        return;
      }
      if (path === `/v1/files/${FILE_KEY}/comments`) {
        if (request.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          json({ id: 'c-new', message: body.message, client_meta: body.client_meta });
          return;
        }
        json({ comments: [{ id: 'c1', message: 'Needs more padding', user: { handle: 'designer' }, client_meta: { node_id: '1:2' } }] });
        return;
      }
      if (path === `/v1/images/${FILE_KEY}`) {
        json({ images: { '1:2': `http://127.0.0.1:${server.address().port}/render/1-2.png` } });
        return;
      }
      if (path.startsWith('/render/')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(ONE_PIXEL_PNG);
        return;
      }
      if (path === `/v1/files/${FILE_KEY}`) {
        json({
          name: 'Design File',
          lastModified: '2026-01-01T00:00:00Z',
          version: '1',
          editorType: 'figma',
          document: {
            id: '0:0',
            name: 'Document',
            type: 'DOCUMENT',
            children: [
              {
                id: '0:1',
                name: 'Screens',
                type: 'CANVAS',
                children: [{ id: '1:2', name: 'Home', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } }],
              },
            ],
          },
        });
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ err: 'not found' }));
    });
  });
  return server;
}

/** A minimal stand-in for the cordis plugin context. */
function createStubContext() {
  const registered = new Map();
  const sections = [];
  const skills = [];
  const warnings = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      get(name) {
        return registered.get(name);
      },
    },
    get(name) {
      if (name === 'skills') return { register: (skill) => (skills.push(skill), () => {}) };
      if (name === 'systemPrompt') return { section: (section) => (sections.push(section), () => {}) };
      return undefined;
    },
    logger: { warn: (message) => warnings.push(message) },
  };
  return { ctx, registered, sections, skills, warnings };
}

let server;
let baseUrl;
let workspace;
let stub;

before(async () => {
  server = startStub();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  workspace = await mkdtemp(join(tmpdir(), 'dsh-figma-test-'));
  stub = createStubContext();
  apply(stub.ctx, Config({ accessToken: 'test-token', apiBaseUrl: baseUrl, outputDir: 'exports' }));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
});

/** Tool execution context for a call rooted in the temporary workspace. */
function exec() {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd: workspace } } } };
}

const DESIGN_URL = `https://www.figma.com/design/${FILE_KEY}/Home?node-id=1-2`;

test('registers every tool and the bundled skills', () => {
  const names = [...stub.registered.keys()].sort();
  assert.deepEqual(names, [
    'figma_get_comments',
    'figma_get_components',
    'figma_get_design_context',
    'figma_get_dev_resources',
    'figma_get_file',
    'figma_get_screenshot',
    'figma_get_styles',
    'figma_get_variables',
    'figma_post_comment',
    'figma_whoami',
  ]);
  assert.equal(stub.skills.length, 4);
  assert.equal(stub.sections.length, 1);
  assert.equal(stub.sections[0].name, 'tool:figma');
  assert.deepEqual(stub.warnings, []);
});

test('honours per-tool registration switches', () => {
  const limited = createStubContext();
  apply(limited.ctx, Config({ accessToken: 't', apiBaseUrl: baseUrl, skills: false, tools: { postComment: false, comments: false } }));
  assert.equal(limited.registered.has('figma_post_comment'), false);
  assert.equal(limited.registered.has('figma_get_comments'), false);
  assert.equal(limited.registered.has('figma_get_design_context'), true);
  assert.equal(limited.skills.length, 0);
});

test('figma_whoami authenticates with the personal access token header', async () => {
  const result = await stub.registered.get('figma_whoami').execute({}, exec());
  assert.equal(result.handle, 'kitan');
  assert.equal(result.email, 'kitan@example.com');
  assert.equal(result.tokenSource, 'plugin config');
  const request = seen.find((entry) => entry.path === '/v1/me');
  assert.equal(request.token, 'test-token');
});

test('figma_whoami reports a valid token that lacks current_user:read', async () => {
  const scoped = createStubContext();
  apply(scoped.ctx, Config({ accessToken: 'scoped-token', apiBaseUrl: baseUrl }));
  const result = await scoped.registered.get('figma_whoami').execute({}, exec());
  assert.equal(result.verified, true);
  assert.equal(result.handle, undefined);
  assert.equal(result.tokenSource, 'plugin config');
  assert.match(result.note, /current_user:read/);

  // The rendered text must not claim an identity it could not read.
  const blocks = scoped.registered.get('figma_whoami').output.render({}, result);
  assert.match(blocks[0].text, /authenticates, but the account could not be read/);
  assert.doesNotMatch(blocks[0].text, /undefined/);
});

test('figma_whoami rejects a revoked token', async () => {
  const bad = createStubContext();
  apply(bad.ctx, Config({ accessToken: 'bad-token', apiBaseUrl: baseUrl }));
  await assert.rejects(
    () => bad.registered.get('figma_whoami').execute({}, exec()),
    /invalid or has been revoked/,
  );
});

test('figma_get_design_context returns an outline, bound variables, and a screenshot on disk', async () => {
  const definition = stub.registered.get('figma_get_design_context');
  const result = await definition.execute({ url: DESIGN_URL }, exec());

  assert.equal(result.fileKey, FILE_KEY);
  assert.equal(result.nodeId, '1:2');
  assert.match(result.outline, /^FRAME "Home" #1:2 1440×900 column gap=24 pad=64,64,64,64/m);
  assert.match(result.outline, /TEXT "Title" #1:3 .*"Welcome back"/);
  assert.equal(result.nodeCount, 2);
  assert.equal(result.truncated, false);

  // Only the variable the tree actually binds is resolved, not every variable.
  assert.equal(result.variables.length, 1);
  assert.equal(result.variables[0].name, 'space/200');
  assert.equal(result.variables[0].values.Light, 8);

  assert.equal(result.screenshot, null);
  assert.ok(result.notes.some((note) => /no attachment store/.test(note)));

  const saved = await readFile(result.screenshotPath);
  assert.deepEqual(saved, ONE_PIXEL_PNG);
  assert.equal(result.screenshotPath, join(workspace, 'exports', '1-2-home.png'));
});

test('the rendered content is what the model would receive', async () => {
  const definition = stub.registered.get('figma_get_design_context');
  const result = await definition.execute({ url: DESIGN_URL, includeScreenshot: false }, exec());
  const blocks = definition.output.render({}, result);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Figma design context — Home, node 1:2/);
  assert.equal(result.screenshotPath, undefined);
});

test('figma_get_file lists pages and frames', async () => {
  const result = await stub.registered.get('figma_get_file').execute({ fileKey: FILE_KEY }, exec());
  assert.equal(result.name, 'Design File');
  assert.match(result.outline, /CANVAS "Screens"/);
  assert.match(result.outline, /FRAME "Home"/);
  const request = seen.filter((entry) => entry.path === `/v1/files/${FILE_KEY}`).at(-1);
  assert.equal(request.query.depth, '2');
});

test('figma_get_screenshot renders, saves, and reports pixel size', async () => {
  const result = await stub.registered.get('figma_get_screenshot').execute({ url: DESIGN_URL, scale: 3 }, exec());
  assert.equal(result.format, 'png');
  assert.equal(result.scale, 3);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].width, 1);
  assert.equal(result.images[0].height, 1);
  const saved = await readFile(result.images[0].filePath);
  assert.deepEqual(saved, ONE_PIXEL_PNG);
  const request = seen.filter((entry) => entry.path === `/v1/images/${FILE_KEY}`).at(-1);
  assert.deepEqual(request.query, { ids: '1:2', format: 'png', scale: '3' });
});

test('figma_get_screenshot requires a node id', async () => {
  await assert.rejects(
    () => stub.registered.get('figma_get_screenshot').execute({ fileKey: FILE_KEY }, exec()),
    /at least one node id is required/,
  );
});

test('figma_get_variables writes CSS and JSON artifacts', async () => {
  const target = join(workspace, 'tokens');
  const result = await stub.registered.get('figma_get_variables').execute(
    { fileKey: FILE_KEY, writeTo: target, format: 'both' },
    exec(),
  );
  assert.equal(result.tokenCount, 2);
  assert.match(result.writtenPath, /tokens\.tokens\.json, .*tokens\.tokens\.css/);

  const json = JSON.parse(await readFile(join(workspace, 'tokens.tokens.json'), 'utf8'));
  assert.equal(json.tokens['Theme/space/200'].$value.Light, 8);
  const css = await readFile(join(workspace, 'tokens.tokens.css'), 'utf8');
  assert.match(css, /--theme-space-200: 8;/);
});

test('figma_get_styles resolves style values through the node endpoint', async () => {
  const result = await stub.registered.get('figma_get_styles').execute({ fileKey: FILE_KEY }, exec());
  assert.equal(result.styleCount, 2);
  assert.equal(result.styles[0].value.color, '#000000');
  assert.equal(result.styles[1].value.fontFamily, 'Inter');
  assert.deepEqual(result.notes, []);
});

test('figma_get_components returns components and set variant properties', async () => {
  const result = await stub.registered.get('figma_get_components').execute({ fileKey: FILE_KEY }, exec());
  assert.equal(result.componentCount, 1);
  assert.equal(result.componentSets[0].name, 'Button');
  assert.deepEqual(result.componentSets[0].variantProperties, { Variant: ['Primary', 'Secondary'] });
  assert.match(result.components[0].nodeUrl, /node-id=7-1/);
});

test('figma_get_dev_resources lists attached resources', async () => {
  const result = await stub.registered.get('figma_get_dev_resources').execute({ fileKey: FILE_KEY, nodeIds: '1-2' }, exec());
  assert.equal(result.resourceCount, 1);
  const request = seen.filter((entry) => entry.path === `/v1/files/${FILE_KEY}/dev_resources`).at(-1);
  assert.equal(request.query.node_ids, '1:2');
});

test('figma_get_comments and figma_post_comment round-trip', async () => {
  const comments = await stub.registered.get('figma_get_comments').execute({ fileKey: FILE_KEY }, exec());
  assert.equal(comments.commentCount, 1);
  assert.match(comments.comments[0].message, /padding/);

  const posted = await stub.registered.get('figma_post_comment').execute(
    { url: DESIGN_URL, message: 'Padding should be 24.' },
    exec(),
  );
  assert.equal(posted.id, 'c-new');
  assert.equal(posted.nodeId, '1:2');
  const request = seen.filter((entry) => entry.method === 'POST').at(-1);
  assert.deepEqual(request.body.client_meta.node_id, '1:2');
  assert.equal(request.body.message, 'Padding should be 24.');
});

test('figma_post_comment rejects an empty message', async () => {
  await assert.rejects(
    () => stub.registered.get('figma_post_comment').execute({ fileKey: FILE_KEY, message: '   ' }, exec()),
    /non-empty string/,
  );
});

test('a bad reference fails with a clear message before any request', async () => {
  const before = seen.length;
  await assert.rejects(
    () => stub.registered.get('figma_get_design_context').execute({ url: 'https://example.com/nope' }, exec()),
    /not a figma\.com host/,
  );
  assert.equal(seen.length, before);
});

test('a Figma API error surfaces the status and message', async () => {
  await assert.rejects(
    () => stub.registered.get('figma_get_design_context').execute({ fileKey: 'MissingKey1' }, exec()),
    /Figma API 404/,
  );
});

test('the missing-token message names every way to configure one', async () => {
  const bare = createStubContext();
  apply(bare.ctx, Config({ apiBaseUrl: baseUrl }));
  const previous = { a: process.env.FIGMA_ACCESS_TOKEN, b: process.env.FIGMA_TOKEN };
  delete process.env.FIGMA_ACCESS_TOKEN;
  delete process.env.FIGMA_TOKEN;
  try {
    await assert.rejects(
      () => bare.registered.get('figma_whoami').execute({}, exec()),
      /FIGMA_ACCESS_TOKEN/,
    );
  } finally {
    if (previous.a !== undefined) process.env.FIGMA_ACCESS_TOKEN = previous.a;
    if (previous.b !== undefined) process.env.FIGMA_TOKEN = previous.b;
  }
});

test('exports land in the session workspace by default', async () => {
  const other = createStubContext();
  apply(other.ctx, Config({ accessToken: 't', apiBaseUrl: baseUrl }));
  const result = await other.registered.get('figma_get_screenshot').execute({ url: DESIGN_URL }, exec());
  assert.equal(result.images[0].filePath, join(workspace, '.dsh-figma', '1-2.png'));
  await stat(result.images[0].filePath);
});
