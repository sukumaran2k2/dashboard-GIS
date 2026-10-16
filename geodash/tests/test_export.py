import io
import time
import zipfile

import laspy
import numpy as np
import pytest
import rasterio
from affine import Affine
from pyproj import CRS, Transformer

import fixtures as F
from app import georef as G
from app.export import raster as xr
from app.export.report import Report


@pytest.fixture()
def project(client):
    return client.post("/api/projects", json={"name": "Export"}).json()["id"]


def upload(client, pid, path):
    with open(path, "rb") as f:
        r = client.post(f"/api/projects/{pid}/upload", files={"file": (path.name, f)})
    assert r.status_code == 200, r.text
    return r.json()


def run_export(client, did, fmt, crs=None, expect_ok=True):
    r = client.post(f"/api/datasets/{did}/export", json={"format": fmt, "crs": crs})
    if not expect_ok:
        return r
    assert r.status_code == 200, r.text
    jid = r.json()["job_id"]
    for _ in range(600):
        j = client.get(f"/api/jobs/{jid}").json()
        if j["state"] in ("done", "failed"):
            return j
        time.sleep(0.1)
    raise AssertionError("export timed out")


def download(client, job):
    r = client.get(f"/api/jobs/{job['id']}/download")
    assert r.status_code == 200, r.text
    return r.content


def statuses(job):
    return {c["name"]: c["status"] for c in job["result"]["report"]["checks"]}


# ------------------------------------------------------------------------------------------ raster
def test_geotiff_roundtrip_is_pixel_exact(client, project, tmp_path):
    src = F.make_geotiff(tmp_path / "o.tif", w=700, h=530)
    d = upload(client, project, src)
    j = run_export(client, d["id"], "geotiff")
    assert j["state"] == "done" and j["result"]["report"]["overall"] == "PASS", j["result"]["report"]
    out = tmp_path / "out.tif"
    out.write_bytes(download(client, j))
    with rasterio.open(src) as a, rasterio.open(out) as b:
        assert np.array_equal(a.read(), b.read())
        assert b.transform == a.transform and b.crs.to_epsg() == 32643 and b.nodata == a.nodata


def test_placed_image_exports_at_the_anchor_with_the_right_rotation(client, project, tmp_path):
    d = upload(client, project, F.make_png_noref(tmp_path / "plan.png", w=400, h=300))
    r = client.put(f"/api/datasets/{d['id']}/georef", json={
        "mode": "place", "anchor": {"lon": 77.6, "lat": 12.98}, "rotation_deg": 30, "pixel_size": 0.2})
    assert r.status_code == 200, r.text
    j = run_export(client, d["id"], "geotiff")
    assert j["result"]["report"]["overall"] == "PASS", j["result"]["report"]
    out = tmp_path / "placed.tif"
    out.write_bytes(download(client, j))
    with rasterio.open(out) as o:
        t = o.transform
        cx, cy = t @ (o.width / 2, o.height / 2)                       # image centre in UTM
        lon, lat = Transformer.from_crs(o.crs, 4326, always_xy=True).transform(cx, cy)
        assert lon == pytest.approx(77.6, abs=1e-8) and lat == pytest.approx(12.98, abs=1e-8)
        assert np.hypot(t.a, t.d) == pytest.approx(0.2, rel=1e-12)           # pixel size untouched
        assert np.degrees(np.arctan2(t.d, t.a)) == pytest.approx(30, abs=1e-9)   # rotation as requested


def test_cog_export_and_rotated_cog_is_refused(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif", w=1300, h=900))
    j = run_export(client, d["id"], "cog")
    assert j["result"]["report"]["overall"] == "PASS", j["result"]["report"]
    assert statuses(j)["Valid Cloud-Optimized GeoTIFF"] == "PASS"
    client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "place", "anchor": {"lon": 77.6, "lat": 12.98}, "rotation_deg": 12})
    t = {x["format"]: x for x in client.get(f"/api/datasets/{d['id']}/export/targets").json()}
    assert not t["cog"]["available"] and "north-up" in t["cog"]["reason"]
    assert run_export(client, d["id"], "cog", expect_ok=False).status_code == 422


def test_png_is_lossless_for_rgb_and_flagged_lossy_for_dem(client, project, tmp_path):
    rgb = upload(client, project, F.make_geotiff(tmp_path / "o.tif"))
    j = run_export(client, rgb["id"], "png")
    assert j["result"]["report"]["overall"] == "PASS", j["result"]["report"]
    z = zipfile.ZipFile(io.BytesIO(download(client, j)))
    assert sorted(z.namelist()) == sorted(n for n in z.namelist() if n.endswith((".png", ".pgw", ".prj", ".aux.xml")))
    assert len(z.namelist()) == 4
    dem = upload(client, project, F.make_geotiff(tmp_path / "dem.tif", count=1, dtype="float32", nodata=-9999.0))
    t = {x["format"]: x for x in client.get(f"/api/datasets/{dem['id']}/export/targets").json()}
    assert t["png"]["lossy"] and any("elevation" in s for s in t["png"]["losses"])
    j2 = run_export(client, dem["id"], "png")
    assert j2["result"]["report"]["overall"] == "WARN"          # never PASS: values are not preserved


def test_unreferenced_raster_exports_with_a_warning_not_a_fake_crs(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff_no_crs(tmp_path / "x.tif"))
    j = run_export(client, d["id"], "geotiff")
    assert j["result"]["report"]["overall"] == "WARN" and statuses(j)["CRS"] == "WARN"
    out = tmp_path / "o.tif"
    out.write_bytes(download(client, j))
    with rasterio.open(out) as o:
        assert o.crs is None


def test_raster_reprojection_is_refused_not_faked(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif"))
    j = run_export(client, d["id"], "geotiff", crs="EPSG:4326")
    assert j["state"] == "failed" and "own CRS" in j["error"]


# ------------------------------------------------------------------------------------------ vector
@pytest.mark.parametrize("fmt", ["gpkg", "geojson", "shapefile"])
def test_vector_formats_validate(client, project, tmp_path, fmt):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip"))
    j = run_export(client, d["id"], fmt)
    assert j["state"] == "done", j
    rep = j["result"]["report"]
    assert rep["overall"] == "PASS", rep
    s = statuses(j)
    assert s["Coordinates"] == "PASS" and s["CRS"] == "PASS" and s["Feature count"] == "PASS"


def test_shapefile_long_field_names_are_reported_not_hidden(client, project, tmp_path):
    d = upload(client, project, F.make_gpkg_long_fields(tmp_path / "p.gpkg"))
    t = {x["format"]: x for x in client.get(f"/api/datasets/{d['id']}/export/targets").json()}
    assert t["shapefile"]["lossy"] and any("10 characters" in s for s in t["shapefile"]["losses"])
    gp = run_export(client, d["id"], "gpkg")
    assert gp["result"]["report"]["overall"] == "PASS"
    shp = run_export(client, d["id"], "shapefile")
    rep = shp["result"]["report"]
    assert rep["overall"] == "WARN", rep                               # shortened name: warned, never silently PASS
    s = statuses(shp)
    assert s["Attribute fields"] == "WARN" and "parcel_owner_description" in next(
        c["detail"] for c in rep["checks"] if c["name"] == "Attribute fields")
    assert s["Attribute values"] == "PASS" and s["Coordinates"] == "PASS"     # the renamed column's values still match


def test_kml_and_dxf_outcomes_are_honest(client, project, tmp_path):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip"))
    kml = run_export(client, d["id"], "kml")
    assert kml["state"] == "done" and kml["result"]["report"]["overall"] in ("PASS", "WARN", "FAIL")
    dxf = run_export(client, d["id"], "dxf")
    assert dxf["result"]["report"]["overall"] == "WARN"       # DXF drops attributes and the CRS: never claimed as clean
    s = statuses(dxf)
    assert s["Attributes"] == "WARN" and s["CRS"] == "WARN" and s["Coordinates"] == "PASS"


def test_vector_export_can_reproject(client, project, tmp_path):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip"))
    j = run_export(client, d["id"], "gpkg", crs="EPSG:4326")
    assert j["result"]["report"]["overall"] == "PASS"
    assert any("reprojected" in n for n in j["result"]["report"]["notes"])
    import pyogrio
    out = tmp_path / "o.gpkg"
    out.write_bytes(download(client, j))
    info = pyogrio.read_info(out)
    assert CRS.from_user_input(info["crs"]).to_epsg() == 4326
    b = info["total_bounds"]
    # expected extent computed independently from the fixture corners (UTM grid north is not true north,
    # so the south-east corner is ~1 m south of the south-west one)
    import shapely
    xy = shapely.get_coordinates(F.vector_geoms())
    lon, lat = Transformer.from_crs(32643, 4326, always_xy=True).transform(xy[:, 0], xy[:, 1])
    assert b == pytest.approx([lon.min(), lat.min(), lon.max(), lat.max()], abs=1e-9)
    assert b[0] == pytest.approx(F.LON, abs=1e-7)


def test_assigned_crs_is_baked_into_export(client, project, tmp_path):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip", with_prj=False))
    assert run_export(client, d["id"], "geojson", expect_ok=False).status_code == 422       # needs a CRS first
    client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "assign", "crs": "EPSG:32643"})
    j = run_export(client, d["id"], "gpkg")
    assert j["result"]["report"]["overall"] == "PASS" and statuses(j)["CRS"] == "PASS"


# ------------------------------------------------------------------------------------------ point cloud
def test_placed_cloud_exports_rigidly_with_z_and_crs(client, project, tmp_path):
    src, (x, y, z) = F.make_las(tmp_path / "scan.las", local=True, n=30000)
    d = upload(client, project, src)
    body = {"mode": "place", "anchor": {"lon": 77.6, "lat": 12.98}, "rotation_deg": 40, "z_offset": 5.0}
    assert client.put(f"/api/datasets/{d['id']}/georef", json=body).status_code == 200
    j = run_export(client, d["id"], "las")
    assert j["result"]["report"]["overall"] == "PASS", j["result"]["report"]
    out = tmp_path / "o.las"
    out.write_bytes(download(client, j))
    las = laspy.read(out)
    assert las.header.point_count == 30000
    assert CRS.from_user_input(las.header.parse_crs()).to_epsg() == 32643
    # independent checks: rigid motion (distances preserved), Z shifted by exactly the offset
    X, Y, Z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
    assert np.allclose(Z, z + 5.0, atol=2e-3)
    i, k = 10, 20000
    assert np.hypot(X[i] - X[k], Y[i] - Y[k]) == pytest.approx(np.hypot(x[i] - x[k], y[i] - y[k]), abs=3e-3)
    # rotation: the vector between two points turned by 40 degrees counter-clockwise
    a_src = np.arctan2(y[k] - y[i], x[k] - x[i])
    a_out = np.arctan2(Y[k] - Y[i], X[k] - X[i])
    assert np.degrees((a_out - a_src + np.pi) % (2 * np.pi) - np.pi) == pytest.approx(40, abs=0.01)
    # colours survive
    src_las = laspy.read(src)
    assert np.array_equal(np.asarray(las.red), np.asarray(src_las.red))


def test_laz_and_xyz_export(client, project, tmp_path):
    d = upload(client, project, F.make_las(tmp_path / "c.las", n=12000)[0])
    laz = run_export(client, d["id"], "laz")
    assert laz["result"]["report"]["overall"] == "PASS", laz["result"]["report"]
    assert download(client, laz)[:4] == b"LASF"
    xyz = run_export(client, d["id"], "xyz")
    assert xyz["result"]["report"]["overall"] in ("PASS", "WARN") and statuses(xyz)[".prj CRS"] == "PASS"
    z = zipfile.ZipFile(io.BytesIO(download(client, xyz)))
    assert any(n.endswith(".prj") for n in z.namelist())


def test_text_cloud_to_las_and_unreferenced_warning(client, project, tmp_path):
    d = upload(client, project, F.make_xyz(tmp_path / "scan.xyz"))
    j = run_export(client, d["id"], "las")
    assert j["result"]["report"]["overall"] == "WARN" and statuses(j)["CRS"] == "WARN"
    out = tmp_path / "o.las"
    out.write_bytes(download(client, j))
    assert laspy.read(out).header.point_count == 3000


# ------------------------------------------------------------------------------------------ the validators really catch errors
def test_validator_catches_a_shifted_geotiff(tmp_path):
    src = F.make_geotiff(tmp_path / "o.tif")
    with rasterio.open(src) as s:
        meta = {"width": s.width, "height": s.height, "bands": s.count, "dtype": s.dtypes[0], "nodata": s.nodata}
        crs_wkt, aff = s.crs.to_wkt(), s.transform
    bad = tmp_path / "bad.tif"
    xr._write_geotiff(src, bad, crs_wkt, aff * Affine.translation(5, 0), lambda *_: None)   # 5 pixels off
    rep = Report()
    xr._validate_tiff(src, bad, meta, crs_wkt, aff, rep, cog=False)
    assert rep.overall == "FAIL" and any(c["name"] == "Georeferencing transform" and c["status"] == "FAIL" for c in rep.checks)


def test_validator_catches_wrong_crs_and_changed_pixels(tmp_path):
    src = F.make_geotiff(tmp_path / "o.tif")
    with rasterio.open(src) as s:
        meta = {"width": s.width, "height": s.height, "bands": s.count, "dtype": s.dtypes[0], "nodata": s.nodata}
        aff = s.transform
        crs_wkt = s.crs.to_wkt()
    bad = tmp_path / "bad.tif"
    xr._write_geotiff(src, bad, CRS.from_epsg(32644).to_wkt(), aff, lambda *_: None)
    with rasterio.open(bad, "r+") as b:
        b.write(np.zeros((3, 4, 4), np.uint8), window=rasterio.windows.Window(0, 0, 4, 4))
    rep = Report()
    xr._validate_tiff(src, bad, meta, crs_wkt, aff, rep, cog=False)
    s = {c["name"]: c["status"] for c in rep.checks}
    assert s["CRS"] == "FAIL" and s["Pixel values identical to source"] == "FAIL" and rep.overall == "FAIL"


def test_failed_validation_withholds_the_file(client, project, tmp_path, monkeypatch):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif"))
    real = xr._write_geotiff

    def corrupt(src_path, dst, crs_wkt, affine, progress, p0=0.0, p1=1.0):
        real(src_path, dst, crs_wkt, affine @ Affine.translation(9, 0), progress, p0, p1)     # silently wrong output

    monkeypatch.setattr(xr, "_write_geotiff", corrupt)
    j = run_export(client, d["id"], "geotiff")
    assert j["state"] == "done" and j["result"]["report"]["overall"] == "FAIL" and not j["result"]["downloadable"]
    assert client.get(f"/api/jobs/{j['id']}/download").status_code == 409
    from app import config
    assert not (config.FILES / d["id"] / "exports" / j["id"]).exists()


def test_unknown_or_unavailable_formats_are_rejected(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif"))
    assert run_export(client, d["id"], "shapefile", expect_ok=False).status_code == 422
    assert run_export(client, d["id"], "nope", expect_ok=False).status_code == 422
