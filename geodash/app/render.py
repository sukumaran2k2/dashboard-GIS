"""Rendering of datasets for the browser. Always reads the untouched source file and applies the georeference
override on the fly, so nothing is ever rewritten."""
import io
import json
import math
import warnings
from pathlib import Path

import numpy as np
import rasterio
import shapely
from affine import Affine
from PIL import Image
from pyproj import CRS
from rasterio.crs import CRS as RioCRS
from rasterio.enums import Resampling
from rasterio.errors import NotGeoreferencedWarning
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT

from . import crs as C
from . import files, geo, georef, vectorio
from .errors import GeorefError
from .ingest.pointcloud import ramp

WORLD = 20037508.342789244
_EMPTY = io.BytesIO()
Image.new("RGBA", (256, 256)).save(_EMPTY, "PNG")
EMPTY_TILE = _EMPTY.getvalue()
_bounds_cache: dict = {}


def tile_bounds(z, x, y):
    s = 2 * WORLD / 2 ** z
    return (-WORLD + x * s, WORLD - (y + 1) * s, -WORLD + (x + 1) * s, WORLD - y * s)


def tile_lonlat_bounds(z, x, y):
    n = 2 ** z
    lon0, lon1 = x / n * 360 - 180, (x + 1) / n * 360 - 180
    lat = lambda yy: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))
    return lon0, lat(y + 1), lon1, lat(y)


def _eff_bounds(did, version, ds, g):
    key = (did, version)
    if key not in _bounds_cache:
        res = georef.resolve(ds, g)
        fw = res.frame_w
        _bounds_cache[key] = geo.bounds_wgs84(res.w_wkt, fw) if fw else None
        if len(_bounds_cache) > 2000:
            _bounds_cache.pop(next(iter(_bounds_cache)))
    return _bounds_cache[key]


def png_bytes(arr_rgba) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr_rgba).save(buf, "PNG", compress_level=1)
    return buf.getvalue()


def _to_rgb(data, meta, n_bands):
    """data: float array (bands, h, w). Returns uint8 (h, w, 3)."""
    st = meta["stretch"]
    if n_bands == 1:
        lo, hi = st[0]
        return ramp((data[0] - lo) / max(hi - lo, 1e-12))
    chans = []
    for i in range(3):
        if meta["dtype"] == "uint8":
            chans.append(np.clip(data[i], 0, 255))
        else:
            lo, hi = st[i]
            chans.append(np.clip((data[i] - lo) / max(hi - lo, 1e-12), 0, 1) * 255)
    return np.stack(chans, -1).astype(np.uint8)


def _pick_source(did, meta, res, z, x, y):
    """Original file, or the derived reduced-resolution pyramid when the tile is much coarser than the source pixels."""
    full = res.raster_affine
    pyr = meta.get("pyramid")
    pyr_path = files.ds_dir(did) / "cache" / "pyramid.tif"
    if not pyr or not pyr_path.exists():
        return files.source_path(did, meta), full
    b = tile_bounds(z, x, y)
    try:
        wx, wy = C.transformer(C.wkt(CRS.from_epsg(3857)), res.w_wkt).transform([b[0], b[2], b[2], b[0]], [b[1], b[1], b[3], b[3]])
        a, bb, c, d, e, f = (~full)[:6]
        cols, rows = a * np.asarray(wx) + bb * np.asarray(wy) + c, d * np.asarray(wx) + e * np.asarray(wy) + f
        span = max(np.ptp(cols), np.ptp(rows)) / 256.0          # source pixels covered by one output pixel
    except Exception:
        return files.source_path(did, meta), full
    if np.isfinite(span) and span >= 1.5 * max(pyr["sx"], pyr["sy"]):
        return pyr_path, full @ Affine.scale(pyr["sx"], pyr["sy"])
    return files.source_path(did, meta), full


def render_tile(did, ds, g, z, x, y) -> bytes:
    res = georef.resolve(ds, g)
    if res.state != "ready":
        raise GeorefError("Dataset has no ground coordinates yet.")
    version = g["version"] if g else 0
    eb = _eff_bounds(did, version, ds, g)
    if eb is None:
        return EMPTY_TILE
    tl = tile_lonlat_bounds(z, x, y)
    if tl[2] < eb[0] or tl[0] > eb[2] or tl[3] < eb[1] or tl[1] > eb[3]:
        return EMPTY_TILE
    meta = ds["meta"]
    path, src_transform = _pick_source(did, meta, res, z, x, y)
    has_alpha = meta["has_alpha"]
    n_data = meta["bands"] - (1 if has_alpha else 0)
    idx = [1, 2, 3] if n_data >= 3 else [1]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(path) as src:
            with WarpedVRT(src, src_crs=RioCRS.from_wkt(res.w_wkt), src_transform=src_transform, crs="EPSG:3857",
                           transform=from_bounds(*tile_bounds(z, x, y), 256, 256), width=256, height=256,
                           resampling=Resampling.bilinear, add_alpha=not has_alpha) as vrt:
                data = vrt.read(idx, masked=False).astype(np.float64)
                alpha = vrt.read(vrt.count) > 0
    rgb = _to_rgb(data, meta, len(idx))
    return png_bytes(np.dstack([rgb, (alpha * 255).astype(np.uint8)]))


def raster_preview(did, ds, max_dim=1536) -> Path:
    """Decimated, unwarped image of the raster in pixel space (used while positioning)."""
    out = files.ds_dir(did) / "cache"
    out.mkdir(exist_ok=True)
    p = out / "preview.png"
    if p.exists():
        return p
    meta = ds["meta"]
    n_data = meta["bands"] - (1 if meta["has_alpha"] else 0)
    idx = [1, 2, 3] if n_data >= 3 else [1]
    scale = max(1.0, max(meta["width"], meta["height"]) / max_dim)
    shape = (max(1, int(meta["height"] / scale)), max(1, int(meta["width"] / scale)))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(files.source_path(did, meta)) as src:
            arr = src.read(idx, out_shape=shape, masked=True, resampling=Resampling.bilinear)
            alpha = src.read(src.count, out_shape=shape) > 0 if meta["has_alpha"] else None
    valid = ~np.ma.getmaskarray(arr).any(0)
    if alpha is not None:
        valid &= alpha
    rgb = _to_rgb(np.ma.filled(arr.astype(np.float64), 0), meta, len(idx))
    p.write_bytes(png_bytes(np.dstack([rgb, (valid * 255).astype(np.uint8)])))
    return p


# ------------------------------------------------------------------------------------------ vectors
def _jsonable(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        return None if not math.isfinite(float(v)) else float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, bytes):
        return v.decode("utf-8", "ignore")
    if isinstance(v, np.datetime64):
        return str(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def effective_vector(did, ds, g):
    """Returns (geoms in W, fields, res). Geometry is read from the untouched source and transformed."""
    res = georef.resolve(ds, g)
    if res.state != "ready":
        raise GeorefError("Dataset has no ground coordinates yet. Assign a CRS or place it on the map.")
    info, geoms, fields = vectorio.read_all(files.source_path(did, ds["meta"]), ds["meta"]["layer"])
    has_z = bool(np.any(shapely.has_z(geoms[~shapely.is_missing(geoms)]))) if len(geoms) else False

    def fn(coords):
        x, y = res.forward(coords[:, 0], coords[:, 1])
        out = np.empty_like(coords)
        out[:, 0], out[:, 1] = x, y
        if coords.shape[1] > 2:
            out[:, 2] = res.z(coords[:, 2])
        return out

    return shapely.transform(geoms, fn, include_z=has_z), fields, res


def effective_geojson(did, ds, g) -> Path:
    version = g["version"] if g else 0
    cache = files.ds_dir(did) / "cache"
    cache.mkdir(exist_ok=True)
    p = cache / f"geojson_v{version}.json"
    if p.exists():
        return p
    geoms, fields, res = effective_vector(did, ds, g)
    t = C.transformer(res.w_wkt, C.wkt(CRS.from_epsg(4326)))
    names = list(fields)
    has_z = bool(np.any(shapely.has_z(geoms[~shapely.is_missing(geoms)]))) if len(geoms) else False

    def to_lonlat(c):
        out = np.array(c, float, copy=True)
        out[:, 0], out[:, 1] = t.transform(c[:, 0], c[:, 1])
        return out

    geoms4326 = shapely.transform(geoms, to_lonlat, include_z=has_z)
    feats = []
    for i, geom in enumerate(geoms4326):
        if geom is None:
            continue
        feats.append({"type": "Feature", "geometry": json.loads(shapely.to_geojson(geom)),
                      "properties": {n: _jsonable(fields[n][i]) for n in names}})
    p.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    for old in cache.glob("geojson_v*.json"):
        if old != p:
            old.unlink(missing_ok=True)
    return p


def native_geojson(did, ds) -> dict:
    """Raw coordinates exactly as stored (used for the local-frame view of unreferenced vectors)."""
    info, geoms, fields = vectorio.read_all(files.source_path(did, ds["meta"]), ds["meta"]["layer"])
    names = list(fields)
    return {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": json.loads(shapely.to_geojson(g)),
         "properties": {n: _jsonable(fields[n][i]) for n in names}} for i, g in enumerate(geoms) if g is not None]}


def feature_rows(did, ds, offset, limit):
    from pyogrio.raw import read as raw_read
    meta = ds["meta"]
    m, _f, _g, data = raw_read(files.source_path(did, meta), layer=meta["layer"], read_geometry=False,
                               skip_features=offset, max_features=limit)
    names = list(m["fields"])
    n = len(data[0]) if data else 0
    return names, [{k: _jsonable(data[j][i]) for j, k in enumerate(names)} for i in range(n)]
