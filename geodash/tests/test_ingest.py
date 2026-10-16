import pytest

import fixtures as F
from app.errors import IngestError
from app.ingest import ingest


def run(path, tmp, name=None):
    out = tmp / "ds"
    out.mkdir(exist_ok=True)
    dst = out / ("original" + path.suffix)
    dst.write_bytes(path.read_bytes())
    return ingest(dst, out, name or path.name)


def test_geotiff_ortho(tmp):
    r = run(F.make_geotiff(tmp / "ortho.tif"), tmp)
    assert (r.kind, r.category, r.status) == ("raster", "orthomosaic", "ready")
    assert r.meta["native"]["epsg"] == 32643
    b = r.meta["native"]["bounds_wgs84"]
    assert b[0] < F.LON < b[2] and b[1] < F.LAT < b[3]


def test_dem_category(tmp):
    r = run(F.make_geotiff(tmp / "site_dsm.tif", count=1, dtype="float32", nodata=-9999), tmp)
    assert r.category == "dsm" and r.meta["nodata"] == -9999


def test_raster_without_crs_is_unreferenced_not_rejected(tmp):
    r = run(F.make_geotiff_no_crs(tmp / "x.tif"), tmp)
    assert r.status == "unreferenced" and r.meta["native"]["crs"] is None


def test_png_has_no_ground_transform(tmp):
    r = run(F.make_png_noref(tmp / "plan.png"), tmp)
    assert r.status == "unreferenced" and r.meta["affine"] is None


def test_shapefile_zip_with_prj(tmp):
    r = run(F.make_shapefile_zip(tmp / "p.zip"), tmp)
    assert (r.kind, r.status) == ("vector", "ready") and r.meta["features"] == 2
    assert r.meta["native"]["epsg"] == 32643


def test_shapefile_without_prj_is_not_assumed_wgs84(tmp):
    r = run(F.make_shapefile_zip(tmp / "p.zip", with_prj=False, crs="EPSG:4326"), tmp)
    assert r.status == "unreferenced" and r.meta["native"]["crs"] is None


def test_shapefile_missing_component(tmp):
    import zipfile
    z = F.make_shapefile_zip(tmp / "p.zip")
    bad = tmp / "bad.zip"
    with zipfile.ZipFile(z) as zi, zipfile.ZipFile(bad, "w") as zo:
        for n in zi.namelist():
            if not n.endswith(".dbf"):
                zo.writestr(n, zi.read(n))
    with pytest.raises(IngestError, match=r"\.dbf"):
        run(bad, tmp)


def test_geojson(tmp):
    r = run(F.make_geojson(tmp / "a.geojson"), tmp)
    assert r.status == "ready" and r.meta["native"]["epsg"] == 4326


def test_csv_latlon_needs_explicit_crs(tmp):
    r = run(F.make_csv(tmp / "pts.csv"), tmp)
    assert r.status == "unreferenced" and r.meta["suggested_crs"] == "EPSG:4326" and r.meta["features"] == 5


def test_csv_without_coordinates(tmp):
    p = tmp / "t.csv"
    p.write_text("a,b\n1,2\n")
    with pytest.raises(IngestError, match="coordinate columns"):
        run(p, tmp)


def test_las_with_crs(tmp):
    p, _ = F.make_las(tmp / "c.las")
    r = run(p, tmp)
    assert (r.kind, r.status) == ("pointcloud", "ready") and r.meta["native"]["epsg"] == 32643
    assert r.meta["points"] == 20000 and r.meta["has_rgb"]
    assert (tmp / "ds" / "topdown.png").exists() and (tmp / "ds" / "points.bin").exists()


def test_las_local_frame(tmp):
    p, _ = F.make_las(tmp / "c.las", local=True)
    r = run(p, tmp)
    assert r.status == "unreferenced" and r.meta["native"]["crs"] is None


def test_laz(tmp):
    p, _ = F.make_las(tmp / "c.laz", compress=True)
    assert run(p, tmp).meta["points"] == 20000


def test_xyz_text(tmp):
    r = run(F.make_xyz(tmp / "scan.xyz"), tmp)
    assert r.status == "unreferenced" and r.meta["points"] == 3000 and r.meta["has_rgb"]


def test_corrupt_files(tmp):
    for ext in (".tif", ".las", ".zip", ".geojson"):
        p = tmp / f"bad{ext}"
        p.write_bytes(b"this is not a real file" * 10)
        with pytest.raises(IngestError):
            run(p, tmp)


def test_explicit_unsupported_formats(tmp):
    for ext, word in ((".dwg", "proprietary"), (".ecw", "licensed"), (".e57", "not supported"), (".obj", "mesh")):
        p = tmp / f"x{ext}"
        p.write_bytes(b"x")
        with pytest.raises(IngestError, match=word):
            run(p, tmp)


def test_zip_slip_rejected(tmp):
    import zipfile
    z = tmp / "evil.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("../../evil.shp", b"x")
    with pytest.raises(IngestError, match="unsafe"):
        run(z, tmp)
