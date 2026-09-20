import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FigmaRefError, figmaUrl, normalizeNodeId, normalizeNodeIds, parseFigmaRef } from '../lib/figma-url.js';

test('parses a modern design URL with a node id', () => {
  const ref = parseFigmaRef('https://www.figma.com/design/AbC123XyZ/Home-Screen?node-id=12-345&t=abc');
  assert.equal(ref.fileKey, 'AbC123XyZ');
  assert.equal(ref.nodeId, '12:345');
  assert.equal(ref.kind, 'design');
});

test('parses legacy file, proto, board and slides URLs', () => {
  assert.deepEqual(
    (({ fileKey, kind }) => ({ fileKey, kind }))(parseFigmaRef('https://www.figma.com/file/AbC123XyZ/Legacy')),
    { fileKey: 'AbC123XyZ', kind: 'design' },
  );
  assert.equal(parseFigmaRef('https://www.figma.com/proto/AbC123XyZ/P').kind, 'proto');
  assert.equal(parseFigmaRef('https://www.figma.com/board/AbC123XyZ/B').kind, 'figjam');
  assert.equal(parseFigmaRef('https://www.figma.com/slides/AbC123XyZ/S').kind, 'slides');
  assert.equal(parseFigmaRef('https://www.figma.com/deck/AbC123XyZ/S').kind, 'slides');
});

test('parses community file URLs', () => {
  const ref = parseFigmaRef('https://www.figma.com/community/file/1234567890123456789');
  assert.equal(ref.fileKey, '1234567890123456789');
});

test('accepts a scheme-less figma.com host', () => {
  const ref = parseFigmaRef('www.figma.com/design/AbC123XyZ/Home');
  assert.equal(ref.fileKey, 'AbC123XyZ');
});

test('parses bare keys and combined references', () => {
  assert.equal(parseFigmaRef('AbC123XyZ').fileKey, 'AbC123XyZ');
  assert.equal(parseFigmaRef('AbC123XyZ').nodeId, null);
  assert.equal(parseFigmaRef('AbC123XyZ:12-345').nodeId, '12:345');
  assert.equal(parseFigmaRef('AbC123XyZ/12-345').nodeId, '12:345');
  assert.equal(parseFigmaRef('AbC123XyZ?node-id=12-345').nodeId, '12:345');
});

test('an explicit node id overrides the one in the URL', () => {
  const ref = parseFigmaRef('https://www.figma.com/design/AbC123XyZ/Home?node-id=1-1', { nodeId: '9-9' });
  assert.equal(ref.nodeId, '9:9');
});

test('normalizes instance and nested node ids', () => {
  assert.equal(normalizeNodeId('I12-345'), 'I12:345');
  assert.equal(normalizeNodeId('I1-2;3-4'), 'I1:2;3:4');
  assert.equal(normalizeNodeId(' 1:2 '), '1:2');
});

test('normalizeNodeIds splits, normalizes, and de-duplicates', () => {
  assert.deepEqual(normalizeNodeIds('1-2, 3:4 1-2'), ['1:2', '3:4']);
  assert.deepEqual(normalizeNodeIds(['5-6', '7-8']), ['5:6', '7:8']);
  assert.deepEqual(normalizeNodeIds(''), []);
});

test('rejects inputs that are not Figma references', () => {
  assert.throws(() => parseFigmaRef(''), FigmaRefError);
  assert.throws(() => parseFigmaRef('https://example.com/design/AbC123XyZ'), FigmaRefError);
  assert.throws(() => parseFigmaRef('https://www.figma.com/design/'), FigmaRefError);
  assert.throws(() => parseFigmaRef('https://www.figma.com/settings'), FigmaRefError);
  assert.throws(() => parseFigmaRef('ab'), FigmaRefError);
  assert.throws(() => normalizeNodeId('not-a-node'), FigmaRefError);
});

test('builds a browser URL back from a reference', () => {
  assert.equal(figmaUrl('AbC123XyZ'), 'https://www.figma.com/design/AbC123XyZ/');
  assert.equal(figmaUrl('AbC123XyZ', '12:345'), 'https://www.figma.com/design/AbC123XyZ/?node-id=12-345');
  assert.equal(figmaUrl('AbC123XyZ', '1:2', 'figjam'), 'https://www.figma.com/board/AbC123XyZ/?node-id=1-2');
});
