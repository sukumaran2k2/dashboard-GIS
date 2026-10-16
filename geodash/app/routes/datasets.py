import json
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .. import config, files, render
from .. import georef as G
from ..db import dumps, get_db, new_id
from ..errors import GeorefError, IngestError
from ..ingest import ingest, supported_formats
from ..ingest.vector import MAX_MAP_FEATURES
from ..services import CATEGORIES, get_georef, get_ds, public

router = APIRouter(prefix="/api")


@router.get("/formats")
def formats():
    return supported_formats()


@router.get("/datasets")
def list_datasets(project: str | None = None, q: str = "", kind: str | None = None, category: str | None = None,
                  status: str | None = None, db=Depends(get_db)):
    sql = ("SELECT d.*, p.name project_name FROM datasets d JOIN projects p ON p.id=d.project_id "
           "WHERE d.filename LIKE ?")
    args = [f"%{q}%"]
    for col, val in (("d.project_id", project), ("d.kind", kind), ("d.category", category), ("d.status", status)):
        if val:
            sql += f" AND {col}=?"
            args.append(val)
    out = []
    for r in db.execute(sql + " ORDER BY d.created DESC", args):
        ds = {**dict(r), "meta": json.loads(r["meta"])}
        out.append(public(ds, get_georef(db, ds["id"])))
    return out


@router.get("/datasets/{did}")
def get_dataset(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    pr = db.execute("SELECT name FROM projects WHERE id=?", (ds["project_id"],)).fetchone()
    d = public(ds, get_georef(db, did))
    d["project_name"] = pr["name"] if pr else None
    return d


class Patch(BaseModel):
    category: str | None = None
    filename: str | None = None
    notes: str | None = None


@router.patch("/datasets/{did}")
def patch_dataset(did: str, b: Patch, db=Depends(get_db)):
    ds = get_ds(db, did)
    if b.category is not None:
        if b.category not in CATEGORIES:
            raise HTTPException(400, f"Category must be one of: {', '.join(CATEGORIES)}")
        db.execute("UPDATE datasets SET category=? WHERE id=?", (b.category, did))
    if b.filename is not None:
        name = Path(b.filename.strip()).name
        if not name:
            raise HTTPException(400, "Name cannot be empty")
        db.execute("UPDATE datasets SET filename=? WHERE id=?", (name[:200], did))
    if b.notes is not None:
        db.execute("UPDATE datasets SET notes=? WHERE id=?", (b.notes.strip()[:2000], did))
    return {"ok": True}


@router.delete("/datasets/{did}")
def delete_dataset(did: str, db=Depends(get_db)):
    get_ds(db, did)
    shutil.rmtree(files.ds_dir(did), ignore_errors=True)
    db.execute("DELETE FROM datasets WHERE id=?", (did,))
    return {"ok": True}


@router.post("/projects/{pid}/upload")
async def upload(pid: str, file: UploadFile = File(...), db=Depends(get_db)):
    if not db.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone():
        raise HTTPException(404, "Project not found")
    name = Path(file.filename or "").name
    ext = Path(name).suffix.lower()
    if not name:
        raise HTTPException(400, "File has no name")
    did = new_id()
    out = files.ds_dir(did)
    out.mkdir(parents=True)
    path = out / ("original" + ext)
    try:
        import hashlib
        h, size = hashlib.sha256(), 0
        with open(path, "wb") as f:
            while chunk := await file.read(4 * 1024 * 1024):
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"File exceeds the {config.MAX_UPLOAD_BYTES // 1024**3} GB upload limit.")
                h.update(chunk)
                f.write(chunk)
        insp = await run_in_threadpool(ingest, path, out, name)
    except HTTPException:
        shutil.rmtree(out, ignore_errors=True)
        raise
    except IngestError as e:
        shutil.rmtree(out, ignore_errors=True)
        raise HTTPException(422, str(e))
    except Exception as e:
        shutil.rmtree(out, ignore_errors=True)
        raise HTTPException(500, f"Unexpected error while reading the file: {e}")
    db.execute("INSERT INTO datasets(id,project_id,filename,ext,kind,category,status,size,sha256,meta,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
               (did, pid, name, ext, insp.kind, insp.category, insp.status, size, h.hexdigest(), dumps(insp.meta), time.time()))
    return public(get_ds(db, did), None)


@router.get("/datasets/{did}/download")
def download(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    p = files.ds_dir(did) / f"original{ds['ext']}"
    if not p.exists():
        raise HTTPException(404, "Original file is missing")
    return FileResponse(p, filename=ds["filename"])


@router.get("/datasets/{did}/integrity")
def integrity(did: str, db=Depends(get_db)):
    """Proves the uploaded file was not modified by any georeferencing action."""
    ds = get_ds(db, did)
    p = files.ds_dir(did) / f"original{ds['ext']}"
    now = files.sha256_file(p)
    return {"sha256_at_upload": ds["sha256"], "sha256_now": now, "unchanged": now == ds["sha256"]}


@router.get("/datasets/{did}/geojson")
def geojson(did: str, frame: str = "map", db=Depends(get_db)):
    ds = get_ds(db, did)
    if ds["kind"] != "vector":
        raise HTTPException(400, "Not a vector dataset")
    if ds["meta"]["features"] > MAX_MAP_FEATURES:
        raise HTTPException(413, f"{ds['meta']['features']:,} features is too many to draw in the browser. Export or filter instead.")
    if frame == "native":
        return JSONResponse(render.native_geojson(did, ds))
    g = get_georef(db, did)
    if G.resolve(ds, g).state != "ready":
        raise HTTPException(409, "Dataset has no ground coordinates yet. Assign a CRS or place it on the map.")
    return FileResponse(render.effective_geojson(did, ds, g), media_type="application/geo+json")


@router.get("/datasets/{did}/features")
def features(did: str, offset: int = 0, limit: int = 100, db=Depends(get_db)):
    ds = get_ds(db, did)
    if ds["kind"] != "vector":
        raise HTTPException(400, "Not a vector dataset")
    names, rows = render.feature_rows(did, ds, max(0, offset), min(max(1, limit), 1000))
    return {"fields": names, "rows": rows, "total": ds["meta"]["features"], "offset": offset}


@router.get("/datasets/{did}/points")
def points(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    if ds["kind"] != "pointcloud":
        raise HTTPException(400, "Not a point cloud")
    return FileResponse(files.ds_dir(did) / "points.bin", media_type="application/octet-stream")


@router.get("/datasets/{did}/image.png")
def image(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    if ds["kind"] == "pointcloud":
        return FileResponse(files.ds_dir(did) / "topdown.png", media_type="image/png")
    if ds["kind"] == "raster":
        return FileResponse(render.raster_preview(did, ds), media_type="image/png")
    raise HTTPException(400, "No image for this dataset type")


@router.get("/datasets/{did}/tiles/{z}/{x}/{y}.png")
def tile(did: str, z: int, x: int, y: int, v: int = 0, db=Depends(get_db)):
    ds = get_ds(db, did)
    if ds["kind"] != "raster":
        raise HTTPException(400, "Not a raster dataset")
    if not (0 <= z <= 24 and 0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(404, "Tile out of range")
    g = get_georef(db, did)
    try:
        png = render.render_tile(did, ds, g, z, x, y)
    except GeorefError as e:
        raise HTTPException(409, str(e))
    except Exception as e:
        raise HTTPException(500, f"Tile error: {e}")
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})
