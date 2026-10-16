"""Small geometry helpers shared by ingest, georeferencing and rendering."""
import math

import numpy as np
from pyproj import CRS

from . import crs as C


def densify_ring(frame, n=21):
    """frame: 4 corner points in order. Returns (4n,2) points along its edges (closed, no duplicate)."""
    pts = np.asarray(frame, float)
    out = []
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        t = np.linspace(0, 1, n, endpoint=False)[:, None]
        out.append(a + (b - a) * t)
    return np.vstack(out)


def to_wgs84(crs_wkt: str, x, y):
    t = C.transformer(crs_wkt, C.wkt(CRS.from_epsg(4326)))
    lon, lat = t.transform(np.asarray(x, float), np.asarray(y, float))
    return np.asarray(lon), np.asarray(lat)


def bounds_wgs84(crs_wkt: str, frame):
    """[west, south, east, north] of a polygon frame, or None if it cannot be expressed in WGS84."""
    pts = densify_ring(frame)
    lon, lat = to_wgs84(crs_wkt, pts[:, 0], pts[:, 1])
    if not (np.isfinite(lon).all() and np.isfinite(lat).all()):
        return None
    if lon.min() < -180.0001 or lon.max() > 180.0001 or lat.min() < -90.0001 or lat.max() > 90.0001:
        return None
    return [float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())]


def corners_wgs84(crs_wkt: str, frame):
    lon, lat = to_wgs84(crs_wkt, [p[0] for p in frame], [p[1] for p in frame])
    return [[float(a), float(b)] for a, b in zip(lon, lat)]


def bbox_frame(minx, miny, maxx, maxy):
    """Corner order TL, TR, BR, BL (north-up)."""
    return [[minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny]]


def centroid(frame):
    p = np.asarray(frame, float)
    return [float(p[:, 0].mean()), float(p[:, 1].mean())]


def finite(*vals):
    return all(math.isfinite(v) for v in vals)
