import math

import numpy as np
import pytest
from affine import Affine
from pyproj import CRS, Transformer

import fixtures as F
from app import georef as G
from app.errors import GeorefError
from app.ingest import ingest

ANCHOR = {"lon": 77.6, "lat": 12.98}


def make_ds(path, tmp, name=None):
    out = tmp / path.stem
    out.mkdir(exist_ok=True)
    dst = out / ("original" + path.suffix)
    dst.write_bytes(path.read_bytes())
    r = ingest(dst, out, name or path.name)
    return {"kind": r.kind, "status": r.status, "meta": r.meta}


def center_lonlat(ds, g):
    res = G.resolve(ds, g)
    cx, cy = np.mean(res.frame_w, axis=0)
    lon, lat = Transformer.from_crs(res.w_wkt, 4326, always_xy=True).transform(cx, cy)
    return lon, lat


def test_place_local_pointcloud_centre_lands_on_anchor(tmp_path):
    p, _ = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    g = G.build_place(ds, ANCHOR)
    assert g["work_crs_wkt"] and CRS.from_wkt(g["work_crs_wkt"]).to_epsg() == 32643
    lon, lat = center_lonlat(ds, g)
    assert lon == pytest.approx(77.6, abs=1e-9) and lat == pytest.approx(12.98, abs=1e-9)
    v = G.verify(ds, g)
    assert v["passed"], v


def test_rotation_preserves_shape_and_rotates_exactly(tmp_path):
    p, _ = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    g0, g90 = G.build_place(ds, ANCHOR, rotation_deg=0), G.build_place(ds, ANCHOR, rotation_deg=90)
    f0, f90 = np.array(G.resolve(ds, g0).frame_w), np.array(G.resolve(ds, g90).frame_w)
    c = f0.mean(0)
    assert np.allclose(f90.mean(0), c, atol=1e-6)
    # counter-clockwise 90 deg about the centre: (dx, dy) -> (-dy, dx)
    d0, d90 = f0 - c, f90 - c
    assert np.allclose(d90[:, 0], -d0[:, 1], atol=1e-6) and np.allclose(d90[:, 1], d0[:, 0], atol=1e-6)
    side0 = np.linalg.norm(f0[0] - f0[1])
    assert np.linalg.norm(f90[0] - f90[1]) == pytest.approx(side0, abs=1e-7)   # coordinates are ~1e6 m, so ~1e-10 float noise


def test_z_is_preserved_unless_offset_is_given(tmp_path):
    p, (x, y, z) = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    res = G.resolve(ds, G.build_place(ds, ANCHOR, z_offset=0))
    assert np.array_equal(res.z(z), z)
    res = G.resolve(ds, G.build_place(ds, ANCHOR, z_offset=12.5))
    assert np.allclose(res.z(z), z + 12.5)


def test_place_image_with_pixel_size(tmp_path):
    ds = make_ds(F.make_png_noref(tmp_path / "plan.png", w=120, h=80), tmp_path)
    with pytest.raises(GeorefError, match="[Pp]ixel size"):
        G.build_place(ds, ANCHOR)
    g = G.build_place(ds, ANCHOR, pixel_size=0.25)
    res = G.resolve(ds, g)
    aff = res.raster_affine
    assert aff.a == pytest.approx(0.25) and aff.e == pytest.approx(-0.25)
    lon, lat = center_lonlat(ds, g)
    assert (lon, lat) == (pytest.approx(77.6, abs=1e-9), pytest.approx(12.98, abs=1e-9))
    # footprint size in ground metres
    f = np.array(res.frame_w)
    assert np.linalg.norm(f[1] - f[0]) == pytest.approx(120 * 0.25, rel=1e-12)
    assert np.linalg.norm(f[3] - f[0]) == pytest.approx(80 * 0.25, rel=1e-12)
    assert G.verify(ds, g)["passed"]


def test_raster_rotation_matrix_is_exact(tmp_path):
    ds = make_ds(F.make_geotiff(tmp_path / "o.tif"), tmp_path)
    g = G.build_place(ds, ANCHOR, rotation_deg=30)
    res = G.resolve(ds, g)
    aff = res.raster_affine
    assert math.hypot(aff.a, aff.d) == pytest.approx(0.5, rel=1e-12)       # pixel size unchanged
    assert res.rotation_deg == pytest.approx(30, abs=1e-9)
    assert G.verify(ds, g)["passed"]


def test_raster_cannot_change_crs_or_scale(tmp_path):
    ds = make_ds(F.make_geotiff(tmp_path / "o.tif"), tmp_path)
    with pytest.raises(GeorefError, match="keeps its own CRS"):
        G.build_place(ds, ANCHOR, crs_text="EPSG:32644")
    with pytest.raises(GeorefError, match="Scale"):
        G.build_place(ds, ANCHOR, scale=2)


def test_rotation_refused_in_geographic_crs(tmp_path):
    ds = make_ds(F.make_geojson(tmp_path / "a.geojson"), tmp_path)
    with pytest.raises(GeorefError, match="projected"):
        G.build_place(ds, ANCHOR, crs_text="EPSG:4326", rotation_deg=10)
    g = G.build_place(ds, ANCHOR, rotation_deg=10)            # default W is UTM, so this is fine
    assert CRS.from_wkt(g["work_crs_wkt"]).to_epsg() == 32643 and G.verify(ds, g)["passed"]


def test_assign_crs_correct_and_wrong(tmp_path):
    ds = make_ds(F.make_shapefile_zip(tmp_path / "p.zip", with_prj=False), tmp_path)
    assert ds["status"] == "unreferenced"
    g = G.build_assign(ds, "EPSG:32643")
    s = G.summarize(ds, g)
    b = s["effective"]["bounds_wgs84"]
    assert b[0] <= F.LON <= b[2] and b[1] <= F.LAT <= b[3]      # polygon corner sits exactly on the fixture point
    assert b[2] - b[0] < 0.01 and b[3] - b[1] < 0.01
    with pytest.raises(GeorefError, match="CRS"):           # metres interpreted as degrees
        G.build_assign(ds, "EPSG:4326")
    with pytest.raises(GeorefError, match="area where"):      # a national grid for the wrong country
        G.build_assign(ds, "EPSG:27700")
    G.build_assign(ds, "EPSG:27700", confirm_outside_area=True)   # explicit override is possible


def test_assign_raster_without_transform_needs_grid(tmp_path):
    ds = make_ds(F.make_png_noref(tmp_path / "plan.png"), tmp_path)
    with pytest.raises(GeorefError, match="top-left"):
        G.build_assign(ds, "EPSG:32643")
    g = G.build_assign(ds, "EPSG:32643", grid={"origin_x": F.E0, "origin_y": F.N0, "pixel_x": 0.5})
    aff = G.resolve(ds, g).raster_affine
    assert (aff.c, aff.f, aff.a, aff.e) == (F.E0, F.N0, 0.5, -0.5)


def test_gcp_recovers_known_transform(tmp_path):
    ds = make_ds(F.make_png_noref(tmp_path / "plan.png", w=400, h=300), tmp_path)
    truth = Affine(0.2, 0, F.E0, 0, -0.2, F.N0)
    pts = []
    for col, row in [(10, 10), (390, 12), (395, 290), (8, 285), (200, 150)]:
        x, y = truth @ (col, row)
        pts.append({"col": col, "row": row, "x": x, "y": y})
    g = G.build_gcp(ds, "EPSG:32643", pts)
    got = Affine(*g["base_affine"])
    assert all(abs(a - b) < 1e-8 for a, b in zip(got[:6], truth[:6]))
    assert g["gcp"]["rmse_m"] < 1e-6


def test_gcp_reports_bad_point_in_residuals(tmp_path):
    ds = make_ds(F.make_png_noref(tmp_path / "plan.png", w=400, h=300), tmp_path)
    truth = Affine(0.2, 0, F.E0, 0, -0.2, F.N0)
    pts = []
    for col, row in [(10, 10), (390, 12), (395, 290), (8, 285), (200, 150)]:
        x, y = truth @ (col, row)
        pts.append({"col": col, "row": row, "x": x, "y": y})
    pts[4]["x"] += 5.0
    g = G.build_gcp(ds, "EPSG:32643", pts)
    assert g["gcp"]["rmse_m"] > 1.0 and max(g["gcp"]["residuals_m"]) > 2.0


def test_gcp_input_validation(tmp_path):
    ds = make_ds(F.make_png_noref(tmp_path / "plan.png"), tmp_path)
    with pytest.raises(GeorefError, match="At least 3"):
        G.build_gcp(ds, "EPSG:32643", [{"col": 1, "row": 1, "x": 1, "y": 1}] * 2)
    line = [{"col": i, "row": i, "x": F.E0 + i, "y": F.N0 + i} for i in (0, 10, 20, 30)]
    with pytest.raises(GeorefError, match="collinear"):
        G.build_gcp(ds, "EPSG:32643", line)


def test_invalid_inputs_are_rejected(tmp_path):
    p, _ = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    for bad in ({"lon": 200, "lat": 10}, {"lon": "x", "lat": 1}, {}, {"x": 1}):
        with pytest.raises(GeorefError):
            G.build_place(ds, bad)
    with pytest.raises(GeorefError):
        G.build_place(ds, ANCHOR, rotation_deg=float("nan"))
    with pytest.raises(GeorefError):
        G.build_place(ds, ANCHOR, crs_text="EPSG:99999999")


def test_place_with_projected_anchor(tmp_path):
    p, _ = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    g = G.build_place(ds, {"x": 500000.0, "y": 1450000.0, "crs": "EPSG:32643"})
    assert G.resolve(ds, g).forward([0], [0])[0][0] == pytest.approx(500000.0, abs=100)
    assert g["target"] == [500000.0, 1450000.0]


def test_replace_does_not_accumulate(tmp_path):
    """Placing twice gives the same result as placing once: placement is absolute, not incremental."""
    p, _ = F.make_las(tmp_path / "c.las", local=True)
    ds = make_ds(p, tmp_path)
    g1 = G.build_place(ds, ANCHOR, rotation_deg=40)
    g2 = G.build_place(ds, ANCHOR, prev=g1, rotation_deg=40)
    assert np.allclose(G.resolve(ds, g1).frame_w, G.resolve(ds, g2).frame_w, atol=1e-9)
    g3 = G.build_place(ds, ANCHOR, prev=g1, rotation_deg=0)
    assert G.resolve(ds, g3).rotation_deg == pytest.approx(0, abs=1e-9)
