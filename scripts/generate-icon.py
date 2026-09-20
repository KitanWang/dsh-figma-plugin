#!/usr/bin/env python3
"""
Generate the plugin's app icon as a PNG, with no image-library dependency.

Figma's public-app review asks for a 512x512 logo, and the repository should be
able to regenerate it from source rather than checking in an opaque binary.
Everything here is stdlib: the PNG container is assembled by hand and each shape
is rasterized from a signed distance field, so edges are antialiased without a
drawing library.

Usage:
    python3 scripts/generate-icon.py [output-path] [size]

Design: a selection frame holding stacked layers — the design-tool vocabulary
for "this file, this content". Original artwork; it deliberately does not reuse
Figma's logo, which is a trademark.
"""

import math
import struct
import sys
import zlib

# ── tiny PNG writer ──────────────────────────────────────────────────────────


def write_png(path, width, height, pixels):
    """Write an RGBA pixel buffer (bytes, 4 per pixel, row-major) as a PNG."""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0 (None) for every scanline
        raw += pixels[y * stride : (y + 1) * stride]

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    with open(path, "wb") as handle:
        handle.write(b"\x89PNG\r\n\x1a\n")
        handle.write(chunk(b"IHDR", header))
        handle.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        handle.write(chunk(b"IEND", b""))


# ── shape math ───────────────────────────────────────────────────────────────


def rounded_rect_distance(px, py, cx, cy, half_w, half_h, radius):
    """Signed distance from a point to a rounded rectangle (negative = inside)."""
    qx = abs(px - cx) - (half_w - radius)
    qy = abs(py - cy) - (half_h - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def coverage(distance):
    """Turn a distance in pixels into an antialiased 0..1 coverage value."""
    return min(max(0.5 - distance, 0.0), 1.0)


def mix(a, b, t):
    """Linear blend of two RGB triples."""
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


# ── palette ──────────────────────────────────────────────────────────────────

TILE_TOP = (0x1A, 0x1D, 0x26)
TILE_BOTTOM = (0x0A, 0x0C, 0x11)
GLOW = (0x5B, 0x6C, 0xFF)
VIOLET = (0x8B, 0x5C, 0xF6)
SKY = (0x38, 0xBD, 0xF8)
CONTENT = (0xFF, 0xFF, 0xFF)


def render(size):
    """Render one square RGBA icon at `size` pixels."""
    px = bytearray(size * size * 4)

    # Geometry, expressed as fractions of the canvas so the art scales.
    s = float(size)
    tile_r = 0.220 * s
    frame_half = 0.235 * s
    frame_r = 0.100 * s
    stroke = 0.052 * s
    centre = s / 2.0

    # The frame's clear interior, which is where content may be drawn. The
    # stroke straddles the frame path, so the usable area is inset by half of
    # it; drawing to the path itself would collide with the stroke.
    interior_half = frame_half - stroke / 2.0

    # Three stacked bars, widest at the top, optically centred in the interior.
    bar_h = 0.038 * s
    bar_r = bar_h / 2.0
    gap = 0.052 * s
    stack_h = 3 * bar_h + 2 * gap
    stack_top = centre - stack_h / 2.0
    bar_specs = [
        (stack_top + bar_h / 2.0 + (bar_h + gap) * i, width, alpha)
        for i, (width, alpha) in enumerate(
            [
                (interior_half * 0.86, 1.00),
                (interior_half * 0.86, 0.74),
                (interior_half * 0.52, 0.56),
            ]
        )
    ]

    for y in range(size):
        for x in range(size):
            cx = x + 0.5
            cy = y + 0.5

            tile_d = rounded_rect_distance(cx, cy, centre, centre, centre, centre, tile_r)
            tile_a = coverage(tile_d)
            if tile_a <= 0.0:
                continue

            # Base fill: a vertical gradient, top lighter than bottom.
            base = mix(TILE_TOP, TILE_BOTTOM, cy / s)

            # Soft radial glow behind the mark, so the frame reads as lifted.
            radial = math.hypot(cx - centre, cy - centre) / (s * 0.62)
            glow = max(0.0, 1.0 - radial)
            base = mix(base, GLOW, (glow**2) * 0.20)

            # The selection frame, drawn as a stroked rounded rectangle with a
            # diagonal gradient from violet to sky.
            frame_d = rounded_rect_distance(cx, cy, centre, centre, frame_half, frame_half, frame_r)
            frame_stroke_d = abs(frame_d) - stroke / 2.0
            frame_a = coverage(frame_stroke_d)
            if frame_a > 0.0:
                t = min(max(((cx - (centre - frame_half)) + (cy - (centre - frame_half))) / (4.0 * frame_half), 0.0), 1.0)
                base = mix(base, mix(VIOLET, SKY, t), frame_a)

            # Stacked content bars inside the frame.
            for bar_cy, bar_half_w, alpha in bar_specs:
                bar_d = rounded_rect_distance(cx, cy, centre, bar_cy, bar_half_w, bar_h / 2.0, bar_r)
                bar_a = coverage(bar_d)
                if bar_a > 0.0:
                    base = mix(base, CONTENT, bar_a * alpha)

            offset = (y * size + x) * 4
            px[offset] = int(round(base[0]))
            px[offset + 1] = int(round(base[1]))
            px[offset + 2] = int(round(base[2]))
            px[offset + 3] = int(round(tile_a * 255))

    return px


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "assets/icon-512.png"
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    write_png(out, size, size, render(size))
    print(f"wrote {out} ({size}x{size})")


if __name__ == "__main__":
    main()
