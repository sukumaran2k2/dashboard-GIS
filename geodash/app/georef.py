"""Georeferencing engine.

Model
-----
Every dataset has a *native frame*: coordinates exactly as stored in the uploaded file (never modified).
A georeference override maps that frame into a working CRS W:

    native coords (in CRS B)  --pyproj-->  W  --rigid motion A-->  final coords in W

    A(p) = target + scale * R(rotation) * (p - pivot)        (rotation counter-clockwise on the map)

* B is the CRS of the file's coordinates (its own CRS, a CRS the user assigned, or - for data with no known
  coordinates - the working CRS itself, flagged `local`).
* Rasters (and the top-down image of a point cloud) additionally carry a `base_affine` (pixel -> B) when the file
  has no usable transform or when it was fitted from control points.
* Rasters keep B == W so the placement stays an exact affine transform of the pixel grid (no resampling).
"""
import math
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from affine import Affine
from pyproj import CRS

from . import crs as C
from . import geo
from .errors import GeorefError


# ----------------------------------------------------------------------------- native frame helpers
def native_base(ds, g):
    """pixel -> B affine for rasters and point-cloud top-down images; None for vectors / image-only rasters."""
    meta = ds["meta"]
    if ds["kind"] == "raster":
        if g and g.get("base_affine"):
            return Affine(*g["base_affine"])
        a = meta.get("affine")
        return Affine(*a) if a else None
    if ds["kind"] == "pointcloud":
        return Affine(*meta["topdown"]["affine"])
    return None


def native_frame(ds, g):
    """Four corners (TL, TR, BR, BL) of the dataset footprint in B coordinates, or None when unknown."""
    meta = ds["meta"]
    if ds["kind"] == "raster":
        base = native_base(ds, g)
        if base is None:
            return None
        w, h = meta["width"], meta["height"]
        return [list(base @ (0, 0)), list(base @ (w, 0)), list(base @ (w, h)), list(base @ (0, h))]
    return meta["native"]["frame"]


def rigid(pivot, target, rotation_deg, scale) -> Affine:
    return (Affine.translation(*target) @ Affine.rotation(rotation_deg) @ Affine.scale(scale)
            @ Affine.translation(-pivot[0], -pivot[1]))


@lru_cache(maxsize=512)
def _same_crs(a: str, b: str) -> bool:
    return a == b or C.horizontal(CRS.from_wkt(a)).equals(C.horizontal(CRS.from_wkt(b)))


# ----------------------------------------------------------------------------- resolved (effective) state
@dataclass
class Resolved:
    state: str                    # ready | unreferenced
    method: str                   # native | assigned | placed | gcp | none
    b_wkt: str | None = None
    w_wkt: str | None = None
    local: bool = False
    base: Affine | None = None
    A: Affine = Affine.identity()
    scale: float = 1.0
    z_offset: float = 0.0
    frame_native: list | None = None

    @property
    def crs_same(self):
        return self.b_wkt is None or self.w_wkt is None or _same_crs(self.b_wkt, self.w_wkt)

    def forward(self, x, y):
        """native (B) coords -> final (W) coords."""
        x, y = np.asarray(x, float), np.asarray(y, float)
        if not self.crs_same:
            x, y = C.transformer(self.b_wkt, self.w_wkt).transform(x, y)
        a, b, c, d, e, f = self.A[:6]
        return a * x + b * y + c, d * x + e * y + f

    def inverse(self, x, y):
        x, y = np.asarray(x, float), np.asarray(y, float)
        a, b, c, d, e, f = (~self.A)[:6]
        x, y = a * x + b * y + c, d * x + e * y + f
        if not self.crs_same:
            x, y = C.transformer(self.w_wkt, self.b_wkt).transform(x, y)
        return x, y

    def z(self, z):
        return np.asarray(z, float) * self.scale + self.z_offset

    @property
    def frame_w(self):
        if self.frame_native is None or self.state != "ready":
            return None
        fx, fy = self.forward([p[0] for p in self.frame_native], [p[1] for p in self.frame_native])
        return [[float(a), float(b)] for a, b in zip(fx, fy)]

    @property
    def raster_affine(self):
        """pixel -> W, exact (rasters only; requires B == W)."""
        return self.A @ self.base if self.base is not None else None

    @property
    def rotation_deg(self):
        return math.degrees(math.atan2(self.A.d, self.A.a)) if self.A != Affine.identity() else 0.0


def resolve(ds, g) -> Resolved:
    meta = ds["meta"]
    nat = meta["native"]
    if g is None:
        if ds["status"] != "ready":
            return Resolved("unreferenced", "none", frame_native=native_frame(ds, None))
        return Resolved("ready", "native", b_wkt=nat["crs_wkt"], w_wkt=nat["crs_wkt"], base=native_base(ds, None),
                        frame_native=native_frame(ds, None))
    A = rigid(g["pivot"], g["target"], g["rotation_deg"], g["scale"])
    return Resolved("ready", g["method"], b_wkt=g["source_crs_wkt"], w_wkt=g["work_crs_wkt"], local=g.get("local", False),
                    base=native_base(ds, g), A=A, scale=g["scale"], z_offset=g["z_offset"],
                    frame_native=native_frame(ds, g))


# ----------------------------------------------------------------------------- validation helpers
def _area_check(crs: CRS, bounds):
    """Compare the data's WGS84 bounds with the CRS area of use."""
    aoi = C.horizontal(crs).area_of_use
    if not aoi or bounds is None or aoi.west > aoi.east:
        return "unknown", None
    ab = [aoi.west, aoi.south, aoi.east, aoi.north]
    if bounds[2] < ab[0] or bounds[0] > ab[2] or bounds[3] < ab[1] or bounds[1] > ab[3]:
        return "outside", aoi.name
    inside = bounds[0] >= ab[0] - 1e-6 and bounds[1] >= ab[1] - 1e-6 and bounds[2] <= ab[2] + 1e-6 and bounds[3] <= ab[3] + 1e-6
    return ("inside" if inside else "partial"), aoi.name


def _num(v, name, default=None, lo=None, hi=None):
    if v is None:
        if default is None:
            raise GeorefError(f"'{name}' is required.")
        return default
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise GeorefError(f"'{name}' must be a number.")
    if not math.isfinite(v):
        raise GeorefError(f"'{name}' must be a finite number.")
    if lo is not None and v < lo or hi is not None and v > hi:
        raise GeorefError(f"'{name}' must be between {lo} and {hi}.")
    return v


def _parse_crs(text, what="CRS"):
    try:
        return C.parse(text)
    except C.CRSError as e:
        raise GeorefError(f"{what}: {e}")


def _pixel_size(v):
    if isinstance(v, (int, float)):
        px = py = float(v)
    elif isinstance(v, (list, tuple)) and len(v) == 2:
        px, py = float(v[0]), float(v[1])
    elif isinstance(v, dict):
        px, py = float(v.get("x")), float(v.get("y", v.get("x")))
    else:
        raise GeorefError("Pixel size is required for an image without ground coordinates.")
    if not (px > 0 and py > 0 and math.isfinite(px) and math.isfinite(py)):
        raise GeorefError("Pixel size must be a positive number.")
    return px, py


def _frame_bounds(ds, base, w_wkt, b_wkt, frame, A):
    fx = [p[0] for p in frame]
    fy = [p[1] for p in frame]
    res = Resolved("ready", "x", b_wkt=b_wkt, w_wkt=w_wkt, A=A, frame_native=frame)
    px, py = res.forward(fx, fy)
    return geo.bounds_wgs84(w_wkt, [[a, b] for a, b in zip(px, py)])


# ----------------------------------------------------------------------------- builders
def build_assign(ds, crs_text, grid=None, confirm_outside_area=False):
    """The file's coordinates ARE in `crs_text`; record that (no movement). Needed for data with a missing/wrong CRS."""
    crs = _parse_crs(crs_text)
    wkt = C.wkt(crs)
    base = None
    if ds["kind"] == "raster":
        if ds["meta"].get("affine") is None:
            if not grid:
                raise GeorefError("This image has no ground transform. Enter the top-left coordinate and the pixel size, "
                                  "place it on the map, or use control points.")
            ox, oy = _num(grid.get("origin_x"), "origin_x"), _num(grid.get("origin_y"), "origin_y")
            px, py = _pixel_size({"x": grid.get("pixel_x"), "y": grid.get("pixel_y", grid.get("pixel_x"))})
            base = Affine(px, 0, ox, 0, -py, oy)
    g = {"method": "assigned", "work_crs_wkt": wkt, "source_crs_wkt": wkt, "local": False,
         "base_affine": list(base)[:6] if base is not None else None,
         "pivot": [0.0, 0.0], "target": [0.0, 0.0], "rotation_deg": 0.0, "scale": 1.0, "z_offset": 0.0,
         "params": {"crs": C.label(crs), "grid": grid}, "gcp": None}
    frame = native_frame(ds, g)
    if frame is None:
        raise GeorefError("Cannot determine the dataset extent.")
    bw = geo.bounds_wgs84(wkt, frame)
    if bw is None:
        raise GeorefError(f"The coordinates do not make sense in {C.label(crs)}: the extent cannot be expressed "
                          "in longitude/latitude. Choose a different CRS.")
    status, area = _area_check(crs, bw)
    g["area_check"] = status
    if status == "outside" and not confirm_outside_area:
        raise GeorefError(f"The data falls outside the area where {C.label(crs)} is defined ({area}). "
                          "That CRS is almost certainly wrong. Choose another, or confirm explicitly to override.")
    c = geo.centroid(frame)
    g["pivot"] = g["target"] = c
    return g


def build_place(ds, anchor, prev=None, crs_text=None, rotation_deg=0.0, scale=1.0, z_offset=0.0, pixel_size=None):
    """Put the footprint centre at `anchor`, rotated about that centre."""
    kind = ds["kind"]
    nat_crs = ds["meta"]["native"].get("crs_wkt")
    rotation_deg = _num(rotation_deg, "rotation_deg", 0.0)
    scale = _num(scale, "scale", 1.0, lo=1e-9)
    z_offset = _num(z_offset, "z_offset", 0.0)
    if not isinstance(anchor, dict):
        raise GeorefError("An anchor position is required.")

    # source CRS B
    if prev and not prev.get("local"):
        b_wkt, local = prev["source_crs_wkt"], False
    elif nat_crs:
        b_wkt, local = nat_crs, False
    else:
        b_wkt, local = None, True

    # anchor
    if "lon" in anchor and "lat" in anchor:
        lon, lat = _num(anchor["lon"], "lon", lo=-180, hi=180), _num(anchor["lat"], "lat", lo=-90, hi=90)
        a_crs = CRS.from_epsg(4326)
        ax, ay = lon, lat
    elif "x" in anchor and "y" in anchor:
        ax, ay = _num(anchor["x"], "x"), _num(anchor["y"], "y")
        a_crs = _parse_crs(anchor.get("crs") or crs_text or (prev or {}).get("work_crs_wkt") or nat_crs, "Anchor CRS")
        lo, la = geo.to_wgs84(C.wkt(a_crs), [ax], [ay])
        lon, lat = float(lo[0]), float(la[0])
        if not (math.isfinite(lon) and math.isfinite(lat)):
            raise GeorefError("The anchor coordinates are not valid in that CRS.")
    else:
        raise GeorefError("Anchor must be {lon, lat} or {x, y, crs}.")

    # working CRS W
    if kind == "raster" and not local:
        w_crs = CRS.from_wkt(b_wkt)
        if crs_text and not _same_crs(C.wkt(_parse_crs(crs_text)), b_wkt):
            raise GeorefError("A raster keeps its own CRS when moved (it is not resampled). "
                              f"Use {C.label(w_crs)} or leave the CRS blank.")
    elif crs_text:
        w_crs = _parse_crs(crs_text)
    elif prev and prev.get("work_crs_wkt"):
        w_crs = CRS.from_wkt(prev["work_crs_wkt"])
    elif b_wkt and not C.is_geographic(CRS.from_wkt(b_wkt)):
        w_crs = CRS.from_wkt(b_wkt)
    else:
        w_crs = C.utm_for(lon, lat)
    w_wkt = C.wkt(w_crs)
    if local:
        b_wkt = w_wkt
    w_geographic = C.is_geographic(w_crs)
    if w_geographic and (abs(rotation_deg) > 0 or scale != 1.0):
        raise GeorefError("Rotation and scaling must be done in a projected (metric) CRS such as a UTM zone, "
                          "not in a geographic CRS measured in degrees.")
    if kind == "raster" and local and w_geographic:
        raise GeorefError("Choose a projected CRS (e.g. UTM) for an image without ground coordinates.")
    if scale != 1.0 and not local:
        raise GeorefError("Scale can only be changed for data with no known coordinates (local frame).")

    # raster pixel grid override
    base_list = (prev or {}).get("base_affine")
    params = {"anchor": anchor, "pixel_size": pixel_size}
    if kind == "raster" and not base_list and ds["meta"].get("affine") is None:
        px, py = _pixel_size(pixel_size)
        base_list = list(Affine(px, 0, 0, 0, -py, 0))[:6]
    elif kind == "raster" and pixel_size is not None and local:
        px, py = _pixel_size(pixel_size)
        base_list = list(Affine(px, 0, 0, 0, -py, 0))[:6]

    g = {"method": "placed", "work_crs_wkt": w_wkt, "source_crs_wkt": b_wkt, "local": local, "base_affine": base_list,
         "pivot": [0.0, 0.0], "target": [0.0, 0.0], "rotation_deg": rotation_deg, "scale": scale, "z_offset": z_offset,
         "params": params, "gcp": (prev or {}).get("gcp")}
    frame = native_frame(ds, g)
    if frame is None:
        raise GeorefError("Cannot determine the dataset footprint.")
    cx, cy = geo.centroid(frame)
    res = Resolved("ready", "placed", b_wkt=b_wkt, w_wkt=w_wkt, frame_native=frame)
    if not res.crs_same:
        px_, py_ = C.transformer(b_wkt, w_wkt).transform(cx, cy)
        pivot = [float(px_), float(py_)]
    else:
        pivot = [cx, cy]
    if not all(math.isfinite(v) for v in pivot):
        raise GeorefError("The dataset coordinates cannot be transformed into the chosen CRS.")
    tx, ty = C.transformer(C.wkt(a_crs), w_wkt).transform(ax, ay) if not _same_crs(C.wkt(a_crs), w_wkt) else (ax, ay)
    if not (math.isfinite(tx) and math.isfinite(ty)):
        raise GeorefError("The anchor cannot be expressed in the chosen CRS (outside its valid area).")
    g["pivot"], g["target"] = pivot, [float(tx), float(ty)]
    A = rigid(g["pivot"], g["target"], rotation_deg, scale)
    bw = _frame_bounds(ds, None, w_wkt, b_wkt, frame, A)
    if bw is None:
        raise GeorefError("The placed dataset falls outside the valid range of the chosen CRS.")
    status, area = _area_check(w_crs, bw)
    g["area_check"] = status
    if status == "outside":
        raise GeorefError(f"{C.label(w_crs)} is not defined at this location ({area}). Choose a CRS that covers it (e.g. a UTM zone).")
    return g


def build_gcp(ds, crs_text, points, confirm_outside_area=False):
    """Fit an affine pixel->ground transform from control points (rasters only)."""
    if ds["kind"] != "raster":
        raise GeorefError("Control-point georeferencing applies to rasters only.")
    crs = _parse_crs(crs_text)
    if not isinstance(points, list) or len(points) < 3:
        raise GeorefError("At least 3 control points are required (4 or more recommended so the fit can be checked).")
    M, X, Y = [], [], []
    w, h = ds["meta"]["width"], ds["meta"]["height"]
    for i, p in enumerate(points, 1):
        col, row = _num(p.get("col"), f"point {i} col", lo=-w, hi=2 * w), _num(p.get("row"), f"point {i} row", lo=-h, hi=2 * h)
        x, y = _num(p.get("x"), f"point {i} x"), _num(p.get("y"), f"point {i} y")
        M.append([col, row, 1.0]); X.append(x); Y.append(y)
    M, X, Y = np.array(M), np.array(X), np.array(Y)
    if np.linalg.matrix_rank(M) < 3:
        raise GeorefError("Control points are collinear or duplicated; spread them across the image.")
    cx, *_ = np.linalg.lstsq(M, X, rcond=None)
    cy, *_ = np.linalg.lstsq(M, Y, rcond=None)
    base = Affine(cx[0], cx[1], cx[2], cy[0], cy[1], cy[2])
    if abs(base.determinant) < 1e-18:
        raise GeorefError("Control points produce a degenerate transform.")
    px, py = M @ cx, M @ cy
    mpu = C.meters_per_unit(crs, float(np.mean(Y)) if C.is_geographic(crs) else 0.0)
    resid = np.hypot(px - X, py - Y) * mpu
    rmse = float(np.sqrt(np.mean(resid ** 2)))
    sx, sy = math.hypot(base.a, base.d), math.hypot(base.b, base.e)
    warns = []
    if len(points) == 3:
        warns.append("Exactly 3 points fit exactly with no redundancy: the residuals cannot reveal a bad point.")
    if max(sx, sy) / max(min(sx, sy), 1e-18) > 1.2:
        warns.append(f"Pixel scale differs by {max(sx, sy) / min(sx, sy):.2f}x between axes; check the points.")
    if abs(base.a * base.b + base.d * base.e) > 0.05 * sx * sy:
        warns.append("The fitted transform contains noticeable shear; check the points.")
    wkt = C.wkt(crs)
    g = {"method": "gcp", "work_crs_wkt": wkt, "source_crs_wkt": wkt, "local": False, "base_affine": list(base)[:6],
         "pivot": [0.0, 0.0], "target": [0.0, 0.0], "rotation_deg": 0.0, "scale": 1.0, "z_offset": 0.0,
         "params": {"crs": C.label(crs)},
         "gcp": {"points": points, "rmse_m": rmse, "residuals_m": [float(r) for r in resid], "warnings": warns,
                 "pixel_size": [sx, sy]}}
    frame = native_frame(ds, g)
    bw = geo.bounds_wgs84(wkt, frame)
    if bw is None:
        raise GeorefError("The fitted extent cannot be expressed in longitude/latitude; check the CRS and points.")
    status, area = _area_check(crs, bw)
    g["area_check"] = status
    if status == "outside" and not confirm_outside_area:
        raise GeorefError(f"The fitted extent is outside the area where {C.label(crs)} is defined ({area}).")
    g["pivot"] = g["target"] = geo.centroid(frame)
    return g


# ----------------------------------------------------------------------------- verification
def verify(ds, g):
    """Round-trip check performed before a georeference is saved."""
    res = resolve(ds, g)
    frame = res.frame_native
    if frame is None:
        raise GeorefError("Cannot verify: unknown footprint.")
    pts = np.array(frame + [geo.centroid(frame)], float)
    fx, fy = res.forward(pts[:, 0], pts[:, 1])
    bx, by = res.inverse(fx, fy)
    w_crs = CRS.from_wkt(res.w_wkt)
    lat = float(np.mean(geo.to_wgs84(res.w_wkt, fx, fy)[1]))
    mpu_b = C.meters_per_unit(CRS.from_wkt(res.b_wkt), lat)
    err_native = float(np.max(np.hypot(bx - pts[:, 0], by - pts[:, 1]))) * mpu_b
    lon, la = geo.to_wgs84(res.w_wkt, fx, fy)
    back = C.transformer(C.wkt(CRS.from_epsg(4326)), res.w_wkt).transform(lon, la)
    err_wgs = float(np.max(np.hypot(back[0] - fx, back[1] - fy))) * C.meters_per_unit(w_crs, lat)
    a, b, c, d, e, f = res.A[:6]
    ax, ay = a * g["pivot"][0] + b * g["pivot"][1] + c, d * g["pivot"][0] + e * g["pivot"][1] + f
    anchor_err = float(math.hypot(ax - g["target"][0], ay - g["target"][1])) * C.meters_per_unit(w_crs, lat)
    worst = max(err_native, err_wgs, anchor_err)
    return {"max_roundtrip_error_m": worst, "native_roundtrip_m": err_native, "wgs84_roundtrip_m": err_wgs,
            "anchor_error_m": anchor_err, "samples": len(pts), "tolerance_m": 0.001, "passed": worst < 0.001}


# ----------------------------------------------------------------------------- presentation
def summarize(ds, g):
    """Everything the UI needs about the effective georeferencing of a dataset."""
    res = resolve(ds, g)
    nat = ds["meta"]["native"]
    out = {
        "status": res.state, "method": res.method, "local": res.local,
        "native": {"crs": nat.get("crs"), "epsg": nat.get("epsg"), "has_geotransform": nat.get("has_geotransform"),
                   "bounds_wgs84": nat.get("bounds_wgs84")},
        "override": None, "effective": None, "warnings": [],
    }
    if g is not None:
        out["override"] = {k: g.get(k) for k in ("method", "rotation_deg", "scale", "z_offset", "pivot", "target", "params",
                                                  "gcp", "local", "area_check", "verification", "version")}
    if res.state == "ready":
        frame_w = res.frame_w
        crs = CRS.from_wkt(res.w_wkt)
        eff = {"crs": C.describe(crs), "work_crs_wkt": res.w_wkt, "frame": frame_w,
               "corners_wgs84": geo.corners_wgs84(res.w_wkt, frame_w) if frame_w else None,
               "bounds_wgs84": geo.bounds_wgs84(res.w_wkt, frame_w) if frame_w else None,
               "rotation_deg": res.rotation_deg, "scale": res.scale, "z_offset": res.z_offset,
               "pivot": g["pivot"] if g else None, "target": g["target"] if g else None,
               "center": geo.centroid(frame_w) if frame_w else None}
        if eff["center"]:
            lon, lat = geo.to_wgs84(res.w_wkt, [eff["center"][0]], [eff["center"][1]])
            eff["center_wgs84"] = [float(lon[0]), float(lat[0])]
        if res.b_wkt and not res.crs_same:
            out["warnings"] += C.transform_notes(CRS.from_wkt(res.b_wkt), crs)
        out["effective"] = eff
    return out
