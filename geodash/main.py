"""GeoDash - geospatial dataset dashboard (no photogrammetry). FastAPI + SQLite + rasterio."""
import io, json, math, os, shutil, sqlite3, time, uuid, zipfile, tempfile
from pathlib import Path
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from rasterio.warp import transform_bounds
from rasterio.transform import from_bounds
import shapefile, laspy
from pyproj import CRS, Transformer

BASE = Path(__file__).parent
DATA = Path(os.environ.get("GEODASH_DATA", BASE / "data")); FILES = DATA / "files"
FILES.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(DATA / "geodash.db", check_same_thread=False); db.row_factory = sqlite3.Row
db.executescript("""CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,created REAL);
CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,project_id TEXT,filename TEXT,kind TEXT,size INTEGER,meta TEXT,created REAL);""")
app = FastAPI(title="GeoDash")
RASTER_EXT, LAS_EXT = {".tif", ".tiff"}, {".las", ".laz"}
MAX_POINTS = 1_500_000
RAMP = np.array([[0, 43, 131, 186], [.25, 100, 180, 120], [.5, 230, 220, 120], [.75, 170, 110, 70], [1, 245, 245, 245]], float)

def ramp(v):  # v in 0..1 -> uint8 RGB
    v = np.clip(v, 0, 1)
    return np.stack([np.interp(v, RAMP[:, 0], RAMP[:, i]) for i in (1, 2, 3)], -1).astype(np.uint8)

def row(r):
    d = dict(r); d["meta"] = json.loads(d["meta"]) if "meta" in d else None; return d

def ds_dir(i): return FILES / i

# ---------- projects ----------
class Name(BaseModel): name: str
def clean(n):
    n = n.strip()
    if not n: raise HTTPException(400, "Project name cannot be empty")
    return n[:120]

@app.get("/api/projects")
def projects():
    out = []
    for p in db.execute("SELECT * FROM projects ORDER BY created DESC"):
        s = db.execute("SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM datasets WHERE project_id=?", (p["id"],)).fetchone()
        out.append({**dict(p), "datasets": s["c"], "size": s["s"]})
    return out

@app.post("/api/projects")
def create_project(b: Name):
    pid = uuid.uuid4().hex[:12]; db.execute("INSERT INTO projects VALUES(?,?,?)", (pid, clean(b.name), time.time())); db.commit()
    return {"id": pid, "name": clean(b.name)}

@app.patch("/api/projects/{pid}")
def rename_project(pid: str, b: Name):
    if not db.execute("UPDATE projects SET name=? WHERE id=?", (clean(b.name), pid)).rowcount: raise HTTPException(404, "Project not found")
    db.commit(); return {"ok": True}

@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    for d in db.execute("SELECT id FROM datasets WHERE project_id=?", (pid,)).fetchall(): shutil.rmtree(ds_dir(d["id"]), ignore_errors=True)
    db.execute("DELETE FROM datasets WHERE project_id=?", (pid,)); db.execute("DELETE FROM projects WHERE id=?", (pid,)); db.commit(); return {"ok": True}

@app.get("/api/datasets")
def datasets(project: str = None, q: str = ""):
    sql, a = "SELECT d.*, p.name project_name FROM datasets d JOIN projects p ON p.id=d.project_id WHERE d.filename LIKE ?", [f"%{q}%"]
    if project: sql += " AND d.project_id=?"; a.append(project)
    return [row(r) for r in db.execute(sql + " ORDER BY d.created DESC", a)]

@app.get("/api/storage")
def storage():
    used = db.execute("SELECT COALESCE(SUM(size),0) FROM datasets").fetchone()[0]; du = shutil.disk_usage(DATA)
    return {"used": used, "disk_free": du.free, "disk_total": du.total, "datasets": db.execute("SELECT COUNT(*) FROM datasets").fetchone()[0]}

# ---------- ingestion / validation ----------
def epsg_of(crs):
    try: return crs.to_epsg()
    except Exception: return None

def inspect_raster(path):
    try: src = rasterio.open(path)
    except Exception as e: raise ValueError(f"Not a readable GeoTIFF (file is corrupt, truncated or not a raster): {str(e).replace(str(path), 'file')}")
    with src:
        if src.crs is None: raise ValueError("Raster has no CRS/georeferencing. Assign a CRS (e.g. in QGIS) and re-upload.")
        try: b = transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
        except Exception as e: raise ValueError(f"Unsupported CRS, cannot reproject to WGS84: {e}")
        if not all(map(math.isfinite, b)): raise ValueError("Raster extent could not be transformed to WGS84 (unsupported CRS).")
        scale = max(1, max(src.width, src.height) / 1024)
        arr = src.read(out_shape=(src.count, int(src.height / scale) or 1, int(src.width / scale) or 1), masked=True)
        stretch = []
        for i in range(min(src.count, 3)):
            v = arr[i].compressed().astype(float); v = v[np.isfinite(v)]
            stretch.append([float(np.percentile(v, 2)), float(np.percentile(v, 98))] if v.size else [0, 1])
        elev = src.count == 1 and src.dtypes[0] != "uint8"
        if elev: stretch = [[float(arr[0].min()), float(arr[0].max())]] if arr[0].count() else [[0, 1]]
        return "dem" if elev else "raster", {
            "crs": src.crs.to_string(), "epsg": epsg_of(src.crs), "bounds": b, "width": src.width, "height": src.height,
            "bands": src.count, "dtype": src.dtypes[0], "resolution": [abs(src.res[0]), abs(src.res[1])], "nodata": src.nodata,
            "overviews": len(src.overviews(1)), "stretch": stretch, "tiled": src.is_tiled}

def reproject_geom(g, tf):
    if g["type"] == "GeometryCollection": return {**g, "geometries": [reproject_geom(x, tf) for x in g["geometries"]]}
    def rec(c): return [tf.transform(c[0], c[1])] if False else (list(tf.transform(c[0], c[1])) if not isinstance(c[0], (list, tuple)) else [rec(x) for x in c])
    return {"type": g["type"], "coordinates": rec(g["coordinates"])}

def inspect_shapezip(path, out):
    try: z = zipfile.ZipFile(path)
    except zipfile.BadZipFile: raise ValueError("File is not a valid .zip archive.")
    names = {n.lower(): n for n in z.namelist() if not n.endswith("/")}
    shps = [n for n in names if n.endswith(".shp")]
    if not shps: raise ValueError("ZIP contains no .shp file.")
    base = shps[0][:-4]; missing = [e for e in (".shx", ".dbf") if base + e not in names]
    if missing: raise ValueError(f"Shapefile is missing required component(s): {', '.join(missing)}. Zip must include .shp, .shx and .dbf (and .prj).")
    r = shapefile.Reader(shp=io.BytesIO(z.read(names[base + ".shp"])), shx=io.BytesIO(z.read(names[base + ".shx"])), dbf=io.BytesIO(z.read(names[base + ".dbf"])))
    warn, tf, epsg, crs_s = [], None, 4326, "EPSG:4326"
    if base + ".prj" in names:
        try:
            crs = CRS.from_wkt(z.read(names[base + ".prj"]).decode("utf-8", "ignore")); crs_s, epsg = crs.to_string(), crs.to_epsg()
            if not crs.equals(CRS.from_epsg(4326)): tf = Transformer.from_crs(crs, 4326, always_xy=True)
        except Exception as e: raise ValueError(f"Unsupported or invalid CRS in .prj: {e}")
    else:
        bb = r.bbox
        if not (-180 <= bb[0] <= 180 and -90 <= bb[1] <= 90 and -180 <= bb[2] <= 180 and -90 <= bb[3] <= 90):
            raise ValueError("Shapefile has no .prj and coordinates are not lon/lat. Add the .prj file and re-upload.")
        warn.append("No .prj found; assumed EPSG:4326."); crs_s = "EPSG:4326 (assumed)"
    fields = [f[0] for f in r.fields[1:]]; feats = []
    for sr in r.iterShapeRecords():
        if sr.shape.shapeType == 0: continue
        g = sr.shape.__geo_interface__
        if tf: g = reproject_geom(g, tf)
        props = {k: (v.isoformat() if hasattr(v, "isoformat") else (v.decode("utf-8", "ignore") if isinstance(v, bytes) else v)) for k, v in zip(fields, sr.record)}
        feats.append({"type": "Feature", "geometry": g, "properties": props})
    if not feats: raise ValueError("Shapefile contains no features.")
    xs = [c for f in feats for c in flat(f["geometry"]["coordinates"])]
    b = [min(c[0] for c in xs), min(c[1] for c in xs), max(c[0] for c in xs), max(c[1] for c in xs)]
    (out / "data.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
    return "vector", {"crs": crs_s, "epsg": epsg, "bounds": b, "geometry_type": r.shapeTypeName, "features": len(feats), "fields": fields, "warnings": warn}

def flat(c):
    if c and not isinstance(c[0], (list, tuple)): yield c
    else:
        for x in c: yield from flat(x)

def inspect_las(path, out):
    try:
        with laspy.open(path) as f:
            h = f.header; n = h.point_count; step = max(1, math.ceil(n / MAX_POINTS))
            has_rgb = "red" in f.header.point_format.dimension_names
            xyz, rgb, k = [], [], 0
            for ch in f.chunk_iterator(1_000_000):
                sl = slice((-k) % step, None, step); k += len(ch)
                xyz.append(np.stack([ch.x[sl], ch.y[sl], ch.z[sl]], 1))
                if has_rgb: rgb.append(np.stack([ch.red[sl], ch.green[sl], ch.blue[sl]], 1))
            crs = None
            try: crs = h.parse_crs()
            except Exception: pass
    except Exception as e: raise ValueError(f"Not a readable LAS/LAZ file (corrupt, truncated or wrong format): {str(e).replace(str(path), 'file')}")
    xyz = np.concatenate(xyz); c = (xyz.min(0) + xyz.max(0)) / 2
    if has_rgb:
        rgb = np.concatenate(rgb)
        if rgb.max() == 0: has_rgb = False  # RGB dimensions present but unpopulated -> color by height instead
        else: rgb = (rgb >> 8 if rgb.max() > 255 else rgb).astype(np.uint8)
    if not has_rgb:
        z = xyz[:, 2]; lo, hi = np.percentile(z, 1), np.percentile(z, 99); rgb = ramp((z - lo) / max(hi - lo, 1e-9))
    (out / "points.bin").write_bytes((xyz - c).astype("<f4").tobytes() + rgb.tobytes())
    meta = {"points": int(n), "preview_points": int(len(xyz)), "center": c.tolist(), "mins": list(map(float, h.mins)), "maxs": list(map(float, h.maxs)),
            "version": str(h.version), "point_format": h.point_format.id, "has_rgb": has_rgb, "crs": crs.to_string() if crs else None, "epsg": epsg_of(crs) if crs else None, "bounds": None,
            "warnings": [] if crs else ["No CRS found in file header; 3D view only, not shown on map."]}
    if crs:
        try: meta["bounds"] = list(transform_bounds(crs, "EPSG:4326", h.mins[0], h.mins[1], h.maxs[0], h.maxs[1]))
        except Exception: meta["warnings"].append("CRS could not be reprojected; not shown on map.")
    return "pointcloud", meta

@app.post("/api/projects/{pid}/upload")
async def upload(pid: str, file: UploadFile = File(...)):
    if not db.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone(): raise HTTPException(404, "Project not found")
    name = Path(file.filename or "").name; ext = Path(name).suffix.lower()
    if ext not in RASTER_EXT | LAS_EXT | {".zip"}: raise HTTPException(400, f"Unsupported file type '{ext}'. Allowed: .tif, .tiff, .zip (Shapefile), .las, .laz")
    did = uuid.uuid4().hex[:12]; out = ds_dir(did); out.mkdir(parents=True); path = out / ("original" + ext)
    try:
        with open(path, "wb") as f:
            while chunk := await file.read(4 * 1024 * 1024): f.write(chunk)
        if ext in RASTER_EXT: kind, meta = inspect_raster(path)
        elif ext in LAS_EXT: kind, meta = inspect_las(path, out)
        else: kind, meta = inspect_shapezip(path, out)
    except ValueError as e: shutil.rmtree(out, ignore_errors=True); raise HTTPException(422, str(e))
    except Exception as e: shutil.rmtree(out, ignore_errors=True); raise HTTPException(500, f"Unexpected error: {e}")
    size = path.stat().st_size
    db.execute("INSERT INTO datasets VALUES(?,?,?,?,?,?,?)", (did, pid, name, kind, size, json.dumps(meta), time.time())); db.commit()
    return {"id": did, "kind": kind}

def get_ds(did):
    r = db.execute("SELECT * FROM datasets WHERE id=?", (did,)).fetchone()
    if not r: raise HTTPException(404, "Dataset not found")
    return row(r)

@app.delete("/api/datasets/{did}")
def delete_ds(did: str):
    get_ds(did); shutil.rmtree(ds_dir(did), ignore_errors=True); db.execute("DELETE FROM datasets WHERE id=?", (did,)); db.commit(); return {"ok": True}

@app.get("/api/datasets/{did}/download")
def download(did: str):
    d = get_ds(did); p = next(ds_dir(did).glob("original.*")); return FileResponse(p, filename=d["filename"])

@app.get("/api/datasets/{did}/geojson")
def geojson(did: str): get_ds(did); return FileResponse(ds_dir(did) / "data.geojson", media_type="application/geo+json")

@app.get("/api/datasets/{did}/points")
def points(did: str): get_ds(did); return FileResponse(ds_dir(did) / "points.bin", media_type="application/octet-stream")

# ---------- on-the-fly raster tiles (windowed reads use overviews; no preprocessing) ----------
def tile_bounds(z, x, y):
    s = 2 * 20037508.342789244 / 2 ** z; return (-20037508.342789244 + x * s, 20037508.342789244 - (y + 1) * s, -20037508.342789244 + (x + 1) * s, 20037508.342789244 - y * s)
EMPTY = io.BytesIO(); Image.new("RGBA", (256, 256)).save(EMPTY, "PNG")

@app.get("/api/datasets/{did}/tiles/{z}/{x}/{y}.png")
def tile(did: str, z: int, x: int, y: int):
    d = get_ds(did); m = d["meta"]; path = next(ds_dir(did).glob("original.*"))
    hdr = {"Cache-Control": "public, max-age=3600"}
    try:
        with rasterio.open(path) as src:
            bb = tile_bounds(z, x, y); idx = list(range(1, min(src.count, 3) + 1))
            with WarpedVRT(src, crs="EPSG:3857", transform=from_bounds(*bb, 256, 256), width=256, height=256, resampling=Resampling.bilinear, add_alpha=src.count != 4) as vrt:
                data = vrt.read(idx, masked=False).astype(float); alpha = vrt.read(vrt.count) > 0  # last band: added alpha, or the source's own alpha for 4-band RGBA
                st = m["stretch"]
            if len(idx) == 1:
                lo, hi = st[0]; rgb = ramp((data[0] - lo) / max(hi - lo, 1e-9))
            else:
                rgb = np.stack([np.clip((data[i] - st[i][0]) / max(st[i][1] - st[i][0], 1e-9), 0, 1) * 255 if src.dtypes[0] != "uint8" else data[i] for i in range(min(3, len(idx)))], -1).astype(np.uint8)
                if rgb.shape[-1] == 2: rgb = np.concatenate([rgb, rgb[..., :1]], -1)
            img = Image.fromarray(np.dstack([rgb, (alpha * 255).astype(np.uint8)]), "RGBA"); buf = io.BytesIO(); img.save(buf, "PNG")
            return Response(buf.getvalue(), media_type="image/png", headers=hdr)
    except Exception as e: raise HTTPException(500, f"Tile error: {e}")

app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
