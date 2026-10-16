from . import pointcloud, raster, vector

MODULES = {"raster": raster, "vector": vector, "pointcloud": pointcloud}


def targets_for(ds, res):
    return MODULES[ds["kind"]].targets(ds, res)


def run(ds, g, res, fmt, crs_text, out_dir, progress, base):
    return MODULES[ds["kind"]].export(ds["id"], ds, g, res, fmt, crs_text, out_dir, progress, base)
