#!/usr/bin/env python3
"""Generate extension icons (no external deps).

Design: blue rounded square, a faint white crosshair showing the "wrong"
position and a solid red/white target dot shifted to the corrected position.
"""
import os
import struct
import zlib


def write_png(path, size, pixel_fn):
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")
        for x in range(size):
            row += bytes(pixel_fn(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data +
                struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n" +
           chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) +
           chunk(b"IDAT", zlib.compress(raw, 9)) +
           chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def icon_pixel(size):
    s = float(size)
    radius = s * 0.20
    # ghost crosshair (original, offset position) and corrected target
    ghost_cx, ghost_cy = s * 0.38, s * 0.62
    targ_cx, targ_cy = s * 0.62, s * 0.38
    line_w = max(1.0, s / 14.0)

    def rounded_alpha(x, y):
        # distance-based alpha for a rounded-corner square
        px = min(max(x + 0.5, radius), s - radius)
        py = min(max(y + 0.5, radius), s - radius)
        d = ((x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2) ** 0.5
        if d <= radius - 0.7:
            return 255
        if d >= radius + 0.7:
            return 0
        return int(255 * (radius + 0.7 - d) / 1.4)

    def pixel(x, y):
        a = rounded_alpha(x, y)
        if a == 0:
            return (0, 0, 0, 0)
        r, g, b = 0x0B, 0x57, 0xD0  # blue base

        fx, fy = x + 0.5, y + 0.5

        # ghost crosshair (semi-transparent white)
        on_ghost = ((abs(fx - ghost_cx) < line_w / 2 and abs(fy - ghost_cy) < s * 0.22) or
                    (abs(fy - ghost_cy) < line_w / 2 and abs(fx - ghost_cx) < s * 0.22))
        if on_ghost:
            r = r + (255 - r) * 90 // 255
            g = g + (255 - g) * 90 // 255
            b = b + (255 - b) * 90 // 255

        # corrected target: white ring + red dot
        d = ((fx - targ_cx) ** 2 + (fy - targ_cy) ** 2) ** 0.5
        ring_r = s * 0.17
        if abs(d - ring_r) < line_w * 0.75:
            r, g, b = 255, 255, 255
        elif d < s * 0.085:
            r, g, b = 0xEA, 0x43, 0x35  # red dot

        return (r, g, b, a)

    return pixel


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out_dir, "icon%d.png" % size)
        write_png(path, size, icon_pixel(size))
        print("wrote", path)


if __name__ == "__main__":
    main()
