"""Background export jobs. One worker at a time keeps memory use predictable on small machines."""
import json
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import files
from . import georef as G
from .db import connection, dumps, new_id
from .errors import ExportError
from .export import run as run_export
from .services import get_ds, get_georef

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="export")


def _update(job_id, **kw):
    kw["updated"] = time.time()
    cols = ", ".join(f"{k}=?" for k in kw)
    with connection() as db:
        db.execute(f"UPDATE jobs SET {cols} WHERE id=?", [*kw.values(), job_id])


def submit_export(did, fmt, crs_text):
    job_id = new_id()
    now = time.time()
    with connection() as db:
        db.execute("INSERT INTO jobs(id,dataset_id,kind,state,progress,message,params,created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
                   (job_id, did, "export", "queued", 0.0, "Queued", dumps({"format": fmt, "crs": crs_text}), now, now))
    _executor.submit(_run, job_id)
    return job_id


def _safe_base(name):
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).stem).strip("._") or "export"
    return stem[:80] + "_export"


def _run(job_id):
    out_dir = None
    try:
        with connection() as db:
            job = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            params = json.loads(job["params"])
            ds = get_ds(db, job["dataset_id"])
            g = get_georef(db, ds["id"])
        res = G.resolve(ds, g)
        out_dir = files.ds_dir(ds["id"]) / "exports" / job_id
        last = [0.0]

        def progress(frac, msg):
            now = time.time()
            if now - last[0] > 0.4 or frac >= 0.99:
                last[0] = now
                _update(job_id, progress=float(min(max(frac, 0.0), 0.99)), message=msg)

        _update(job_id, state="running", message="Starting")
        path, report = run_export(ds, g, res, params["format"], params.get("crs"), out_dir, progress, _safe_base(ds["filename"]))
        rd = report.to_dict()
        ok = rd["overall"] != "FAIL"
        size = path.stat().st_size if ok and path.exists() else 0
        if not ok:
            shutil.rmtree(out_dir, ignore_errors=True)
        _update(job_id, state="done", progress=1.0, message="Finished",
                result=dumps({"filename": path.name, "size": size, "downloadable": ok, "report": rd,
                              "path": f"exports/{job_id}/{path.name}" if ok else None}))
    except ExportError as e:
        if out_dir:
            shutil.rmtree(out_dir, ignore_errors=True)
        _update(job_id, state="failed", error=str(e), message="Failed")
    except Exception as e:
        if out_dir:
            shutil.rmtree(out_dir, ignore_errors=True)
        _update(job_id, state="failed", error=f"Unexpected error: {e}", message="Failed")


def job_dict(r):
    d = dict(r)
    for k in ("params", "result"):
        d[k] = json.loads(d[k]) if d.get(k) else None
    if d["result"]:
        d["result"].pop("path", None)
    return d
