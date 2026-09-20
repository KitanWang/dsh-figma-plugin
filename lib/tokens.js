/**
 * Design-token extraction: Figma variables and published styles into a flat,
 * mode-aware token set that can be handed to the model or written to disk as
 * CSS or JSON.
 *
 * Variable values are stored per mode and may be aliases of other variables,
 * so resolution here is a small graph walk with cycle protection rather than
 * a field read.
 *
 * @module dsh-figma/tokens
 */

import { colorToHex } from './simplify.js';

/** `resolvedType` values that map onto a design-token `$type`. */
const TYPE_NAMES = {
  COLOR: 'color',
  FLOAT: 'number',
  STRING: 'string',
  BOOLEAN: 'boolean',
};

/** W3C design-token `$type` for a Figma style type. */
const STYLE_TYPE_NAMES = {
  FILL: 'color',
  TEXT: 'typography',
  EFFECT: 'shadow',
  GRID: 'grid',
};

/** Resolve one variable value for one mode, following alias chains. */
function resolveValue(value, modeId, byId, seen) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value.type === 'VARIABLE_ALIAS') {
    const targetId = value.id;
    if (typeof targetId !== 'string') return null;
    if (seen.has(targetId)) return { alias: targetId, circular: true };
    const target = byId.get(targetId);
    if (target === undefined) return { alias: targetId, unresolved: true };
    seen.add(targetId);
    const resolved = resolveValue(target.valuesByMode?.[modeId], modeId, byId, seen);
    seen.delete(targetId);
    return { alias: target.name ?? targetId, value: resolved };
  }
  return value;
}

/** Render a resolved variable value into its token spelling. */
function presentValue(resolved, resolvedType) {
  if (resolved === null || resolved === undefined) return null;
  if (typeof resolved === 'object') {
    if (resolved.circular === true) return { alias: resolved.alias, circular: true };
    if ('value' in resolved) {
      return { alias: resolved.alias, value: presentValue(resolved.value, resolvedType) };
    }
    if (resolved.unresolved === true) return { alias: resolved.alias, unresolved: true };
    if (resolvedType === 'COLOR') return colorToHex(resolved) ?? null;
    return resolved;
  }
  return resolved;
}

/**
 * Flatten a `GET /v1/files/:key/variables/local` response into tokens.
 *
 * @param payload - the raw Figma response.
 * @returns collections, tokens (one per variable, with per-mode values), and counts.
 */
export function variablesToTokens(payload) {
  const meta = payload?.meta ?? {};
  const rawCollections = meta.variableCollections ?? {};
  const rawVariables = meta.variables ?? {};

  const byId = new Map(Object.entries(rawVariables));
  const collections = [];
  for (const collection of Object.values(rawCollections)) {
    collections.push({
      id: collection.id,
      name: collection.name,
      key: collection.key,
      defaultModeId: collection.defaultModeId,
      remote: collection.remote === true,
      modes: Array.isArray(collection.modes)
        ? collection.modes.map((mode) => ({ id: mode.modeId, name: mode.name }))
        : [],
    });
  }
  collections.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

  const tokens = [];
  for (const variable of Object.values(rawVariables)) {
    const collection = collectionById.get(variable.variableCollectionId);
    const modes = collection?.modes ?? [];
    const values = {};
    for (const mode of modes) {
      const resolved = resolveValue(variable.valuesByMode?.[mode.id], mode.id, byId, new Set([variable.id]));
      values[mode.name] = presentValue(resolved, variable.resolvedType);
    }
    tokens.push({
      id: variable.id,
      name: variable.name,
      key: variable.key,
      type: TYPE_NAMES[variable.resolvedType] ?? variable.resolvedType,
      resolvedType: variable.resolvedType,
      collection: collection?.name ?? variable.variableCollectionId,
      collectionId: variable.variableCollectionId,
      description: variable.description === '' ? undefined : variable.description,
      scopes: Array.isArray(variable.scopes) && variable.scopes.length > 0 ? variable.scopes : undefined,
      codeSyntax: variable.codeSyntax,
      remote: variable.remote === true,
      values,
    });
  }
  tokens.sort((a, b) => {
    const byCollection = String(a.collection).localeCompare(String(b.collection));
    return byCollection !== 0 ? byCollection : String(a.name).localeCompare(String(b.name));
  });

  return {
    collections,
    tokens,
    counts: { collections: collections.length, tokens: tokens.length },
  };
}

/** Slug one token path into a CSS custom-property name. */
export function cssVariableName(collectionName, tokenName) {
  const raw = `${collectionName}/${tokenName}`;
  const slug = raw
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `--${slug.length > 0 ? slug : 'token'}`;
}

/** Render a token value as CSS text, or undefined when it has no scalar form. */
function cssValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && typeof value.value === 'string') return value.value;
  return undefined;
}

/**
 * Render tokens as CSS custom properties, one block for the collection's
 * default mode plus one attribute-scoped block per additional mode.
 *
 * @param tokens - tokens from {@link variablesToTokens}.
 * @param collections - collections from {@link variablesToTokens}.
 * @param options - `selector` for the default block (default `:root`).
 * @returns CSS text.
 */
export function tokensToCss(tokens, collections, options = {}) {
  const selector = options.selector ?? ':root';
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));

  const blocks = [];
  const defaultLines = [];
  const modeLines = new Map();

  for (const token of tokens) {
    const collection = collectionById.get(token.collectionId);
    const defaultModeName = collection?.modes.find((mode) => mode.id === collection.defaultModeId)?.name;
    const modeNames = collection?.modes.map((mode) => mode.name) ?? Object.keys(token.values);
    const fallbackMode = defaultModeName ?? modeNames[0];
    const name = cssVariableName(token.collection, token.name);

    const defaultValue = cssValue(token.values[fallbackMode]);
    if (defaultValue !== undefined) defaultLines.push(`  ${name}: ${defaultValue};`);

    for (const modeName of modeNames) {
      if (modeName === fallbackMode) continue;
      const value = cssValue(token.values[modeName]);
      if (value === undefined) continue;
      if (!modeLines.has(modeName)) modeLines.set(modeName, []);
      modeLines.get(modeName).push(`  ${name}: ${value};`);
    }
  }

  if (defaultLines.length > 0) blocks.push(`${selector} {\n${defaultLines.join('\n')}\n}`);
  for (const [modeName, lines] of modeLines) {
    blocks.push(`[data-figma-mode="${modeName}"] {\n${lines.join('\n')}\n}`);
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Render tokens as a W3C-design-tokens-shaped JSON document.
 *
 * @param tokens - tokens from {@link variablesToTokens}.
 * @returns a JSON-serializable document.
 */
export function tokensToJson(tokens) {
  const out = {};
  for (const token of tokens) {
    const key = `${token.collection}/${token.name}`;
    out[key] = {
      $type: token.type,
      $value: token.values,
      ...(token.description === undefined ? {} : { $description: token.description }),
      ...(token.codeSyntax === undefined ? {} : { $extensions: { 'com.figma.codeSyntax': token.codeSyntax } }),
    };
  }
  return { $description: 'Generated by dsh-figma from Figma variables.', tokens: out };
}

/**
 * Pair a `GET /v1/files/:key/styles` listing with a `/nodes` response so each
 * style carries its actual value rather than only a name.
 *
 * @param stylesPayload - the styles listing response.
 * @param nodesPayload - the matching nodes response, or undefined when unresolved.
 * @returns resolved style records.
 */
export function stylesToTokens(stylesPayload, nodesPayload) {
  const styles = stylesPayload?.meta?.styles ?? [];
  const nodes = nodesPayload?.nodes ?? {};
  return styles.map((style) => {
    const document = nodes[style.node_id]?.document;
    let value;
    if (document !== undefined) {
      if (style.style_type === 'FILL') {
        value = document.fills?.[0] === undefined ? undefined : { color: colorToHex(document.fills[0].color), raw: document.fills[0] };
      } else if (style.style_type === 'TEXT') {
        value = document.style;
      } else if (style.style_type === 'EFFECT') {
        value = document.effects;
      } else if (style.style_type === 'GRID') {
        value = document.layoutGrids;
      }
    }
    return {
      key: style.key,
      name: style.name,
      type: STYLE_TYPE_NAMES[style.style_type] ?? style.style_type,
      styleType: style.style_type,
      description: style.description === '' ? undefined : style.description,
      nodeId: style.node_id,
      remote: style.remote === true,
      value,
    };
  });
}

/**
 * Split a list into fixed-size chunks (used to bound `ids=` query length).
 *
 * @param items - the list.
 * @param size - maximum chunk length.
 * @returns the chunks.
 */
export function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
