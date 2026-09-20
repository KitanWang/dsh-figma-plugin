/**
 * Raster dimension sniffing for the formats Figma's image endpoint returns.
 *
 * Figma reports only a URL for a rendered node, and the attachment store
 * reports dimensions only when the image is actually admitted. This module
 * fills the gap for the file-on-disk fallback path so `figma_get_screenshot`
 * always reports a real pixel size. Deliberately dependency-free: a decoder
 * library would be a heavy dependency for four header reads.
 *
 * @module dsh-figma/image-dims
 */

/** Read a big-endian uint32. */
function u32be(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** Read a little-endian uint16. */
function u16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Read a little-endian uint32. */
function u32le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/** Whether the byte range starts with the given ASCII signature. */
function hasAscii(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Decode PNG: IHDR is the first chunk, immediately after the 8-byte signature. */
function pngDimensions(bytes) {
  if (bytes.length < 24 || !hasAscii(bytes, 0, '\x89PNG\r\n\x1a\n')) return null;
  if (!hasAscii(bytes, 12, 'IHDR')) return null;
  return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

/** Decode GIF: the logical screen descriptor is at a fixed offset. */
function gifDimensions(bytes) {
  if (bytes.length < 10) return null;
  if (!hasAscii(bytes, 0, 'GIF87a') && !hasAscii(bytes, 0, 'GIF89a')) return null;
  return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** Decode WebP from the VP8X / VP8 / VP8L chunk variants. */
function webpDimensions(bytes) {
  if (bytes.length < 30 || !hasAscii(bytes, 0, 'RIFF') || !hasAscii(bytes, 8, 'WEBP')) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // Lossy: dimensions live in the frame header after the 3-byte start code.
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = u32le(bytes, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/** Decode JPEG by scanning for a start-of-frame marker. */
function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Sniff the intrinsic pixel size of an encoded raster image.
 *
 * @param bytes - the encoded image.
 * @param mediaType - declared media type, used only to try the right parser first.
 * @returns `{ width, height }`, or `null` for an unrecognized or vector payload.
 */
export function imageDimensions(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) return null;
  const parsers =
    mediaType === 'image/jpeg'
      ? [jpegDimensions, pngDimensions, webpDimensions, gifDimensions]
      : mediaType === 'image/webp'
        ? [webpDimensions, pngDimensions, jpegDimensions, gifDimensions]
        : mediaType === 'image/gif'
          ? [gifDimensions, pngDimensions, jpegDimensions, webpDimensions]
          : [pngDimensions, jpegDimensions, webpDimensions, gifDimensions];
  for (const parse of parsers) {
    const size = parse(bytes);
    if (size !== null && size.width > 0 && size.height > 0) return size;
  }
  return null;
}

/** Map a Figma image format to the media type Figma serves for it. */
export function mediaTypeForFormat(format) {
  switch (format) {
    case 'jpg':
      return 'image/jpeg';
    case 'pdf':
      return 'application/pdf';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/png';
  }
}
