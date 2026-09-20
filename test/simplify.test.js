import assert from 'node:assert/strict';
import { test } from 'node:test';

import { colorToHex, describeNode, projectNodeShallow, renderOutline, simplifyNodeTree } from '../lib/simplify.js';

test('colorToHex converts Figma RGBA floats, including alpha', () => {
  assert.equal(colorToHex({ r: 0, g: 0, b: 0, a: 1 }), '#000000');
  assert.equal(colorToHex({ r: 1, g: 1, b: 1, a: 1 }), '#FFFFFF');
  assert.equal(colorToHex({ r: 1, g: 0, b: 0 }), '#FF0000');
  assert.equal(colorToHex({ r: 0, g: 0, b: 0, a: 0.5 }), '#00000080');
  assert.equal(colorToHex(null), undefined);
});

const frame = {
  id: '1:2',
  name: 'Card',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 180 },
  layoutMode: 'VERTICAL',
  itemSpacing: 12,
  paddingTop: 16,
  paddingRight: 16,
  paddingBottom: 16,
  paddingLeft: 16,
  cornerRadius: 8,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  effects: [
    { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 2 }, radius: 8, spread: 0, visible: true },
  ],
  children: [
    {
      id: '1:3',
      name: 'Title',
      type: 'TEXT',
      absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 24 },
      characters: 'Hello world',
      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 18, lineHeightPx: 24, letterSpacing: 0, textAlignHorizontal: 'LEFT' },
    },
    {
      id: '1:4',
      name: 'Hidden',
      type: 'RECTANGLE',
      visible: false,
      absoluteBoundingBox: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
};

test('projects layout, fills, effects and typography', () => {
  const { tree, stats } = simplifyNodeTree(frame);
  assert.equal(tree.type, 'FRAME');
  assert.equal(tree.box.width, 320);
  assert.deepEqual(tree.layout.padding, { top: 16, right: 16, bottom: 16, left: 16 });
  assert.equal(tree.layout.itemSpacing, 12);
  assert.deepEqual(tree.fills, [{ type: 'SOLID', color: '#FFFFFF' }]);
  assert.equal(tree.effects[0].type, 'DROP_SHADOW');
  assert.equal(tree.effects[0].color, '#0000001A');
  assert.equal(tree.children[0].text.characters, 'Hello world');
  assert.equal(tree.children[0].text.lineHeightUnit, 1.333);
  assert.equal(stats.hidden, 1);
  assert.equal(stats.emitted, 2);
});

test('respects the depth budget and marks elided children', () => {
  const nested = {
    ...frame,
    children: [
      {
        ...frame.children[1],
        id: '2:1',
        visible: true,
        children: [{ ...frame.children[1], id: '3:1', visible: true, name: 'Leaf' }],
      },
    ],
  };
  const { tree, stats } = simplifyNodeTree(nested, { maxDepth: 1 });
  assert.equal(tree.children[0].childrenElided, 'depth');
  assert.equal(tree.children[0].childCount, 1);
  assert.equal(tree.children[0].children, undefined);
  assert.equal(stats.elidedDepth, 1);
  assert.equal(stats.truncated, true);

  // A deeper budget walks the whole chain.
  const full = simplifyNodeTree(nested, { maxDepth: 3 });
  assert.equal(full.tree.children[0].children[0].name, 'Leaf');
  assert.equal(full.stats.truncated, false);

  // A non-positive maxDepth falls back to the default rather than emitting nothing.
  assert.ok(simplifyNodeTree(nested, { maxDepth: 0 }).tree.children !== undefined);
});

test('elides children past the node budget', () => {
  const wide = { ...frame, children: Array.from({ length: 10 }, (_, index) => ({ ...frame.children[1], id: `2:${index}`, visible: true })) };
  const { tree, stats } = simplifyNodeTree(wide, { maxNodes: 3 });
  assert.equal(stats.truncated, true);
  assert.equal(stats.elidedBudget, 8);
  assert.equal(tree.childrenElided, 'budget');
});

test('describeNode summarises one node on a line', () => {
  const line = describeNode(projectNodeShallow(frame));
  assert.match(line, /^FRAME "Card" #1:2 /);
  assert.match(line, /320×180/);
  assert.match(line, /row|column/);
  assert.match(line, /gap=12/);
  assert.match(line, /fill=#FFFFFF/);
});

test('renderOutline indents children and caps lines', () => {
  const { tree } = simplifyNodeTree(frame);
  const outline = renderOutline(tree);
  const lines = outline.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^FRAME "Card"/);
  assert.match(lines[1], /^ {2}TEXT "Title".*"Hello world"/);

  const capped = renderOutline(tree, { maxLines: 1 });
  assert.match(capped, /outline truncated at 1 lines/);
});

test('a hidden subtree is omitted entirely', () => {
  const { tree } = simplifyNodeTree({ ...frame, visible: false });
  assert.equal(tree, null);
});
