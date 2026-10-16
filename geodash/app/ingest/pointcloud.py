import math
from pathlib import Path

import numpy as np
from PIL import Image

from .. import config
from .. import crs as C
from ..pointio import open_points
from .common import IngestError, Inspection, native_block

RAMP = np.array([[0, 43, 131, 186], [.25, 100, 180, 120], [.5, 230, 220, 120], [.75, 170, 110, 70], [1, 245, 245, 245]], float)


def ramp(v):
    v = np.clip(v, 0, 1)
    return np.stack([np.interp(v, RAMP[:, 0], RAMP[:, i]) for i in (1, 2, 3)], -1).astype(np.uint8)


def inspect_pointcloud(path: Path, filename: str, out: Path, ext: str) -> Inspection:
    src = open_points(path, ext)
    n = src.count
    mins, maxs = np.array(src.mins, float), np.array(src.maxs, float)
    center = (mins + maxs) / 2
    dx, dy = float(maxs[0] - mins[0]), float(maxs[1] - mins[1])
    ext_max = max(dx, dy, 1e-6)
    area = max(dx, 1e-6) * max(dy, 1e-6)
    cell = max(ext_max / config.TOPDOWN_MAX_DIM, 2.0 * math.sqrt(area / n))
    w, h = int(math.ceil(dx / cell)) + 1, int(math.ceil(dy / cell)) + 1
    gz = np.full(w * h, -np.inf, np.float64)
    grgb = np.zeros((w * h, 3), np.uint8) if src.has_rgb else None

    step = max(1, math.ceil(n / config.MAX_PREVIEW_POINTS))
    pos, col, k = [], [], 0
    for ch in src.chunks():
        # preview sample
        sl = slice((-k) % step, None, step)
        k += len(ch.x)
        pos.append(np.stack([ch.x[sl] - center[0], ch.y[sl] - center[1], ch.z[sl] - center[2]], 1).astype(np.float32))
        if src.has_rgb:
            col.append(ch.rgb[sl])
        else:
            col.append(np.asarray(ch.z[sl], np.float32))
        # top-down grid: keep the highest point per cell
        c = np.clip(((ch.x - mins[0]) / cell).astype(np.int64), 0, w - 1)
        r = np.clip(((maxs[1] - ch.y) / cell).astype(np.int64), 0, h - 1)
        idx = r * w + c
        order = np.argsort(ch.z, kind="stable")
        idx, z = idx[order], ch.z[order]
        sel = z > gz[idx]
        gz[idx[sel]] = z[sel]
        if grgb is not None:
            grgb[idx[sel]] = ch.rgb[order][sel]
    pos = np.concatenate(pos)
    valid = np.isfinite(gz)
    if src.has_rgb:
        rgb_prev = np.concatenate(col)
        rgb_grid = grgb
    else:
        zs = np.concatenate(col)
        lo, hi = np.percentile(zs, 1), np.percentile(zs, 99)
        rgb_prev = ramp((zs - lo) / max(hi - lo, 1e-9))
        gv = gz[valid]
        glo, ghi = np.percentile(gv, 1), np.percentile(gv, 99)
        rgb_grid = np.zeros((w * h, 3), np.uint8)
        rgb_grid[valid] = ramp((gv - glo) / max(ghi - glo, 1e-9))
    (out / "points.bin").write_bytes(pos.astype("<f4").tobytes() + rgb_prev.tobytes())
    img = np.dstack([rgb_grid.reshape(h, w, 3), (valid.reshape(h, w) * 255).astype(np.uint8)])
    Image.fromarray(img).save(out / "topdown.png")

    frame = [[float(mins[0]), float(maxs[1])], [float(mins[0] + w * cell), float(maxs[1])],
             [float(mins[0] + w * cell), float(maxs[1] - h * cell)], [float(mins[0]), float(maxs[1] - h * cell)]]
    crs = src.crs
    warns = list(src.warnings)
    native = native_block(crs, frame)
    if crs is not None and native["bounds_wgs84"] is None:
        warns.append("Coordinates fall outside the valid range of the declared CRS. Check or reassign the CRS.")
        native = native_block(None, frame)
        crs = None
    if crs is None:
        warns.append("No CRS in the file: the data is in a local coordinate frame. Place it on the map or assign its CRS.")
    meta = {
        "format": {".las": "LAS", ".laz": "LAZ", ".xyz": "XYZ text", ".txt": "XYZ text", ".pts": "PTS text", ".ply": "PLY"}[path.suffix.lower()],
        "points": int(n), "preview_points": int(len(pos)), "center": center.tolist(),
        "mins": mins.tolist(), "maxs": maxs.tolist(), "has_rgb": bool(src.has_rgb),
        "details": src.info or {},
        "topdown": {"w": w, "h": h, "cell": cell, "affine": [cell, 0.0, float(mins[0]), 0.0, -cell, float(maxs[1])]},
        "native": native, "warnings": warns,
    }
    return Inspection("pointcloud", "pointcloud", "ready" if crs is not None else "unreferenced", meta)
