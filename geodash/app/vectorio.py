"""Vector reading/writing through pyogrio (GDAL/OGR) with shapely geometries."""
import numpy as np
import pyogrio
import shapely
from pyogrio.raw import read as raw_read
from pyogrio.raw import write as raw_write


def read_all(path, layer=None):
    """Returns (info, geoms[ndarray of shapely], fields{name: ndarray}). info from pyogrio.read_info."""
    info = pyogrio.read_info(path, layer=layer, force_feature_count=True, force_total_bounds=True)
    meta, _fids, wkb, field_data = raw_read(path, layer=layer)
    geoms = shapely.from_wkb(wkb)
    fields = {n: a for n, a in zip(meta["fields"], field_data)}
    return info, geoms, fields


def write(path, geoms, fields, driver, crs_wkt=None, layer="data", geometry_type=None, **opts):
    """geoms: shapely array. fields: ordered dict name->ndarray."""
    names = list(fields.keys())
    data = [fields[n] for n in names]
    if geometry_type is None:
        geometry_type = geometry_type_of(geoms)
    raw_write(str(path), shapely.to_wkb(geoms, include_srid=False, flavor="iso"), data, names,
              layer=layer, driver=driver, geometry_type=geometry_type, crs=crs_wkt,
              dataset_options=opts.get("dataset_options"), layer_options=opts.get("layer_options"))


def geometry_type_of(geoms):
    types = {shapely.get_type_id(g) for g in geoms if g is not None}
    has_z = any(shapely.has_z(g) for g in geoms[:1000] if g is not None)
    names = {0: "Point", 1: "LineString", 2: "LineString", 3: "Polygon", 4: "MultiPoint", 5: "MultiLineString",
             6: "MultiPolygon", 7: "GeometryCollection"}
    if len(types) == 1:
        base = names.get(next(iter(types)), "Unknown")
    elif types <= {0, 4}:
        base = "MultiPoint"
    elif types <= {1, 2, 5}:
        base = "MultiLineString"
    elif types <= {3, 6}:
        base = "MultiPolygon"
    else:
        base = "Unknown"
    return base + (" Z" if has_z and base != "Unknown" else "")
