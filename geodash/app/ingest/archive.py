import os
import shutil
import zipfile
from pathlib import Path

from .. import config
from .common import IngestError

SKIP = ("__macosx", ".ds_store", "thumbs.db")
RASTER = {".tif", ".tiff", ".png", ".jpg", ".jpeg", ".asc", ".img", ".hgt", ".jp2"}
POINTS = {".las", ".laz", ".xyz", ".pts", ".ply", ".txt"}
VECTOR = {".geojson", ".json", ".gpkg", ".kml", ".gpx", ".dxf", ".csv"}


def safe_extract(zip_path: Path, dest: Path):
    try:
        z = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        raise IngestError("File is not a valid .zip archive.")
    with z:
        infos = [i for i in z.infolist() if not any(s in i.filename.lower() for s in SKIP)]
        if len(infos) > config.ZIP_MAX_ENTRIES:
            raise IngestError(f"ZIP has too many entries ({len(infos)}; limit {config.ZIP_MAX_ENTRIES}).")
        total = sum(i.file_size for i in infos)
        if total > config.ZIP_MAX_UNCOMPRESSED:
            raise IngestError("ZIP expands to more than the allowed size.")
        for i in infos:
            if i.compress_size and i.file_size > 200 * 1024**2 and i.file_size / i.compress_size > 1000:
                raise IngestError("ZIP entry has a suspicious compression ratio and was rejected.")
        dest.mkdir(parents=True, exist_ok=True)
        root = dest.resolve()
        for i in infos:
            target = (dest / i.filename).resolve()
            if root != target and root not in target.parents:
                raise IngestError("ZIP contains an unsafe file path and was rejected.")
            if i.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(i) as s, open(target, "wb") as d:
                shutil.copyfileobj(s, d, 1024 * 1024)


def select_primary(root: Path):
    """Returns (primary_path, ext, notes) for an extracted archive."""
    files = [p for p in root.rglob("*") if p.is_file()]
    dirs = [p for p in root.rglob("*") if p.is_dir()]
    by_ext = lambda exts: sorted(p for p in files if p.suffix.lower() in exts)
    notes = []
    gdbs = sorted(p for p in dirs if p.name.lower().endswith(".gdb"))
    if gdbs:
        return gdbs[0], ".gdb", notes
    shps = by_ext({".shp"})
    if shps:
        shp = shps[0]
        have = {p.suffix.lower() for p in files if p.stem == shp.stem and p.parent == shp.parent}
        missing = [e for e in (".shx", ".dbf") if e not in have]
        if missing:
            raise IngestError(f"Shapefile is missing required component(s): {', '.join(missing)}. "
                              "The ZIP must include .shp, .shx and .dbf (and .prj for the CRS).")
        if len(shps) > 1:
            notes.append(f"ZIP contains {len(shps)} shapefiles; only '{shp.name}' was loaded.")
        return shp, ".shp", notes
    for exts in (RASTER, POINTS - {".txt"}, VECTOR):
        found = by_ext(exts)
        if found:
            if len(found) > 1:
                notes.append(f"ZIP contains {len(found)} candidate files; only '{found[0].name}' was loaded.")
            return found[0], found[0].suffix.lower(), notes
    raise IngestError("ZIP contains no supported dataset (.shp, .gdb, GeoTIFF/raster, LAS/LAZ, GeoJSON, GPKG, KML, GPX, DXF, CSV).")
