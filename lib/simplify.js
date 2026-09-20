/**
 * Node-tree projection: turn Figma's verbose node JSON into a compact,
 * model-sized description of a design.
 *
 * A single Figma frame routinely serializes to hundreds of kilobytes, almost
 * all of it irrelevant to implementing the design. This module keeps the
 * facts a developer needs — geometry, auto-layout, paints, typography,
 * component identity, and bound variables — and drops the rest, under hard
 * depth and node budgets so a tool result can never blow up a turn.
 *
 * @module dsh-figma/simplify
 */

/** Default recursion cap; deeper subtrees are elided rather than dropped. */
export const DEFAULT_MAX_DEPTH = 8;

/** Default emitted-node cap across the whole tree. */
export const DEFAULT_MAX_NODES = 400;

/** Longest text run quoted into an outline line. */
const MAX_TEXT_PREVIEW = 160;

/** Round to a fixed number of decimals, avoiding float noise like 0.30000000000000004. */
function round(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Build an object from the entries whose value is not undefined. */
function defined(entries) {
  const result = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Convert a Figma RGBA (0–1 floats) into a hex string plus alpha. */
export function colorToHex(color) {
  if (color === null || typeof color !== 'object') return undefined;
  const channel = (value) => {
    const scaled = Math.round(Math.min(Math.max(Number(value) || 0, 0), 1) * 255);
    return scaled.toString(16).padStart(2, '0');
  };
  const hex = `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
  const alpha = round(color.a ?? 1, 3);
  return alpha === undefined || alpha >= 1 ? hex : `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Project one paint, keeping gradient stops but dropping handle vectors. */
function projectPaint(paint) {
  if (paint === null || typeof paint !== 'object') return undefined;
  const base = defined({
    type: paint.type,
    visible: paint.visible === false ? false : undefined,
    opacity: paint.opacity !== undefined && paint.opacity < 1 ? round(paint.opacity, 3) : undefined,
    blendMode: paint.blendMode !== undefined && paint.blendMode !== 'NORMAL' ? paint.blendMode : undefined,
  });
  if (paint.type === 'SOLID') {
    return defined({ ...base, color: colorToHex(paint.color) });
  }
  if (typeof paint.type === 'string' && paint.type.startsWith('GRADIENT_')) {
    return defined({
      ...base,
      stops: Array.isArray(paint.gradientStops)
        ? paint.gradientStops.map((stop) => defined({ position: round(stop.position, 3), color: colorToHex(stop.color) }))
        : undefined,
    });
  }
  if (paint.type === 'IMAGE') {
    return defined({ ...base, imageRef: paint.imageRef, scaleMode: paint.scaleMode });
  }
  return base;
}

/** Project the paints array, collapsing a single opaque solid to one entry. */
function projectPaints(paints) {
  if (!Array.isArray(paints) || paints.length === 0) return undefined;
  const projected = paints.map(projectPaint).filter((paint) => paint !== undefined);
  if (projected.length === 0) return undefined;
  // Only the topmost visible paint matters for a solid fill in practice.
  return projected.length === 1 ? projected : projected.slice(0, 6);
}

/** Project one effect. */
function projectEffect(effect) {
  if (effect === null || typeof effect !== 'object') return undefined;
  if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
    return defined({
      type: effect.type,
      color: colorToHex(effect.color),
      offset: defined({ x: round(effect.offset?.x), y: round(effect.offset?.y) }),
      radius: round(effect.radius),
      spread: round(effect.spread),
      visible: effect.visible === false ? false : undefined,
    });
  }
  if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
    return defined({ type: effect.type, radius: round(effect.radius), visible: effect.visible === false ? false : undefined });
  }
  return defined({ type: effect.type });
}

/** Project auto-layout settings, present only on layout containers. */
function projectLayout(node) {
  const hasLayout =
    node.layoutMode !== undefined ||
    node.itemSpacing !== undefined ||
    node.paddingLeft !== undefined ||
    node.primaryAxisAlignItems !== undefined;
  if (!hasLayout) return undefined;
  return defined({
    mode: node.layoutMode,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    primaryAxisSizingMode: node.primaryAxisSizingMode,
    counterAxisSizingMode: node.counterAxisSizingMode,
    itemSpacing: round(node.itemSpacing),
    counterAxisSpacing: round(node.counterAxisSpacing),
    wrap: node.layoutWrap === 'WRAP' ? true : undefined,
    padding: defined({
      top: round(node.paddingTop),
      right: round(node.paddingRight),
      bottom: round(node.paddingBottom),
      left: round(node.paddingLeft),
    }),
    layoutAlign: node.layoutAlign,
    layoutGrow: node.layoutGrow,
    layoutPositioning: node.layoutPositioning === 'ABSOLUTE' ? 'ABSOLUTE' : undefined,
  });
}

/** Project the typography of a TEXT node. */
function projectText(node) {
  if (node.type !== 'TEXT') return undefined;
  const style = node.style ?? {};
  const fontSize = round(style.fontSize);
  const lineHeight = round(style.lineHeightPx);
  const letterSpacing = round(style.letterSpacing);
  return defined({
    characters: typeof node.characters === 'string' ? node.characters : undefined,
    fontFamily: style.fontFamily,
    fontPostScriptName: style.fontPostScriptName,
    fontWeight: style.fontWeight,
    fontSize,
    lineHeight,
    lineHeightUnit: lineHeight !== undefined && fontSize !== undefined && fontSize > 0 ? round(lineHeight / fontSize, 3) : undefined,
    letterSpacing,
    textAlignHorizontal: style.textAlignHorizontal,
    textAlignVertical: style.textAlignVertical,
    textCase: style.textCase,
    textDecoration: style.textDecoration,
    italic: style.italic === true ? true : undefined,
    autoResize: node.textAutoResize,
    truncation: node.textTruncation,
    maxLines: node.maxLines,
    hasMixedStyles: Array.isArray(node.characterStyleOverrides) && node.characterStyleOverrides.length > 0 ? true : undefined,
  });
}

/** Project component / instance identity and variant properties. */
function projectComponent(node) {
  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    return defined({
      componentKey: node.componentKey,
      name: node.name,
      description: node.description,
      variantProperties: node.variantProperties,
      componentPropertyDefinitions: node.componentPropertyDefinitions,
    });
  }
  if (node.type === 'INSTANCE') {
    return defined({
      componentId: node.componentId,
      componentName: node.name,
      componentProperties: node.componentProperties,
      isExposedInstance: node.isExposedInstance === true ? true : undefined,
    });
  }
  return undefined;
}

/** Geometry of one node, in absolute page coordinates. */
function projectBox(node) {
  const box = node.absoluteBoundingBox ?? node.absoluteRenderBounds;
  if (box === null || box === undefined) return undefined;
  return defined({
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height),
  });
}

/**
 * Project a single node (without children) into its compact form.
 *
 * @param node - raw Figma node.
 * @returns the compact projection.
 */
export function projectNodeShallow(node) {
  const fills = projectPaints(node.fills);
  const strokes = projectPaints(node.strokes);
  const effects = Array.isArray(node.effects)
    ? node.effects.filter((effect) => effect?.visible !== false).map(projectEffect)
    : undefined;
  return defined({
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible === false ? false : undefined,
    opacity: node.opacity !== undefined && node.opacity < 1 ? round(node.opacity, 3) : undefined,
    box: projectBox(node),
    layout: projectLayout(node),
    radius: round(node.cornerRadius),
    radii: Array.isArray(node.rectangleCornerRadii) ? node.rectangleCornerRadii.map((value) => round(value)) : undefined,
    fills,
    strokes: strokes === undefined ? undefined : strokes,
    strokeWeight: round(node.strokeWeight),
    strokeAlign: node.strokeAlign,
    clipsContent: node.clipsContent === true ? true : undefined,
    constraints: node.constraints,
    effects: effects !== undefined && effects.length > 0 ? effects : undefined,
    text: projectText(node),
    component: projectComponent(node),
    styles: node.styles,
    boundVariables: node.boundVariables,
    layoutGrids: Array.isArray(node.layoutGrids) && node.layoutGrids.length > 0 ? node.layoutGrids.length : undefined,
  });
}

/**
 * Recursively project a node tree under depth and node budgets.
 *
 * @param root - raw Figma node (a FRAME, COMPONENT, PAGE, …).
 * @param options - budget overrides.
 * @returns the projected tree plus statistics describing what was elided.
 */
export function simplifyNodeTree(root, options = {}) {
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const maxNodes = Number.isInteger(options.maxNodes) && options.maxNodes > 0 ? options.maxNodes : DEFAULT_MAX_NODES;
  const includeHidden = options.includeHidden === true;

  const stats = { visited: 0, emitted: 0, elidedDepth: 0, elidedBudget: 0, hidden: 0, maxDepthReached: 0 };

  /**
   * @param node - raw node.
   * @param depth - current depth, root = 0.
   * @returns the projection, or undefined when the node is skipped.
   */
  function walk(node, depth) {
    if (node === null || typeof node !== 'object') return undefined;
    stats.visited += 1;
    if (node.visible === false && !includeHidden) {
      stats.hidden += 1;
      return undefined;
    }
    if (stats.emitted >= maxNodes) {
      stats.elidedBudget += 1;
      return undefined;
    }
    stats.emitted += 1;
    stats.maxDepthReached = Math.max(stats.maxDepthReached, depth);

    const projected = projectNodeShallow(node);
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0) return projected;

    if (depth >= maxDepth) {
      stats.elidedDepth += children.length;
      return { ...projected, childCount: children.length, childrenElided: 'depth' };
    }

    const kept = [];
    let budgetHit = false;
    for (const child of children) {
      if (stats.emitted >= maxNodes) {
        budgetHit = true;
        stats.elidedBudget += 1;
        continue;
      }
      const childProjection = walk(child, depth + 1);
      if (childProjection !== undefined) kept.push(childProjection);
    }
    if (kept.length === 0) {
      return { ...projected, childCount: children.length, ...(budgetHit ? { childrenElided: 'budget' } : {}) };
    }
    return { ...projected, children: kept, ...(budgetHit ? { childrenElided: 'budget' } : {}) };
  }

  const tree = walk(root, 0);
  return {
    tree: tree ?? null,
    stats: {
      ...stats,
      truncated: stats.elidedDepth > 0 || stats.elidedBudget > 0,
      maxDepth,
      maxNodes,
    },
  };
}

/** One-line human summary of a node's layout, used by the outline renderer. */
function layoutSummary(node) {
  const parts = [];
  if (node.box !== undefined) {
    parts.push(`${node.box.width}×${node.box.height}`);
  }
  const layout = node.layout;
  if (layout !== undefined && layout.mode !== undefined && layout.mode !== 'NONE') {
    parts.push(layout.mode === 'HORIZONTAL' ? 'row' : 'column');
    if (layout.itemSpacing !== undefined && layout.itemSpacing !== 0) parts.push(`gap=${layout.itemSpacing}`);
    const pad = layout.padding;
    if (pad !== undefined) {
      const values = [pad.top, pad.right, pad.bottom, pad.left];
      if (values.some((value) => value !== undefined && value !== 0)) {
        parts.push(`pad=${values.map((value) => value ?? 0).join(',')}`);
      }
    }
    if (layout.wrap === true) parts.push('wrap');
  } else if (node.layout !== undefined) {
    parts.push('layout=NONE');
  }
  return parts.join(' ');
}

/** One-line summary of a node's topmost fill. */
function fillSummary(node) {
  const fills = node.fills;
  if (!Array.isArray(fills) || fills.length === 0) return undefined;
  const paint = fills[0];
  if (paint === undefined) return undefined;
  if (paint.color !== undefined) return paint.color;
  if (paint.type !== undefined && String(paint.type).startsWith('GRADIENT_')) return paint.type;
  if (paint.type === 'IMAGE') return 'image';
  return paint.type;
}

/** Quote a text run for the outline, collapsed to one line. */
function quoteText(characters) {
  if (typeof characters !== 'string') return undefined;
  const collapsed = characters.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > MAX_TEXT_PREVIEW ? `"${collapsed.slice(0, MAX_TEXT_PREVIEW)}…"` : `"${collapsed}"`;
}

/** Describe one projected node as a single outline line (without indentation). */
export function describeNode(node) {
  const segments = [node.type ?? 'NODE'];
  segments.push(`"${node.name ?? ''}"`);
  if (node.id !== undefined) segments.push(`#${node.id}`);
  const layout = layoutSummary(node);
  if (layout.length > 0) segments.push(layout);
  const fill = fillSummary(node);
  if (fill !== undefined) segments.push(`fill=${fill}`);
  if (node.visible === false) segments.push('hidden');
  if (node.text !== undefined) {
    const text = node.text;
    const typography = [text.fontFamily, text.fontWeight, text.fontSize !== undefined ? `${text.fontSize}px` : undefined]
      .filter((part) => part !== undefined && part !== '')
      .join(' ');
    const quoted = quoteText(text.characters);
    if (quoted !== undefined) segments.push(quoted);
    if (typography.length > 0) segments.push(`(${typography})`);
  }
  if (node.component !== undefined) {
    const name = node.component.componentName ?? node.component.name;
    if (name !== undefined && name !== node.name) segments.push(`→ ${name}`);
  }
  if (node.childrenElided === 'depth') segments.push(`[+${node.childCount} children, depth limit]`);
  if (node.childrenElided === 'budget') segments.push('[children omitted, node budget]');
  return segments.join(' ');
}

/**
 * Render a projected tree as an indented, human- and model-readable outline.
 *
 * @param tree - the projection from {@link simplifyNodeTree}.
 * @param options - `maxLines` caps the outline (default 600).
 * @returns the outline text.
 */
export function renderOutline(tree, options = {}) {
  if (tree === null || tree === undefined) return '(empty)';
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : 600;
  const lines = [];
  let truncated = false;

  function walk(node, depth) {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(`${'  '.repeat(depth)}${describeNode(node)}`);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child, depth + 1);
  }

  walk(tree, 0);
  if (truncated) lines.push(`… outline truncated at ${maxLines} lines`);
  return lines.join('\n');
}
