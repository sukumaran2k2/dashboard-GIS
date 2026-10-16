import hashlib
import io
import json

import numpy as np
import pytest
import rasterio
from PIL import Image

import fixtures as F


@pytest.fixture()
def project(client):
    return client.post("/api/projects", json={"name": "Test"}).json()["id"]


def upload(client, pid, path, name=None):
    with open(path, "rb") as f:
        return client.post(f"/api/projects/{pid}/upload", files={"file": (name or path.name, f)})


def test_project_crud(client):
    pid = client.post("/api/projects", json={"name": "  Survey A "}).json()["id"]
    assert client.patch(f"/api/projects/{pid}", json={"name": "Survey B"}).status_code == 200
    assert any(p["name"] == "Survey B" for p in client.get("/api/projects").json())
    assert client.post("/api/projects", json={"name": "   "}).status_code == 400
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.patch(f"/api/projects/{pid}", json={"name": "x"}).status_code == 404


def test_upload_and_open_each_kind_independently(client, project, tmp_path):
    for path, kind in [(F.make_geotiff(tmp_path / "o.tif"), "raster"), (F.make_shapefile_zip(tmp_path / "p.zip"), "vector"),
                       (F.make_las(tmp_path / "c.las")[0], "pointcloud"), (F.make_geojson(tmp_path / "a.geojson"), "vector")]:
        r = upload(client, project, path)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["kind"] == kind and d["effective_status"] == "ready"
        one = client.get(f"/api/datasets/{d['id']}").json()
        assert one["georef"]["bounds_wgs84"] and one["id"] == d["id"]


def test_rejects_bad_uploads_with_clear_messages(client, project, tmp_path):
    bad = tmp_path / "bad.tif"
    bad.write_bytes(b"nope" * 50)
    r = upload(client, project, bad)
    assert r.status_code == 422 and "readable raster" in r.json()["detail"]
    dwg = tmp_path / "x.dwg"
    dwg.write_bytes(b"x")
    assert "proprietary" in upload(client, project, dwg).json()["detail"]
    assert client.post("/api/projects/nope/upload", files={"file": ("a.tif", b"x")}).status_code == 404
    assert client.get("/api/datasets").json() is not None


def test_raster_tile_renders_inside_and_empty_outside(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif", w=2000, h=2000, res=0.1)).json()
    b = d["georef"]["bounds_wgs84"]
    import math
    z = 19
    lon, lat = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    r = client.get(f"/api/datasets/{d['id']}/tiles/{z}/{x}/{y}.png")
    assert r.status_code == 200
    a = np.array(Image.open(io.BytesIO(r.content)))
    assert a.shape == (256, 256, 4) and a[..., 3].max() == 255
    far = client.get(f"/api/datasets/{d['id']}/tiles/{z}/{x + 500}/{y}.png")
    assert np.array(Image.open(io.BytesIO(far.content)))[..., 3].max() == 0


def _tile_xy(lon, lat, z):
    import math
    n = 2 ** z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def test_large_raster_uses_a_derived_pyramid_and_never_touches_the_original(client, project, tmp_path):
    from app import config
    src = F.make_geotiff(tmp_path / "big.tif", w=4200, h=4200, res=0.05, fill=200)      # 17.6 Mpx -> pyramid built
    sha = hashlib.sha256(src.read_bytes()).hexdigest()
    d = upload(client, project, src).json()
    assert d["meta"]["pyramid"] and (config.FILES / d["id"] / "cache" / "pyramid.tif").exists()
    b = d["georef"]["bounds_wgs84"]
    lon, lat = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    for z in (15, 20):                                    # low zoom reads the pyramid, high zoom reads the original
        x, y = _tile_xy(lon, lat, z)
        a = np.array(Image.open(io.BytesIO(client.get(f"/api/datasets/{d['id']}/tiles/{z}/{x}/{y}.png").content)))
        inside = a[..., 3] == 255
        assert inside.any() and set(np.unique(a[inside][:, :3])) == {200}, f"z={z}"
    client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "place", "anchor": {"lon": lon, "lat": lat}, "rotation_deg": 20})
    x, y = _tile_xy(lon, lat, 15)
    a = np.array(Image.open(io.BytesIO(client.get(f"/api/datasets/{d['id']}/tiles/15/{x}/{y}.png").content)))
    assert (a[..., 3] == 255).any() and set(np.unique(a[a[..., 3] == 255][:, :3])) == {200}
    assert hashlib.sha256((config.FILES / d["id"] / f"original.tif").read_bytes()).hexdigest() == sha


def test_dem_nodata_is_transparent(client, project, tmp_path):
    p = F.make_geotiff(tmp_path / "dem.tif", count=1, dtype="float32", nodata=-9999.0, w=256, h=256, res=0.05)
    d = upload(client, project, p).json()
    assert d["category"] == "dem"
    import math
    b = d["georef"]["bounds_wgs84"]
    z = 21
    n = 2 ** z
    # tile containing the north-west (nodata) corner region
    lon, lat = b[0] + 1e-9, b[3] - 1e-9
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    a = np.array(Image.open(io.BytesIO(client.get(f"/api/datasets/{d['id']}/tiles/{z}/{x}/{y}.png").content)))
    assert (a[..., 3] == 0).any() and (a[..., 3] == 255).any()


def test_vector_geojson_and_attributes(client, project, tmp_path):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip")).json()
    g = client.get(f"/api/datasets/{d['id']}/geojson").json()
    assert len(g["features"]) == 2
    lon, lat = g["features"][0]["geometry"]["coordinates"][0][0]
    assert lon == pytest.approx(F.LON, abs=1e-7) and lat == pytest.approx(F.LAT, abs=1e-7)
    assert g["features"][0]["properties"]["name"] == "alpha"
    rows = client.get(f"/api/datasets/{d['id']}/features?limit=1").json()
    assert rows["total"] == 2 and len(rows["rows"]) == 1 and "val" in rows["fields"]


def test_unreferenced_vector_flow_assign_crs(client, project, tmp_path):
    d = upload(client, project, F.make_shapefile_zip(tmp_path / "p.zip", with_prj=False)).json()
    assert d["effective_status"] == "unreferenced"
    assert client.get(f"/api/datasets/{d['id']}/geojson").status_code == 409
    assert client.get(f"/api/datasets/{d['id']}/geojson?frame=native").status_code == 200
    bad = client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "assign", "crs": "EPSG:4326"})
    assert bad.status_code == 422 and "CRS" in bad.json()["detail"]
    ok = client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "assign", "crs": "EPSG:32643"})
    assert ok.status_code == 200 and ok.json()["dataset"]["effective_status"] == "ready"
    g = client.get(f"/api/datasets/{d['id']}/geojson").json()
    lon, lat = g["features"][0]["geometry"]["coordinates"][0][0]
    assert lon == pytest.approx(F.LON, abs=1e-7)


def test_placement_persists_across_requests_and_never_touches_source_or_others(client, project, tmp_path):
    cloud, _ = F.make_las(tmp_path / "scan.las", local=True)
    a = upload(client, project, cloud).json()
    other = upload(client, project, F.make_las(tmp_path / "other.las", local=True, seed=9)[0]).json()
    ortho = upload(client, project, F.make_geotiff(tmp_path / "o.tif")).json()
    assert a["effective_status"] == "unreferenced"
    before = {x["id"]: client.get(f"/api/datasets/{x['id']}").json()["georef"] for x in (other, ortho)}
    sha_before = hashlib.sha256(cloud.read_bytes()).hexdigest()

    body = {"mode": "place", "anchor": {"lon": 77.6, "lat": 12.98}, "rotation_deg": 25, "z_offset": 2.0}
    pv = client.post(f"/api/datasets/{a['id']}/georef/preview", json=body).json()
    assert pv["verification"]["passed"] and pv["effective"]["rotation_deg"] == pytest.approx(25)
    assert client.get(f"/api/datasets/{a['id']}").json()["effective_status"] == "unreferenced"   # preview saved nothing

    saved = client.put(f"/api/datasets/{a['id']}/georef", json=body)
    assert saved.status_code == 200
    s1 = client.get(f"/api/datasets/{a['id']}/georef").json()
    assert s1["effective"]["center_wgs84"] == pytest.approx([77.6, 12.98], abs=1e-9)
    assert s1["effective"]["rotation_deg"] == pytest.approx(25, abs=1e-9) and s1["effective"]["z_offset"] == 2.0
    assert s1["override"]["verification"]["passed"]

    for x in (other, ortho):                                  # other datasets untouched
        assert client.get(f"/api/datasets/{x['id']}").json()["georef"] == before[x["id"]]
    assert client.get(f"/api/datasets/{a['id']}/integrity").json()["unchanged"]
    assert hashlib.sha256(cloud.read_bytes()).hexdigest() == sha_before

    # revert returns to as-uploaded
    client.delete(f"/api/datasets/{a['id']}/georef")
    assert client.get(f"/api/datasets/{a['id']}").json()["effective_status"] == "unreferenced"
    hist = client.get(f"/api/datasets/{a['id']}/georef").json()["history"]
    assert len(hist) >= 2
    first_state = [h for h in hist if h["as_uploaded"]]
    assert first_state


def test_placement_survives_restart(tmp_path):
    """Re-open the SQLite file from a fresh process-like state: the same effective bounds come back."""
    import subprocess, sys, os, textwrap
    from pathlib import Path as P
    tests_dir = P(F.__file__).resolve().parent
    data = tmp_path / "data"
    code = textwrap.dedent(f"""
        import os, sys, json
        os.environ['GEODASH_DATA'] = r'{data}'
        sys.path.insert(0, r'{tests_dir.parent}')
        sys.path.insert(0, r'{tests_dir}')
        from fastapi.testclient import TestClient
        from app.main import app
        import fixtures as F
        from pathlib import Path
        mode = sys.argv[1]
        with TestClient(app) as c:
            if mode == 'write':
                pid = c.post('/api/projects', json={{'name':'r'}}).json()['id']
                p, _ = F.make_las(Path(r'{tmp_path}') / 'a.las', local=True)
                d = c.post(f'/api/projects/{{pid}}/upload', files={{'file': ('a.las', open(p,'rb'))}}).json()
                r = c.put(f"/api/datasets/{{d['id']}}/georef", json={{'mode':'place','anchor':{{'lon':77.6,'lat':12.98}},'rotation_deg':33}})
                print(json.dumps(c.get(f"/api/datasets/{{d['id']}}").json()['georef']))
            else:
                ds = c.get('/api/datasets').json()[0]
                print(json.dumps(ds['georef']))
    """)
    script = tmp_path / "run.py"
    script.write_text(code)
    env = {**os.environ, "GEODASH_DATA": str(data)}
    a = subprocess.run([sys.executable, str(script), "write"], capture_output=True, text=True, env=env)
    b = subprocess.run([sys.executable, str(script), "read"], capture_output=True, text=True, env=env)
    assert a.returncode == 0, a.stderr[-800:]
    assert b.returncode == 0, b.stderr[-800:]
    assert json.loads(a.stdout.strip().splitlines()[-1]) == json.loads(b.stdout.strip().splitlines()[-1])


def test_crs_endpoints(client):
    assert any(c["code"] == "32643" for c in client.get("/api/crs/search", params={"q": "32643"}).json())
    assert client.get("/api/crs/utm", params={"lon": 77.6, "lat": 12.9}).json()["epsg"] == 32643
    assert client.get("/api/crs/utm", params={"lon": 77.6, "lat": 89}).status_code == 422
    r = client.post("/api/crs/transform", json={"source": "EPSG:4326", "target": "EPSG:32643", "points": [[77.6, 12.9]]}).json()
    assert r["points"][0][0] == pytest.approx(F.Transformer.from_crs(4326, 32643, always_xy=True).transform(77.6, 12.9)[0])
    assert client.get("/api/crs/describe", params={"text": "bogus"}).status_code == 422


def test_measure_is_geodesic_on_wgs84(client):
    # one degree of longitude along the equator on WGS84 is 111 319.49 m
    r = client.post("/api/measure", json={"points": [[0, 0], [1, 0]]}).json()
    assert r["length_m"] == pytest.approx(111319.4908, abs=0.01) and r["area_m2"] is None
    # independent check with a projected square: 100 m x 100 m in UTM 43N is 10 000 m2 on the ground
    t = F.Transformer.from_crs(32643, 4326, always_xy=True)
    sq = [t.transform(F.E0 + dx, F.N0 + dy) for dx, dy in ((0, 0), (100, 0), (100, 100), (0, 100))]
    r = client.post("/api/measure", json={"points": [list(p) for p in sq]}).json()
    assert r["area_m2"] == pytest.approx(10000, rel=2e-3)          # UTM scale factor near the zone centre is ~0.9996-1.0004
    assert r["perimeter_m"] == pytest.approx(400, rel=2e-3)
    assert client.post("/api/measure", json={"points": [[0, 0]]}).status_code == 422
    assert client.post("/api/measure", json={"points": [[0, 0], [200, 0]]}).status_code == 422


def test_gcp_over_api_makes_image_appear(client, project, tmp_path):
    d = upload(client, project, F.make_png_noref(tmp_path / "plan.png", w=400, h=300)).json()
    assert d["effective_status"] == "unreferenced"
    pts = []
    for col, row in [(0, 0), (400, 0), (400, 300), (0, 300)]:
        pts.append({"col": col, "row": row, "x": F.E0 + col * 0.2, "y": F.N0 - row * 0.2})
    r = client.put(f"/api/datasets/{d['id']}/georef", json={"mode": "gcp", "crs": "EPSG:32643", "points": pts})
    assert r.status_code == 200, r.text
    assert r.json()["override"]["gcp"]["rmse_m"] < 1e-6
    assert client.get(f"/api/datasets/{d['id']}").json()["effective_status"] == "ready"
    assert client.get(f"/api/datasets/{d['id']}/image.png").status_code == 200


def test_rename_and_notes_persist_and_are_trimmed(client, project, tmp_path):
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif")).json()
    assert d["notes"] == ""
    r = client.patch(f"/api/datasets/{d['id']}", json={"filename": "  Pier survey.tif ", "notes": "  Flown 12 Oct, DJI M300, 80 m AGL \n"})
    assert r.status_code == 200
    got = client.get(f"/api/datasets/{d['id']}").json()
    assert got["filename"] == "Pier survey.tif" and got["notes"] == "Flown 12 Oct, DJI M300, 80 m AGL"
    assert client.patch(f"/api/datasets/{d['id']}", json={"filename": "   "}).status_code == 400
    assert len(client.patch(f"/api/datasets/{d['id']}", json={"notes": "x" * 5000}).json()) and \
        len(client.get(f"/api/datasets/{d['id']}").json()["notes"]) == 2000
    assert any(x["id"] == d["id"] and x["notes"] for x in client.get("/api/datasets").json())


def test_job_list_names_the_dataset(client, project, tmp_path):
    import time
    d = upload(client, project, F.make_geotiff(tmp_path / "named.tif")).json()
    jid = client.post(f"/api/datasets/{d['id']}/export", json={"format": "geotiff"}).json()["job_id"]
    for _ in range(100):
        if client.get(f"/api/jobs/{jid}").json()["state"] in ("done", "failed"):
            break
        time.sleep(0.1)
    rows = client.get("/api/jobs").json()
    mine = next(r for r in rows if r["id"] == jid)
    assert mine["dataset_filename"] == "named.tif" and mine["project_id"] == project
    assert [r["id"] for r in client.get(f"/api/jobs?dataset={d['id']}").json()] == [jid]


def test_delete_dataset_removes_files(client, project, tmp_path):
    from app import config
    d = upload(client, project, F.make_geotiff(tmp_path / "o.tif")).json()
    assert (config.FILES / d["id"]).exists()
    assert client.delete(f"/api/datasets/{d['id']}").status_code == 200
    assert not (config.FILES / d["id"]).exists()
    assert client.get(f"/api/datasets/{d['id']}").status_code == 404
