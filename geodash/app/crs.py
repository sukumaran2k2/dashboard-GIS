"""CRS lookup, parsing and transformer handling (pyproj only; no hand-rolled math)."""
import math
import re
from functools import lru_cache

from pyproj import CRS, Transformer
from pyproj.database import query_crs_info
from pyproj.enums import PJType
from pyproj.transformer import TransformerGroup


class CRSError(ValueError):
    pass


def parse(text) -> CRS:
    """Accepts 'EPSG:32643', '32643', WKT, PROJJSON or a PROJ string. Rejects engineering/unknown CRS."""
    if isinstance(text, CRS):
        crs = text
    else:
        s = str(text or "").strip()
        if not s:
            raise CRSError("No CRS given.")
        if re.fullmatch(r"\d{4,6}", s):
            s = f"EPSG:{s}"
        try:
            crs = CRS.from_user_input(s)
        except Exception as e:
            raise CRSError(f"Not a valid CRS definition: {str(e)[:160]}")
    h = horizontal(crs)
    if h.is_engineering or not (h.is_projected or h.is_geographic):
        raise CRSError("Only geographic or projected coordinate systems can be used for georeferencing.")
    return crs


def horizontal(crs: CRS) -> CRS:
    if crs.is_compound:
        return crs.sub_crs_list[0]
    return crs


def wkt(crs: CRS) -> str:
    return crs.to_wkt()


def epsg(crs: CRS):
    try:
        return crs.to_epsg()
    except Exception:
        return None


def label(crs: CRS) -> str:
    e = epsg(crs)
    return f"EPSG:{e}" if e else (crs.name or "Custom CRS")


def units(crs: CRS) -> str:
    h = horizontal(crs)
    try:
        return h.axis_info[0].unit_name
    except Exception:
        return "unknown"


def is_geographic(crs: CRS) -> bool:
    return horizontal(crs).is_geographic


def describe(crs: CRS) -> dict:
    h = horizontal(crs)
    aoi = h.area_of_use
    return {
        "name": crs.name, "epsg": epsg(crs), "label": label(crs), "wkt": wkt(crs),
        "type": "geographic" if h.is_geographic else "projected",
        "units": units(crs),
        "axes": [{"name": a.name, "direction": a.direction, "unit": a.unit_name} for a in h.axis_info],
        "area_of_use": ({"name": aoi.name, "bounds": [aoi.west, aoi.south, aoi.east, aoi.north]} if aoi else None),
        "has_vertical": crs.is_compound,
    }


def utm_for(lon: float, lat: float) -> CRS:
    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
        raise CRSError("Longitude/latitude out of range.")
    if abs(lat) > 84:
        raise CRSError("UTM is not defined beyond 84N/80S; choose a polar CRS explicitly.")
    zone = int(math.floor((lon + 180) / 6) % 60) + 1
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone)


@lru_cache(maxsize=1)
def _catalog():
    out = []
    for t in (PJType.PROJECTED_CRS, PJType.GEOGRAPHIC_2D_CRS):
        for i in query_crs_info(auth_name="EPSG", pj_types=t, allow_deprecated=False):
            b = i.area_of_use.bounds if i.area_of_use else None
            out.append({"code": i.code, "name": i.name, "type": "projected" if t == PJType.PROJECTED_CRS else "geographic",
                        "area": i.area_of_use.name if i.area_of_use else None, "bounds": list(b) if b else None})
    return out


def search(q: str, lon=None, lat=None, limit=40):
    q = (q or "").strip().lower()
    items = _catalog()
    if lon is not None and lat is not None:
        items = [i for i in items if i["bounds"] and i["bounds"][0] <= lon <= i["bounds"][2] and i["bounds"][1] <= lat <= i["bounds"][3]]
    if q:
        toks = q.replace("epsg:", "").split()
        items = [i for i in items if all(t in f"{i['code']} {i['name']} {i['area'] or ''}".lower() for t in toks)]
    items.sort(key=lambda i: (q != str(i["code"]), i["type"] != "projected", len(i["name"])))
    return items[:limit]


@lru_cache(maxsize=256)
def transformer(src_wkt: str, dst_wkt: str) -> Transformer:
    return Transformer.from_crs(CRS.from_wkt(src_wkt), CRS.from_wkt(dst_wkt), always_xy=True)


def transform_notes(src: CRS, dst: CRS) -> list:
    """Warnings when the best transformation needs grids that are not installed, or accuracy is low."""
    notes = []
    if horizontal(src).equals(horizontal(dst)):
        return notes
    try:
        g = TransformerGroup(horizontal(src), horizontal(dst), always_xy=True)
        if g.unavailable_operations:
            notes.append("A more accurate grid-based transformation exists but its grid is not installed; "
                         "using: " + (g.transformers[0].description if g.transformers else "fallback") + ".")
        t = g.transformers[0] if g.transformers else None
        if t is not None and t.accuracy and t.accuracy > 0:
            notes.append(f"Transformation '{t.description}' has a stated accuracy of about {t.accuracy:g} m.")
    except Exception:
        pass
    return notes


def meters_per_unit(crs: CRS, at_lat: float = 0.0) -> float:
    """Approximate metres per CRS unit, used only to express verification errors in metres."""
    h = horizontal(crs)
    if h.is_geographic:
        return 111_320.0 * max(math.cos(math.radians(at_lat)), 0.01)
    try:
        return h.axis_info[0].unit_conversion_factor or 1.0
    except Exception:
        return 1.0
