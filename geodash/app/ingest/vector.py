import csv
import zipfile
from pathlib import Path

import numpy as np
import pyogrio
import shapely

from .. import crs as C
from .. import geo, vectorio
from .. import config
from .common import IngestError, Inspection, native_block

VECTOR_EXT = {".geojson", ".json", ".gpkg", ".kml", ".kmz", ".gpx", ".dxf", ".csv", ".shp", ".gdb"}
MAX_CSV_ROWS = 500_000
MAX_MAP_FEATURES = 500_000
LON = ["lon", "lng", "long", "longitude"]
LAT = ["lat", "latitude"]
X = LON + ["x", "easting", "east", "e"]
Y = LAT + ["y", "northing", "north", "n"]
Z = ["z", "elevation", "elev", "height", "alt", "altitude"]
FORMAT_NAMES = {".geojson": "GeoJSON", ".json": "GeoJSON", ".gpkg": "GeoPackage", ".kml": "KML", ".kmz": "KMZ",
                ".gpx": "GPX", ".dxf": "DXF", ".csv": "CSV points", ".shp": "Shapefile", ".gdb": "File Geodatabase"}


def _find(header, names):
    low = [h.strip().lower() for h in header]
    for n in names:
        if n in low:
            return low.index(n)
    return None


def csv_to_gpkg(path: Path, out: Path):
    with open(path, newline="", encoding="utf-8-sig", errors="replace") as f:
        sample = f.read(65536)
        f.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        reader = csv.reader(f, dialect)
        header = next(reader, None)
        if not header:
            raise IngestError("CSV is empty.")
        xi, yi, zi = _find(header, X), _find(header, Y), _find(header, Z)
        if xi is None or yi is None:
            raise IngestError("No coordinate columns found. The CSV needs lat/lon or x/y columns in its header row. "
                              "For a plain x y z point cloud, use a .xyz or .txt file instead.")
        low = [h.strip().lower() for h in header]
        suggested = "EPSG:4326" if low[xi] in LON and low[yi] in LAT else None
        cols = [[] for _ in header]
        xs, ys, zs, skipped = [], [], [], 0
        for n, row in enumerate(reader):
            if len(xs) >= MAX_CSV_ROWS:
                raise IngestError(f"CSV has more than {MAX_CSV_ROWS:,} rows. Large point tables should be uploaded as .xyz/.las.")
            if len(row) < len(header):
                row = row + [""] * (len(header) - len(row))
            try:
                x, y = float(row[xi].replace(",", ".") if dialect.delimiter == ";" else row[xi]), float(row[yi].replace(",", ".") if dialect.delimiter == ";" else row[yi])
                z = float(row[zi]) if zi is not None and row[zi].strip() else np.nan
            except ValueError:
                skipped += 1
                continue
            if not (np.isfinite(x) and np.isfinite(y)):
                skipped += 1
                continue
            xs.append(x); ys.append(y); zs.append(z)
            for i in range(len(header)):
                cols[i].append(row[i])
    if not xs:
        raise IngestError("CSV has no rows with valid numeric coordinates.")
    fields, used = {}, set()
    for i, h in enumerate(header):
        if i in (xi, yi):
            continue
        name = (h.strip() or f"col{i}")
        while name in used:
            name += "_"
        used.add(name)
        vals = cols[i]
        try:
            arr = np.array([float(v) if v.strip() else np.nan for v in vals], dtype="float64")
        except ValueError:
            arr = np.array(vals, dtype=object)
        fields[name] = arr
    xs, ys, zs = np.array(xs), np.array(ys), np.array(zs)
    geoms = shapely.points(xs, ys, zs) if zi is not None and np.isfinite(zs).any() else shapely.points(xs, ys)
    dest = out / "native.gpkg"
    vectorio.write(dest, geoms, fields, "GPKG", crs_wkt=None)
    return dest, {"suggested_crs": suggested, "skipped_rows": skipped}


def inspect_vector(path: Path, filename: str, out: Path, ext: str) -> Inspection:
    extra, warns = {}, []
    src = path
    if ext == ".kmz":
        try:
            with zipfile.ZipFile(path) as z:
                kml = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
                if not kml:
                    raise IngestError("KMZ contains no .kml document.")
                dest = out / "src"
                dest.mkdir(exist_ok=True)
                (dest / "doc.kml").write_bytes(z.read(kml))
                src = dest / "doc.kml"
        except zipfile.BadZipFile:
            raise IngestError("File is not a valid KMZ archive.")
    elif ext == ".csv":
        src, extra = csv_to_gpkg(path, out)
        if extra.get("skipped_rows"):
            warns.append(f"{extra['skipped_rows']} CSV row(s) skipped: non-numeric coordinates.")
    try:
        layers = [(str(n), str(g)) for n, g in pyogrio.list_layers(src)]
        if not layers:
            raise IngestError("The file contains no vector layers.")
        counts = {}
        for n, _ in layers:
            try:
                counts[n] = int(pyogrio.read_info(src, layer=n, force_feature_count=True)["features"])
            except Exception:
                counts[n] = 0
        layer = max(layers, key=lambda l: counts[l[0]])[0]
        if len(layers) > 1:
            warns.append("File has several layers (" + ", ".join(f"{n}: {counts[n]}" for n, _ in layers) + f"); showing '{layer}'.")
        info = pyogrio.read_info(src, layer=layer, force_feature_count=True, force_total_bounds=True)
    except IngestError:
        raise
    except Exception as e:
        raise IngestError("Not a readable vector dataset (corrupt, truncated or unsupported): " + str(e).replace(str(src), "file")[:200])
    n = int(info["features"])
    if n <= 0:
        raise IngestError("The dataset contains no features.")
    tb = info.get("total_bounds")
    if tb is None or not all(np.isfinite(tb)):
        _i, geoms, _f = vectorio.read_all(src, layer)
        tb = shapely.total_bounds(geoms)
    crs = None
    if info.get("crs"):
        try:
            crs = C.parse(info["crs"])
        except Exception:
            warns.append("The file declares a CRS that could not be understood. Assign a CRS.")
    frame = geo.bbox_frame(*map(float, tb))
    native = native_block(crs, frame)
    if crs is not None and native["bounds_wgs84"] is None:
        warns.append("Coordinates fall outside the valid range for the declared CRS. Check or reassign the CRS.")
        native = native_block(None, frame)
        crs = None
    if crs is None and not warns:
        warns.append("No CRS found in the file. Assign the CRS its coordinates are in, or place it on the map.")
    if n > MAX_MAP_FEATURES:
        warns.append(f"{n:,} features: too many to draw in the browser. Export or filter instead.")
    gtype = info.get("geometry_type") or "Unknown"
    meta = {
        "format": FORMAT_NAMES.get(ext, ext), "driver": info.get("driver"), "layer": layer, "layers": [l[0] for l in layers],
        "geometry_type": gtype, "has_z": " Z" in gtype or gtype.endswith("Z"), "features": n,
        "fields": [{"name": f, "dtype": str(d)} for f, d in zip(info["fields"], info["dtypes"])],
        "native": native, "warnings": warns, "source": src.relative_to(out).as_posix(),
        "suggested_crs": extra.get("suggested_crs"),
    }
    return Inspection("vector", "vector", "ready" if crs is not None else "unreferenced", meta)
