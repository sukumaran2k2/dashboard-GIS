from dataclasses import dataclass, field

from .. import crs as C
from .. import geo
from ..errors import IngestError  # noqa: F401  (re-exported)


@dataclass
class Inspection:
    kind: str
    category: str
    status: str          # ready | unreferenced
    meta: dict = field(default_factory=dict)


def native_block(crs, frame, has_geotransform=True):
    """Describes the file's own coordinate frame. crs is a pyproj CRS or None."""
    b = {"crs_wkt": None, "crs": None, "epsg": None, "units": None, "frame": frame,
         "has_geotransform": has_geotransform, "bounds_wgs84": None}
    if crs is not None:
        b.update(crs_wkt=C.wkt(crs), crs=C.label(crs), epsg=C.epsg(crs), units=C.units(crs))
        if has_geotransform and frame:
            b["bounds_wgs84"] = geo.bounds_wgs84(C.wkt(crs), frame)
    return b
