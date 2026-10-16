"""Builders for small synthetic datasets with known coordinates."""
import zipfile
from pathlib import Path

import laspy
import numpy as np
import rasterio
import shapely
from affine import Affine
from PIL import Image
from pyproj import CRS, Transformer

from app import vectorio

# A spot in Bengaluru, India (UTM zone 43N)
LON, LAT = 77.5946, 12.9716
UTM = "EPSG:32643"
E0, N0 = Transformer.from_crs(4326, UTM, always_xy=True).transform(LON, LAT)


def make_geotiff(path, crs=UTM, origin=None, res=0.5, w=200, h=150, count=3, dtype="uint8", nodata=None, fill=None, seed=1):
    ox, oy = origin or (E0 - w * res / 2, N0 + h * res / 2)
    rng = np.random.default_rng(seed)
    if dtype == "uint8":
        data = rng.integers(1, 255, (count, h, w), dtype=np.uint8)
    else:
        yy, xx = np.mgrid[0:h, 0:w]
        data = np.stack([(xx * 0.1 + yy * 0.2 + 100 + i).astype(dtype) for i in range(count)])
    if fill is not None:
        data[:] = fill
    if nodata is not None:
        data[:, :5, :5] = nodata
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=count, dtype=dtype,
                       crs=crs, transform=Affine(res, 0, ox, 0, -res, oy), nodata=nodata) as dst:
        dst.write(data)
    return Path(path)


def make_png_noref(path, w=120, h=80):
    arr = np.random.default_rng(2).integers(0, 255, (h, w, 3), dtype=np.uint8)
    Image.fromarray(arr).save(path)
    return Path(path)


def make_geotiff_no_crs(path, w=100, h=60):
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32") as dst:
        dst.write(np.random.default_rng(3).random((1, h, w)).astype("float32"))
    return Path(path)


def vector_geoms(crs=UTM):
    cx, cy = (E0, N0) if crs == UTM else (LON, LAT)
    d = 100 if crs == UTM else 0.001
    return np.array([
        shapely.Polygon([(cx, cy), (cx + d, cy), (cx + d, cy + d), (cx, cy + d)]),
        shapely.Polygon([(cx + 2 * d, cy), (cx + 3 * d, cy), (cx + 3 * d, cy + d), (cx + 2 * d, cy + d)]),
    ], dtype=object)


def make_shapefile_zip(path, with_prj=True, crs=UTM, long_field=False):
    tmp = Path(path).with_suffix("")
    tmp.mkdir(exist_ok=True)
    fname = "a_really_long_field_name" if long_field else "name"
    fields = {fname: np.array(["alpha", "beta"], dtype=object), "val": np.array([1.5, 2.5])}
    vectorio.write(tmp / "parcels.shp", vector_geoms(crs), fields, "ESRI Shapefile",
                   crs_wkt=CRS.from_user_input(crs).to_wkt() if with_prj else None, layer="parcels")
    with zipfile.ZipFile(path, "w") as z:
        for p in tmp.iterdir():
            if p.suffix.lower() == ".prj" and not with_prj:
                continue
            z.write(p, p.name)
    return Path(path)


def make_gpkg_long_fields(path):
    fields = {"parcel_owner_description": np.array(["alpha", "beta"], dtype=object), "val": np.array([1.5, 2.5])}
    vectorio.write(path, vector_geoms(), fields, "GPKG", crs_wkt=CRS.from_user_input(UTM).to_wkt(), layer="parcels")
    return Path(path)


def make_geojson(path):
    fields = {"name": np.array(["alpha", "beta"], dtype=object), "val": np.array([1.5, 2.5])}
    vectorio.write(path, vector_geoms(4326), fields, "GeoJSON", crs_wkt=CRS.from_epsg(4326).to_wkt())
    return Path(path)


def make_csv(path, latlon=True):
    with open(path, "w", newline="") as f:
        f.write("id,lat,lon,elev,label\n" if latlon else "id,x,y,z,label\n")
        for i in range(5):
            f.write(f"{i},{LAT + i * 1e-4},{LON + i * 1e-4},{900 + i},pt{i}\n" if latlon else f"{i},{E0 + i},{N0 + i},{900 + i},pt{i}\n")
    return Path(path)


def make_las(path, crs=UTM, n=20000, rgb=True, local=False, seed=5, ext=100.0, compress=False):
    rng = np.random.default_rng(seed)
    cx, cy = (0.0, 0.0) if local else (E0, N0)
    x = cx + rng.uniform(-ext / 2, ext / 2, n)
    y = cy + rng.uniform(-ext / 2, ext / 2, n)
    z = 900 + 10 * np.sin(x / 10.0) + rng.uniform(0, 2, n)
    header = laspy.LasHeader(point_format=3 if rgb else 1, version="1.2")
    header.offsets = [np.floor(x.min()), np.floor(y.min()), np.floor(z.min())]
    header.scales = [0.001, 0.001, 0.001]
    if crs and not local:
        header.add_crs(CRS.from_user_input(crs))
    las = laspy.LasData(header)
    las.x, las.y, las.z = x, y, z
    if rgb:
        las.red = rng.integers(0, 65535, n, dtype=np.uint16)
        las.green = rng.integers(0, 65535, n, dtype=np.uint16)
        las.blue = rng.integers(0, 65535, n, dtype=np.uint16)
    las.write(str(path), do_compress=compress) if compress else las.write(str(path))
    return Path(path), (x, y, z)


def make_xyz(path, n=3000, seed=7):
    rng = np.random.default_rng(seed)
    x, y = rng.uniform(0, 50, n), rng.uniform(0, 30, n)
    z = 10 + np.sin(x / 5.0)
    np.savetxt(path, np.c_[x, y, z, rng.integers(0, 255, (n, 3))], fmt="%.4f %.4f %.4f %d %d %d")
    return Path(path)
