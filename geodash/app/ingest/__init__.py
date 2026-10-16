from pathlib import Path

from ..pointio import POINT_EXT
from .archive import safe_extract, select_primary
from .common import IngestError, Inspection
from .pointcloud import inspect_pointcloud
from .raster import RASTER_EXT, inspect_raster
from .vector import VECTOR_EXT, inspect_vector

UNSUPPORTED = {
    ".dwg": "DWG is a proprietary Autodesk format. Export it to DXF from CAD and upload that.",
    ".ecw": "ECW needs a licensed SDK and is not supported. Convert to GeoTIFF first.",
    ".sid": "MrSID needs a licensed SDK and is not supported. Convert to GeoTIFF first.",
    ".e57": "E57 point clouds are not supported yet. Convert to LAS/LAZ first.",
    ".obj": "3D mesh formats are not supported yet; only point clouds are.",
    ".glb": "3D mesh formats are not supported yet; only point clouds are.",
    ".gltf": "3D mesh formats are not supported yet; only point clouds are.",
    ".fbx": "3D mesh formats are not supported yet; only point clouds are.",
    ".ifc": "IFC/BIM models are not supported.",
    ".rvt": "Revit models are not supported.",
    ".dgn": "DGN is not supported. Export to DXF or GeoPackage.",
    ".kml.zip": "Rename to .kmz.",
}

ALL_EXT = sorted(RASTER_EXT | VECTOR_EXT | POINT_EXT | {".zip"})


def supported_formats():
    return {
        "raster": sorted(RASTER_EXT), "vector": sorted(VECTOR_EXT - {".shp", ".gdb"}) + [".zip (Shapefile / File Geodatabase)"],
        "pointcloud": sorted(POINT_EXT), "archive": [".zip"],
        "unsupported": {k: v for k, v in UNSUPPORTED.items() if k.count(".") == 1},
    }


def ingest(upload: Path, out: Path, filename: str) -> Inspection:
    """Validates the uploaded file and extracts metadata. Derived files are written into `out`."""
    ext = Path(filename).suffix.lower()
    notes = []
    if ext in UNSUPPORTED:
        raise IngestError(UNSUPPORTED[ext])
    if ext not in ALL_EXT:
        raise IngestError(f"Unsupported file type '{ext or '(none)'}'. Supported: " + ", ".join(ALL_EXT))
    path = upload
    if ext == ".zip":
        safe_extract(upload, out / "src")
        path, ext, notes = select_primary(out / "src")
    if ext in RASTER_EXT:
        insp = inspect_raster(path, filename, out)
    elif ext in VECTOR_EXT:
        insp = inspect_vector(path, filename, out, ext)
    elif ext in POINT_EXT:
        insp = inspect_pointcloud(path, filename, out, ext)
    else:
        raise IngestError(f"Unsupported file type '{ext}'.")
    insp.meta.setdefault("source", path.relative_to(out).as_posix())
    insp.meta["source_ext"] = ext
    insp.meta["warnings"] = notes + insp.meta.get("warnings", [])
    return insp
