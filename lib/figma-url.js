/**
 * Figma reference parsing: turn any Figma URL — or a bare file key / node
 * reference — into the `{ fileKey, nodeId }` pair the REST API expects.
 *
 * This is deliberately its own module with no dependencies: it is the one
 * piece of the plugin that has to be right for every workflow, and it is
 * cheap to test exhaustively.
 *
 * @module dsh-figma/figma-url
 */

/**
 * URL path segments that introduce a Figma file, mapped to the surface they
 * denote. `file` is the legacy design-file path; `design` is the current one.
 * `board` is FigJam, `slides`/`deck` are Slides, `make` is Figma Make.
 */
const KIND_SEGMENTS = new Map([
  ['file', 'design'],
  ['design', 'design'],
  ['proto', 'proto'],
  ['board', 'figjam'],
  ['slides', 'slides'],
  ['deck', 'slides'],
  ['make', 'make'],
  ['site', 'site'],
]);

/** Figma file keys are opaque alphanumerics; community files use numeric ids. */
const FILE_KEY_PATTERN = /^[A-Za-z0-9]{6,64}$/;

/**
 * A node id in either the URL spelling (`1-2`) or the API spelling (`1:2`),
 * including the `I…` prefixed form Figma uses for nodes inside instances and
 * the `;`-separated nested form.
 */
const NODE_ID_PATTERN = /^(?:I?\d+:\d+)(?:;I?\d+:\d+)*$/;

/** Thrown when a string is not a Figma reference this plugin can use. */
export class FigmaRefError extends Error {
  /** @param message - human-readable reason, quoted back to the model. */
  constructor(message) {
    super(message);
    this.name = 'FigmaRefError';
  }
}

/**
 * Normalize a node id written with dashes (the URL form) into the API's
 * colon form. Accepts an already-normalized id unchanged.
 *
 * @param value - node id in either spelling.
 * @returns the `:`-separated node id.
 * @throws {FigmaRefError} when the value is not a plausible node id.
 */
export function normalizeNodeId(value) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) throw new FigmaRefError('node id is empty');
  const normalized = raw.replace(/-/g, ':');
  if (!NODE_ID_PATTERN.test(normalized)) {
    throw new FigmaRefError(
      `"${raw}" is not a Figma node id (expected something like "1:2" or "1-2")`,
    );
  }
  return normalized;
}

/**
 * Parse a comma/space separated node-id list into normalized ids.
 *
 * @param value - raw list from a URL parameter or tool argument.
 * @returns normalized node ids, de-duplicated in first-seen order.
 */
export function normalizeNodeIds(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const parts = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const seen = new Set();
  const ids = [];
  for (const part of parts) {
    const id = normalizeNodeId(part);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Parse any Figma reference into a file key plus optional node id.
 *
 * Accepted inputs:
 * - `https://www.figma.com/design/<key>/<name>?node-id=1-2`
 * - `https://www.figma.com/file/<key>/…`, `/proto/…`, `/board/…`, `/slides/…`
 * - `https://figma.com/community/file/<id>`
 * - a bare file key: `AbC123XyZ`
 * - `AbC123XyZ:1-2`, `AbC123XyZ/1-2`, `AbC123XyZ?node-id=1-2`
 *
 * An explicit `nodeId` option always wins over a node id found in the input.
 *
 * @param input - URL, file key, or combined reference.
 * @param options - optional explicit node id override.
 * @returns the parsed reference.
 * @throws {FigmaRefError} when nothing usable can be extracted.
 */
export function parseFigmaRef(input, options = {}) {
  const text = String(input ?? '').trim();
  if (text.length === 0) {
    throw new FigmaRefError('a Figma URL or file key is required');
  }

  let fileKey;
  let kind = 'design';
  let urlNodeId = null;
  let url;

  const looksLikeUrl = /^https?:\/\//i.test(text) || /(^|\/\/|\.)figma\.com\//i.test(text);

  if (looksLikeUrl) {
    const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    try {
      url = new URL(candidate);
    } catch {
      throw new FigmaRefError(`could not parse "${input}" as a URL`);
    }
    const host = url.hostname.toLowerCase();
    if (!/(^|\.)figma\.com$/.test(host)) {
      throw new FigmaRefError(`"${host}" is not a figma.com host`);
    }
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    let index = -1;
    for (let i = 0; i < segments.length; i += 1) {
      if (KIND_SEGMENTS.has(segments[i].toLowerCase())) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      throw new FigmaRefError(
        `no file kind (file/design/proto/board/slides) in the Figma URL path "${url.pathname}"`,
      );
    }
    kind = KIND_SEGMENTS.get(segments[index].toLowerCase());
    fileKey = segments[index + 1];
    if (fileKey === undefined) {
      throw new FigmaRefError(`the Figma URL "${input}" has no file key`);
    }
    const queryNodeId = url.searchParams.get('node-id');
    if (queryNodeId !== null && queryNodeId.trim().length > 0) {
      urlNodeId = normalizeNodeId(queryNodeId);
    }
  } else {
    // Bare reference. Split a trailing node id off the key, if present.
    const [head] = text.split(/[?#]/);
    const separatorIndex = head.search(/[:/]/);
    if (separatorIndex === -1) {
      fileKey = head;
    } else {
      fileKey = head.slice(0, separatorIndex);
      const tail = head.slice(separatorIndex + 1);
      if (tail.trim().length > 0) urlNodeId = normalizeNodeId(tail);
    }
    const queryMatch = /[?#].*?\bnode-id=([^&#]+)/i.exec(text);
    if (urlNodeId === null && queryMatch !== null) {
      urlNodeId = normalizeNodeId(decodeURIComponent(queryMatch[1]));
    }
  }

  const key = String(fileKey ?? '').trim();
  if (!FILE_KEY_PATTERN.test(key)) {
    throw new FigmaRefError(`"${key || input}" is not a Figma file key`);
  }

  let nodeId = urlNodeId;
  if (options.nodeId !== undefined && options.nodeId !== null && String(options.nodeId).trim() !== '') {
    nodeId = normalizeNodeId(options.nodeId);
  }

  return {
    fileKey: key,
    nodeId,
    kind,
    url: url === undefined ? null : url.toString(),
  };
}

/**
 * Build the canonical browser URL for a file (and node), so tool output can
 * point a human back at the design.
 *
 * @param fileKey - the file key.
 * @param nodeId - optional `:`-separated node id.
 * @param kind - the surface, as returned by {@link parseFigmaRef}.
 * @returns an absolute figma.com URL.
 */
export function figmaUrl(fileKey, nodeId, kind = 'design') {
  const segment = kind === 'figjam' ? 'board' : kind === 'slides' ? 'slides' : kind === 'make' ? 'make' : 'design';
  const base = `https://www.figma.com/${segment}/${fileKey}/`;
  if (nodeId === undefined || nodeId === null || nodeId === '') return base;
  return `${base}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}`;
}
