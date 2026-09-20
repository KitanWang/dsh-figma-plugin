/**
 * Minimal Figma REST client: auth, query building, retries, and error
 * translation. No third-party dependencies — the plugin has to load inside a
 * profile whose only guaranteed packages are the harness's own.
 *
 * @module dsh-figma/rest
 */

/** HTTP statuses worth retrying: rate limiting and transient upstream faults. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Cap on a single backoff sleep, so a hostile `Retry-After` cannot stall a turn. */
const MAX_BACKOFF_MS = 20_000;

/** Thrown for any non-2xx Figma response or transport failure. */
export class FigmaApiError extends Error {
  /**
   * @param message - message safe to show the model.
   * @param details - HTTP status, Figma error code, and request path.
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'FigmaApiError';
    this.status = details.status;
    this.code = details.code;
    this.path = details.path;
    this.retryable = details.retryable === true;
  }
}

/**
 * Append query parameters, skipping empty values so an absent optional
 * argument never sends `ids=` to Figma.
 *
 * @param url - the request URL, mutated in place.
 * @param query - parameter map; arrays are joined with commas.
 */
function applyQuery(url, query) {
  if (query === undefined || query === null) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      url.searchParams.set(key, value.join(','));
      continue;
    }
    if (typeof value === 'string' && value.length === 0) continue;
    url.searchParams.set(key, String(value));
  }
}

/** Sleep that rejects promptly when the caller aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse `Retry-After` (seconds or HTTP date) into a bounded millisecond delay. */
function retryAfterMs(response, attempt) {
  const header = response.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
    }
  }
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Short, model-safe rendering of a Figma error body. */
function describeFailure(payload, status, statusText) {
  if (payload !== null && typeof payload === 'object') {
    const code = typeof payload.err === 'string' ? payload.err : undefined;
    const message = typeof payload.message === 'string' ? payload.message : undefined;
    if (message !== undefined && code !== undefined) return { message: `${code}: ${message}`, code };
    if (message !== undefined) return { message, code };
    if (code !== undefined) return { message: code, code };
  }
  if (typeof payload === 'string' && payload.trim().length > 0) {
    return { message: payload.trim().slice(0, 500), code: undefined };
  }
  return { message: `${status} ${statusText}`.trim(), code: undefined };
}

/**
 * A thin, retrying Figma REST client.
 *
 * One client instance is bound to one token; callers resolve the token per
 * tool call so a credential rotated in the harness store takes effect on the
 * next call without a plugin reload.
 */
export class FigmaClient {
  #token;
  #authMode;
  #baseUrl;
  #timeoutMs;
  #maxRetries;
  #fetch;

  /**
   * @param options - token, auth mode, base URL, timeout, retry budget.
   */
  constructor(options = {}) {
    const token = options.token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new FigmaApiError('no Figma access token is configured');
    }
    this.#token = token.trim();
    this.#authMode = options.authMode === 'oauth' ? 'oauth' : 'token';
    this.#baseUrl = String(options.baseUrl ?? 'https://api.figma.com').replace(/\/+$/, '');
    this.#timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
    this.#maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : 2;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new FigmaApiError('this runtime has no global fetch; pass one explicitly');
    }
  }

  /** Headers proving this client's identity to Figma. */
  #authHeaders() {
    if (this.#authMode === 'oauth') return { authorization: `Bearer ${this.#token}` };
    return { 'x-figma-token': this.#token };
  }

  /**
   * Perform one authenticated JSON request with retries.
   *
   * @param pathname - API path beginning with `/v1/`.
   * @param options - method, query, JSON body, and caller cancellation.
   * @returns the parsed JSON body.
   * @throws {FigmaApiError} on transport failure or a non-2xx response.
   */
  async request(pathname, options = {}) {
    const method = options.method ?? 'GET';
    const url = new URL(`${this.#baseUrl}${pathname}`);
    applyQuery(url, options.query);

    let lastError;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');

      const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
      const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);

      let response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            ...this.#authHeaders(),
            accept: 'application/json',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        lastError = new FigmaApiError(
          `Figma request to ${pathname} failed: ${error?.message ?? String(error)}`,
          { path: pathname, retryable: true },
        );
        if (attempt === this.#maxRetries) throw lastError;
        await sleep(500 * 2 ** attempt, options.signal);
        continue;
      }

      const text = await response.text();
      let payload;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }

      if (response.ok) {
        if (payload === undefined) {
          throw new FigmaApiError(`Figma returned an empty body for ${pathname}`, {
            status: response.status,
            path: pathname,
          });
        }
        return payload;
      }

      const described = describeFailure(payload, response.status, response.statusText);
      const retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new FigmaApiError(
        `Figma API ${response.status} for ${pathname}: ${described.message}`,
        { status: response.status, code: described.code, path: pathname, retryable },
      );
      if (!retryable || attempt === this.#maxRetries) throw lastError;
      await sleep(retryAfterMs(response, attempt), options.signal);
    }
    throw lastError ?? new FigmaApiError(`Figma request to ${pathname} failed`);
  }

  /**
   * Download raw bytes from an absolute URL (typically a rendered-image link
   * Figma returned, hosted on S3 — no Figma credential is attached).
   *
   * @param url - absolute https URL.
   * @param options - optional cancellation.
   * @returns the response body bytes and content type.
   */
  async download(url, options = {}) {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
    let response;
    try {
      response = await this.#fetch(url, { signal, redirect: 'follow' });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      throw new FigmaApiError(`downloading the rendered image failed: ${error?.message ?? String(error)}`, {
        retryable: true,
      });
    }
    if (!response.ok) {
      throw new FigmaApiError(`downloading the rendered image failed with HTTP ${response.status}`, {
        status: response.status,
      });
    }
    const buffer = await response.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? null,
    };
  }
}

/** @returns whether a value is a {@link FigmaApiError}. */
export function isFigmaApiError(value) {
  return value instanceof FigmaApiError;
}
