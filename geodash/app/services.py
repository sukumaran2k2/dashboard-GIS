"""Shared DB-backed helpers for the route modules."""
import json
import time

from fastapi import HTTPException

from . import georef as G
from . import render
from .db import dataset_dict, dumps, transaction

CATEGORIES = ["orthomosaic", "dem", "dsm", "dtm", "raster", "vector", "pointcloud", "other"]


def get_ds(db, did):
    r = db.execute("SELECT * FROM datasets WHERE id=?", (did,)).fetchone()
    if not r:
        raise HTTPException(404, "Dataset not found")
    return dataset_dict(r)


def get_georef(db, did):
    r = db.execute("SELECT * FROM georef WHERE dataset_id=?", (did,)).fetchone()
    if not r:
        return None
    g = json.loads(r["data"])
    g["version"] = r["version"]
    return g


def public(ds, g):
    """Dataset as sent to the browser, including its effective georeferencing summary."""
    res = G.resolve(ds, g)
    version = g["version"] if g else 0
    summary = {"status": res.state, "method": res.method, "version": version, "local": res.local, "bounds_wgs84": None,
               "crs": None, "epsg": None}
    if res.state == "ready":
        summary["bounds_wgs84"] = render._eff_bounds(ds["id"], version, ds, g)
        from pyproj import CRS
        from . import crs as C
        crs = CRS.from_wkt(res.w_wkt)
        summary.update(crs=C.label(crs), epsg=C.epsg(crs))
    d = {k: v for k, v in ds.items()}
    d["georef"] = summary
    d["effective_status"] = res.state
    return d


def save_georef(db, ds, prev, g, note):
    """Verifies, stores the new georeference and records the previous state in history."""
    ver_prev = prev["version"] if prev else 0
    version = max(ver_prev + 1, int(time.time() * 1000))
    v = G.verify(ds, g)
    if not v["passed"]:
        raise HTTPException(500, f"Georeferencing verification failed (round-trip error {v['max_roundtrip_error_m']:.6f} m); nothing was saved.")
    g = {k: val for k, val in g.items() if k != "version"}
    g["verification"] = v
    now = time.time()
    prev_data = json.dumps({k: val for k, val in prev.items() if k != "version"}) if prev else None
    with transaction(db):
        db.execute("INSERT INTO georef_history(dataset_id,data,note,created) VALUES(?,?,?,?)", (ds["id"], prev_data, note, now))
        db.execute("INSERT INTO georef(dataset_id,version,data,updated) VALUES(?,?,?,?) "
                   "ON CONFLICT(dataset_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated=excluded.updated",
                   (ds["id"], version, dumps(g), now))
    g["version"] = version
    return g


def clear_georef(db, ds, prev, note):
    if prev:
        with transaction(db):
            db.execute("INSERT INTO georef_history(dataset_id,data,note,created) VALUES(?,?,?,?)",
                       (ds["id"], json.dumps({k: val for k, val in prev.items() if k != "version"}), note, time.time()))
            db.execute("DELETE FROM georef WHERE dataset_id=?", (ds["id"],))
