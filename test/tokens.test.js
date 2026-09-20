import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunk, cssVariableName, stylesToTokens, tokensToCss, tokensToJson, variablesToTokens } from '../lib/tokens.js';

const variablesPayload = {
  status: 200,
  meta: {
    variableCollections: {
      'VariableCollectionId:1:1': {
        id: 'VariableCollectionId:1:1',
        name: 'Theme',
        key: 'collectionkey',
        defaultModeId: '1:0',
        remote: false,
        modes: [
          { modeId: '1:0', name: 'Light' },
          { modeId: '1:1', name: 'Dark' },
        ],
      },
    },
    variables: {
      'VariableID:1:2': {
        id: 'VariableID:1:2',
        name: 'background/default',
        key: 'varkey1',
        variableCollectionId: 'VariableCollectionId:1:1',
        resolvedType: 'COLOR',
        description: 'Page background',
        scopes: ['FRAME_FILL'],
        codeSyntax: { WEB: 'var(--bg-default)' },
        valuesByMode: {
          '1:0': { r: 1, g: 1, b: 1, a: 1 },
          '1:1': { r: 0, g: 0, b: 0, a: 1 },
        },
      },
      'VariableID:1:3': {
        id: 'VariableID:1:3',
        name: 'surface/raised',
        variableCollectionId: 'VariableCollectionId:1:1',
        resolvedType: 'COLOR',
        valuesByMode: {
          '1:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' },
          '1:1': { r: 0.1, g: 0.1, b: 0.1, a: 1 },
        },
      },
      'VariableID:1:4': {
        id: 'VariableID:1:4',
        name: 'space/200',
        variableCollectionId: 'VariableCollectionId:1:1',
        resolvedType: 'FLOAT',
        valuesByMode: { '1:0': 8, '1:1': 8 },
      },
      'VariableID:1:5': {
        id: 'VariableID:1:5',
        name: 'loop/a',
        variableCollectionId: 'VariableCollectionId:1:1',
        resolvedType: 'COLOR',
        valuesByMode: { '1:0': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:5' } },
      },
    },
  },
};

test('variablesToTokens resolves modes, colors, and aliases', () => {
  const { collections, tokens, counts } = variablesToTokens(variablesPayload);
  assert.equal(counts.collections, 1);
  assert.equal(counts.tokens, 4);
  assert.deepEqual(collections[0].modes, [
    { id: '1:0', name: 'Light' },
    { id: '1:1', name: 'Dark' },
  ]);

  const background = tokens.find((token) => token.name === 'background/default');
  assert.equal(background.type, 'color');
  assert.equal(background.values.Light, '#FFFFFF');
  assert.equal(background.values.Dark, '#000000');
  assert.equal(background.description, 'Page background');
  assert.equal(background.codeSyntax.WEB, 'var(--bg-default)');

  const surface = tokens.find((token) => token.name === 'surface/raised');
  assert.deepEqual(surface.values.Light, { alias: 'background/default', value: '#FFFFFF' });
  assert.equal(surface.values.Dark, '#1A1A1A');

  const space = tokens.find((token) => token.name === 'space/200');
  assert.equal(space.type, 'number');
  assert.equal(space.values.Light, 8);
});

test('a circular alias chain is reported, not followed forever', () => {
  const { tokens } = variablesToTokens(variablesPayload);
  const loop = tokens.find((token) => token.name === 'loop/a');
  assert.equal(loop.values.Light.circular, true);
});

test('cssVariableName slugifies a collection/name path', () => {
  assert.equal(cssVariableName('Theme', 'background/default'), '--theme-background-default');
  assert.equal(cssVariableName('Core', 'space/200'), '--core-space-200');
});

test('tokensToCss emits a default block and one block per extra mode', () => {
  const { collections, tokens } = variablesToTokens(variablesPayload);
  const css = tokensToCss(tokens, collections);
  assert.match(css, /:root \{/);
  assert.match(css, /--theme-background-default: #FFFFFF;/);
  assert.match(css, /\[data-figma-mode="Dark"\] \{/);
  assert.match(css, /--theme-background-default: #000000;/);
  // The alias keeps the target's resolved value, not a reference to the alias.
  assert.match(css, /--theme-surface-raised: #FFFFFF;/);
});

test('tokensToJson produces a flat token document', () => {
  const { tokens } = variablesToTokens(variablesPayload);
  const document = tokensToJson(tokens);
  assert.equal(document.tokens['Theme/background/default'].$type, 'color');
  assert.deepEqual(document.tokens['Theme/background/default'].$value, { Light: '#FFFFFF', Dark: '#000000' });
});

test('stylesToTokens pairs a styles listing with resolved node values', () => {
  const stylesPayload = {
    meta: {
      styles: [
        { key: 'k1', name: 'color/bg', style_type: 'FILL', node_id: '3:1', description: '' },
        { key: 'k2', name: 'text/body', style_type: 'TEXT', node_id: '3:2' },
        { key: 'k3', name: 'shadow/card', style_type: 'EFFECT', node_id: '3:3' },
      ],
    },
  };
  const nodesPayload = {
    nodes: {
      '3:1': { document: { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] } },
      '3:2': { document: { style: { fontFamily: 'Inter', fontSize: 16 } } },
      '3:3': { document: { effects: [{ type: 'DROP_SHADOW', radius: 4 }] } },
    },
  };
  const styles = stylesToTokens(stylesPayload, nodesPayload);
  assert.equal(styles[0].type, 'color');
  assert.equal(styles[0].value.color, '#000000');
  assert.equal(styles[1].type, 'typography');
  assert.equal(styles[1].value.fontFamily, 'Inter');
  assert.equal(styles[2].type, 'shadow');
  assert.equal(styles[2].value[0].radius, 4);
});

test('stylesToTokens tolerates an unresolved listing', () => {
  const styles = stylesToTokens({ meta: { styles: [{ key: 'k', name: 'n', style_type: 'FILL', node_id: '1:1' }] } }, undefined);
  assert.equal(styles.length, 1);
  assert.equal(styles[0].value, undefined);
});

test('chunk splits evenly and keeps the remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});
