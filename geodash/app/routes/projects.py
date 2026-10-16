import shutil
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, files
from ..db import get_db, new_id

router = APIRouter(prefix="/api")


class Name(BaseModel):
    name: str


def clean(n: str) -> str:
    n = n.strip()
    if not n:
        raise HTTPException(400, "Project name cannot be empty")
    return n[:120]


@router.get("/projects")
def list_projects(db=Depends(get_db)):
    out = []
    for p in db.execute("SELECT * FROM projects ORDER BY created DESC"):
        s = db.execute("SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM datasets WHERE project_id=?", (p["id"],)).fetchone()
        out.append({**dict(p), "datasets": s["c"], "size": s["s"]})
    return out


@router.post("/projects")
def create_project(b: Name, db=Depends(get_db)):
    pid, name = new_id(), clean(b.name)
    db.execute("INSERT INTO projects VALUES(?,?,?)", (pid, name, time.time()))
    return {"id": pid, "name": name}


@router.patch("/projects/{pid}")
def rename_project(pid: str, b: Name, db=Depends(get_db)):
    if not db.execute("UPDATE projects SET name=? WHERE id=?", (clean(b.name), pid)).rowcount:
        raise HTTPException(404, "Project not found")
    return {"ok": True}


@router.delete("/projects/{pid}")
def delete_project(pid: str, db=Depends(get_db)):
    if not db.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone():
        raise HTTPException(404, "Project not found")
    for d in db.execute("SELECT id FROM datasets WHERE project_id=?", (pid,)).fetchall():
        shutil.rmtree(files.ds_dir(d["id"]), ignore_errors=True)
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    return {"ok": True}


@router.get("/storage")
def storage(db=Depends(get_db)):
    used = db.execute("SELECT COALESCE(SUM(size),0) FROM datasets").fetchone()[0]
    du = shutil.disk_usage(config.DATA)
    return {"used": used, "disk_free": du.free, "disk_total": du.total,
            "datasets": db.execute("SELECT COUNT(*) FROM datasets").fetchone()[0]}
