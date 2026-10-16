import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import files, jobs
from .. import georef as G
from ..db import get_db
from ..export import targets_for
from ..services import get_ds, get_georef

router = APIRouter(prefix="/api")


@router.get("/datasets/{did}/export/targets")
def export_targets(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    res = G.resolve(ds, get_georef(db, did))
    return targets_for(ds, res)


class ExportBody(BaseModel):
    format: str
    crs: str | None = None


@router.post("/datasets/{did}/export")
def start_export(did: str, b: ExportBody, db=Depends(get_db)):
    ds = get_ds(db, did)
    res = G.resolve(ds, get_georef(db, did))
    match = next((t for t in targets_for(ds, res) if t["format"] == b.format), None)
    if match is None:
        raise HTTPException(422, f"Unknown export format '{b.format}' for a {ds['kind']} dataset.")
    if not match["available"]:
        raise HTTPException(422, match["reason"] or "This export is not available.")
    return {"job_id": jobs.submit_export(did, b.format, (b.crs or "").strip() or None)}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db=Depends(get_db)):
    r = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Job not found")
    return jobs.job_dict(r)


@router.get("/jobs")
def list_jobs(dataset: str | None = None, db=Depends(get_db)):
    sql = ("SELECT j.*, d.filename AS dataset_filename, d.project_id AS project_id "
           "FROM jobs j LEFT JOIN datasets d ON d.id=j.dataset_id")
    args = []
    if dataset:
        sql += " WHERE j.dataset_id=?"
        args.append(dataset)
    return [jobs.job_dict(r) for r in db.execute(sql + " ORDER BY j.created DESC LIMIT 100", args)]


@router.get("/jobs/{job_id}/download")
def download_job(job_id: str, db=Depends(get_db)):
    r = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not r:
        raise HTTPException(404, "Job not found")
    result = json.loads(r["result"]) if r["result"] else None
    if r["state"] != "done" or not result or not result["downloadable"] or not result.get("path"):
        raise HTTPException(409, "This export did not pass validation, so no file is available.")
    p = files.ds_dir(r["dataset_id"]) / result["path"]
    if not p.exists():
        raise HTTPException(404, "Exported file is missing")
    return FileResponse(p, filename=result["filename"])
