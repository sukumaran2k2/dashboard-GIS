from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pyproj import CRS

from .. import crs as C
from .. import georef as G
from ..db import get_db
from ..errors import GeorefError
from ..services import clear_georef, get_ds, get_georef, public, save_georef

router = APIRouter(prefix="/api")


class GeorefBody(BaseModel):
    mode: Literal["assign", "place", "gcp"]
    crs: str | None = None
    grid: dict | None = None                    # assign: raster {origin_x, origin_y, pixel_x, pixel_y?}
    anchor: dict | None = None                  # place: {lon, lat} or {x, y, crs}
    rotation_deg: float = 0.0
    scale: float = 1.0
    z_offset: float = 0.0
    pixel_size: float | list[float] | dict | None = None
    points: list[dict] | None = None            # gcp: [{col, row, x, y}]
    confirm_outside_area: bool = False
    note: str | None = None


def build(ds, prev, b: GeorefBody):
    try:
        if b.mode == "assign":
            if not b.crs:
                raise GeorefError("Choose a CRS.")
            return G.build_assign(ds, b.crs, grid=b.grid, confirm_outside_area=b.confirm_outside_area), "Assigned CRS " + b.crs
        if b.mode == "place":
            g = G.build_place(ds, b.anchor, prev=prev, crs_text=b.crs, rotation_deg=b.rotation_deg, scale=b.scale,
                              z_offset=b.z_offset, pixel_size=b.pixel_size)
            return g, f"Placed (rotation {b.rotation_deg:g} deg)"
        if not b.crs:
            raise GeorefError("Choose the CRS of the control point coordinates.")
        return G.build_gcp(ds, b.crs, b.points, confirm_outside_area=b.confirm_outside_area), f"Control points ({len(b.points or [])})"
    except GeorefError as e:
        raise HTTPException(422, str(e))


def view(ds, g):
    out = G.summarize(ds, g)
    out["dataset"] = {"id": ds["id"], "kind": ds["kind"], "status": ds["status"]}
    return out


@router.get("/datasets/{did}/georef")
def get_georef_state(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    out = view(ds, get_georef(db, did))
    out["history"] = [dict(r) for r in db.execute(
        "SELECT id, note, created, data IS NULL AS as_uploaded FROM georef_history WHERE dataset_id=? ORDER BY id DESC", (did,))]
    return out


@router.post("/datasets/{did}/georef/preview")
def preview(did: str, b: GeorefBody, db=Depends(get_db)):
    """Computes exactly what saving would produce, without saving."""
    ds = get_ds(db, did)
    g, _ = build(ds, get_georef(db, did), b)
    g["version"] = -1
    out = view(ds, g)
    out["verification"] = G.verify(ds, g)
    return out


@router.put("/datasets/{did}/georef")
def put_georef(did: str, b: GeorefBody, db=Depends(get_db)):
    ds = get_ds(db, did)
    prev = get_georef(db, did)
    g, note = build(ds, prev, b)
    g = save_georef(db, ds, prev, g, b.note or note)
    out = view(ds, g)
    out["dataset"] = public(ds, g)
    return out


@router.delete("/datasets/{did}/georef")
def reset_georef(did: str, db=Depends(get_db)):
    ds = get_ds(db, did)
    clear_georef(db, ds, get_georef(db, did), "Reverted to as-uploaded")
    return view(ds, None)


@router.post("/datasets/{did}/georef/restore/{hid}")
def restore(did: str, hid: int, db=Depends(get_db)):
    import json
    ds = get_ds(db, did)
    row = db.execute("SELECT * FROM georef_history WHERE id=? AND dataset_id=?", (hid, did)).fetchone()
    if not row:
        raise HTTPException(404, "History entry not found")
    prev = get_georef(db, did)
    if row["data"] is None:
        clear_georef(db, ds, prev, "Restored as-uploaded state")
        return view(ds, None)
    g = save_georef(db, ds, prev, json.loads(row["data"]), f"Restored version from {int(row['created'])}")
    return view(ds, g)


# ---------------------------------------------------------------------------------------- CRS tools
@router.get("/crs/search")
def crs_search(q: str = "", lon: float | None = None, lat: float | None = None, limit: int = 40):
    return C.search(q, lon, lat, min(limit, 100))


@router.get("/crs/utm")
def crs_utm(lon: float, lat: float):
    try:
        crs = C.utm_for(lon, lat)
    except C.CRSError as e:
        raise HTTPException(422, str(e))
    return C.describe(crs)


@router.get("/crs/describe")
def crs_describe(text: str):
    try:
        return C.describe(C.parse(text))
    except C.CRSError as e:
        raise HTTPException(422, str(e))


class MeasureBody(BaseModel):
    points: list[list[float]]          # [[lon, lat], ...] in WGS84


@router.post("/measure")
def measure(b: MeasureBody):
    """Geodesic length (and enclosed area for 3+ points) on the WGS84 ellipsoid (Karney's algorithm via pyproj)."""
    import math
    from pyproj import Geod
    pts = b.points
    if not 2 <= len(pts) <= 5000:
        raise HTTPException(422, "Provide between 2 and 5000 points.")
    for p in pts:
        if len(p) < 2 or not (math.isfinite(p[0]) and math.isfinite(p[1])) or not (-180 <= p[0] <= 180 and -90 <= p[1] <= 90):
            raise HTTPException(422, "Points must be [longitude, latitude] in degrees.")
    geod = Geod(ellps="WGS84")
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    segments = [float(geod.inv(lons[i], lats[i], lons[i + 1], lats[i + 1])[2]) for i in range(len(pts) - 1)]
    out = {"length_m": float(sum(segments)), "segments_m": segments, "ellipsoid": "WGS84", "area_m2": None, "perimeter_m": None}
    if len(pts) >= 3:
        area, perim = geod.polygon_area_perimeter(lons, lats)
        out["area_m2"], out["perimeter_m"] = abs(float(area)), float(perim)
    return out


class TransformBody(BaseModel):
    source: str
    target: str
    points: list[list[float]]


@router.post("/crs/transform")
def crs_transform(b: TransformBody):
    """Coordinate conversion for the coordinate-entry fields (lon/lat <-> easting/northing)."""
    try:
        s, t = C.parse(b.source), C.parse(b.target)
    except C.CRSError as e:
        raise HTTPException(422, str(e))
    if not b.points or len(b.points) > 10000:
        raise HTTPException(422, "Provide between 1 and 10000 points.")
    import numpy as np
    pts = np.array(b.points, float)
    if pts.ndim != 2 or pts.shape[1] < 2:
        raise HTTPException(422, "Points must be [x, y] pairs.")
    x, y = C.transformer(C.wkt(s), C.wkt(t)).transform(pts[:, 0], pts[:, 1])
    if not (np.isfinite(x).all() and np.isfinite(y).all()):
        raise HTTPException(422, "Some points cannot be expressed in the target CRS.")
    return {"points": np.column_stack([x, y]).tolist(), "notes": C.transform_notes(s, t)}
