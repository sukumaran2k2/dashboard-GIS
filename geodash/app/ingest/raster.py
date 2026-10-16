import re
import warnings
from pathlib import Path

import numpy as np
import rasterio
from affine import Affine
from pyproj import CRS
from rasterio.enums import ColorInterp, Resampling
from rasterio.errors import NotGeoreferencedWarning

from .. import crs as C
from .common import IngestError, Inspection, native_block

RASTER_EXT = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".asc", ".img", ".hgt", ".jp2"}
FORMAT_NAMES = {"GTiff": "GeoTIFF", "PNG": "PNG image", "JPEG": "JPEG image", "AAIGrid": "Esri ASCII grid",
                "HFA": "Erdas IMAGINE", "SRTMHGT": "SRTM HGT", "JP2OpenJPEG": "JPEG 2000"}


def pyproj_crs(rcrs):
    if rcrs is None:
        return None
    try:
        return C.parse(CRS.from_wkt(rcrs.to_wkt()))
    except Exception:
        return None


def native_affine(src):
    """The file's own pixel->CRS transform, or None when the file carries no real georeferencing."""
    t = src.transform
    if t.is_identity or (t.a == 0 and t.e == 0 and t.b == 1 and t.d == 1):
        return None
    return t


def frame_of(t: Affine, w: int, h: int):
    return [list(t @ (0, 0)), list(t @ (w, 0)), list(t @ (w, h)), list(t @ (0, h))]


def categorize(name: str, count: int, dtype: str) -> str:
    n = name.lower()
    if re.search(r"dsm", n):
        return "dsm"
    if re.search(r"dtm", n):
        return "dtm"
    if re.search(r"(dem|elev|height|terrain)", n):
        return "dem"
    if count == 1 and dtype != "uint8":
        return "dem"
    if count >= 3 and dtype in ("uint8", "uint16"):
        return "orthomosaic"
    return "raster"


PYRAMID_MIN_PIXELS = 16_000_000
PYRAMID_MAX_DIM = 4096


def reduced_read(src, max_dim):
    scale = max(1.0, max(src.width, src.height) / max_dim)
    shape = (src.count, max(1, round(src.height / scale)), max(1, round(src.width / scale)))
    return src.read(out_shape=shape, masked=True, resampling=Resampling.average)


def write_pyramid(src, arr, out: Path) -> dict:
    """Derived reduced-resolution copy (never the upload itself) so low-zoom tiles do not read the whole raster."""
    cache = out / "cache"
    cache.mkdir(exist_ok=True)
    count, h, w = arr.shape
    path = cache / "pyramid.tif"
    profile = dict(driver="GTiff", width=w, height=h, count=count, dtype=src.dtypes[0], nodata=src.nodata, tiled=True,
                   blockxsize=256, blockysize=256, compress="deflate", BIGTIFF="IF_SAFER")
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(np.ma.filled(arr, src.nodata if src.nodata is not None else 0))
    with rasterio.Env(COMPRESS_OVERVIEW="DEFLATE"):
        with rasterio.open(path, "r+") as dst:
            dst.build_overviews([2, 4, 8, 16], Resampling.average)
    return {"width": w, "height": h, "sx": src.width / w, "sy": src.height / h}


def stretch_of(arr, count):
    stretch = []
    for i in range(min(count, 3)):
        v = arr[i].compressed().astype(float)
        v = v[np.isfinite(v)]
        stretch.append([float(np.percentile(v, 2)), float(np.percentile(v, 98))] if v.size else [0.0, 1.0])
        if stretch[-1][0] == stretch[-1][1]:
            stretch[-1][1] = stretch[-1][0] + 1.0
    return stretch


def inspect_raster(path: Path, filename: str, out: Path) -> Inspection:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        try:
            src = rasterio.open(path)
        except Exception as e:
            raise IngestError("Not a readable raster (corrupt, truncated or unsupported format): "
                              + str(e).replace(str(path), "file")[:200])
        with src:
            if src.width < 1 or src.height < 1 or src.count < 1:
                raise IngestError("Raster has no pixels or bands.")
            crs = pyproj_crs(src.crs)
            t = native_affine(src)
            warns = []
            if src.crs is not None and crs is None:
                warns.append("The file's CRS is not a geographic or projected system and was ignored. Assign a CRS.")
            if crs is not None and t is None:
                warns.append("The file has a CRS but no pixel-to-ground transform. Provide the origin and pixel size.")
                crs = None
            if crs is None and t is not None and src.crs is None:
                warns.append("The file has a pixel transform but no CRS. Assign the CRS its coordinates are in.")
            frame = frame_of(t, src.width, src.height) if t is not None else [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]]
            native = native_block(crs, frame, has_geotransform=t is not None)
            if crs is not None and native["bounds_wgs84"] is None:
                warns.append("The raster extent cannot be expressed in WGS84 with this CRS; check the CRS.")
                native = native_block(None, frame, has_geotransform=t is not None)
                crs = None
            status = "ready" if (crs is not None and t is not None) else "unreferenced"
            interp = list(src.colorinterp)
            big = src.width * src.height > PYRAMID_MIN_PIXELS and not src.overviews(1)
            arr = reduced_read(src, PYRAMID_MAX_DIM if big else 1024)
            pyramid = write_pyramid(src, arr, out) if big else None
            meta = {
                "format": FORMAT_NAMES.get(src.driver, src.driver), "driver": src.driver,
                "width": src.width, "height": src.height, "bands": src.count, "dtype": src.dtypes[0],
                "resolution": [abs(t.a), abs(t.e)] if t is not None else None,
                "nodata": src.nodata, "overviews": len(src.overviews(1)), "tiled": bool(src.block_shapes and src.profile.get("tiled", False)),
                "compression": src.compression.value if src.compression else None,
                "has_alpha": ColorInterp.alpha in interp,
                "affine": list(t)[:6] if t is not None else None,
                "stretch": stretch_of(arr, src.count), "pyramid": pyramid, "native": native, "warnings": warns,
            }
            cat = categorize(filename, src.count - (1 if meta["has_alpha"] else 0), src.dtypes[0])
            return Inspection("raster", cat, status, meta)
