"""Vector export: GeoPackage, GeoJSON, Shapefile (zip), KML, DXF. Outputs are re-read and compared with the source."""
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pyogrio
import shapely
from pyproj import CRS

from .. import files, render, vectorio
from .. import crs as C
from ..errors import ExportError
from .report import Report

SPECS = {
    "gpkg": dict(label="GeoPackage", ext=".gpkg", driver="GPKG", crs4326=False, attrs=True,
                 losses=[]),
    "geojson": dict(label="GeoJSON", ext=".geojson", driver="GeoJSON", crs4326=True, attrs=True,
                    losses=["GeoJSON is WGS84 only, so coordinates are reprojected to longitude/latitude."]),
    "shapefile": dict(label="Shapefile (zip)", ext=".zip", driver="ESRI Shapefile", crs4326=False, attrs=True,
                      losses=["Field names are limited to 10 characters and may be shortened.",
                              "A shapefile holds one geometry type and is limited to 2 GB."]),
    "kml": dict(label="KML", ext=".kml", driver="KML", crs4326=True, attrs=True,
                losses=["KML is WGS84 only, so coordinates are reprojected.", "Attribute support is limited."]),
    "dxf": dict(label="DXF", ext=".dxf", driver="DXF", crs4326=False, attrs=False,
                losses=["DXF stores no attributes and no CRS.", "Polygons are stored as closed polylines."]),
}


def _writable(driver):
    caps = pyogrio.list_drivers().get(driver, "")
    return "w" in caps


def targets(ds, res):
    gtype = ds["meta"]["geometry_type"]
    ready = res.state == "ready"
    warn = [] if ready else ["This dataset has no CRS, so the output will contain local coordinates without a CRS."]
    out = []
    for fmt, s in SPECS.items():
        reason = None
        if not _writable(s["driver"]):
            reason = f"The {s['label']} writer is not available in this installation."
        elif fmt == "shapefile" and (gtype.startswith("Unknown") or "Collection" in gtype):
            reason = "A shapefile holds a single geometry type; this dataset mixes types. Use GeoPackage."
        elif s["crs4326"] and not ready:
            reason = f"{s['label']} needs a CRS to convert coordinates to WGS84. Georeference the dataset first."
        out.append({"format": fmt, "label": s["label"], "extension": s["ext"], "available": reason is None, "reason": reason,
                    "lossy": bool(s["losses"]) and fmt != "geojson", "losses": s["losses"], "warnings": warn})
    return out


def _crs_equal(a: CRS, b: CRS):
    a, b = C.horizontal(a), C.horizontal(b)
    if a.equals(b) or a.equals(b, ignore_axis_order=True):
        return True
    ea, eb = C.epsg(a), C.epsg(b)
    return ea is not None and ea == eb


def _same_value(a, b):
    if a is None or (isinstance(a, float) and np.isnan(a)):
        return b is None or (isinstance(b, float) and np.isnan(b)) or b == ""
    if isinstance(a, (int, float, np.integer, np.floating)) and isinstance(b, (int, float, np.integer, np.floating)):
        return bool(np.isclose(float(a), float(b), rtol=1e-12, atol=0))
    return str(a) == str(b)


def _tol_units(crs: CRS, metres: float, lat=0.0):
    return metres / C.meters_per_unit(crs, lat)


def _compare_geoms(exp, got, tol):
    en, gn = shapely.normalize(exp), shapely.normalize(got)
    bad = ~np.asarray(shapely.equals_exact(en, gn, tol))
    maxd = 0.0
    for i in np.flatnonzero(bad)[:200]:
        if en[i] is None or gn[i] is None:
            continue
        ce, cg = shapely.get_coordinates(en[i]), shapely.get_coordinates(gn[i])
        if ce.shape == cg.shape:
            maxd = max(maxd, float(np.abs(ce - cg).max()))
        else:
            maxd = float("inf")
    return int(bad.sum()), maxd


def _read_back(path: Path, fmt: str, tmp: Path):
    if fmt == "shapefile":
        with zipfile.ZipFile(path) as z:
            z.extractall(tmp)
        shp = next(tmp.rglob("*.shp"))
        return vectorio.read_all(shp)
    return vectorio.read_all(path)


def export(did, ds, g, res, fmt, crs_text, out_dir: Path, progress, base: str):
    if fmt not in SPECS:
        raise ExportError(f"Unsupported vector export format '{fmt}'.")
    spec = SPECS[fmt]
    meta = ds["meta"]
    report = Report()
    progress(0.05, "Reading source")
    if res.state == "ready":
        geoms, fields, _ = render.effective_vector(did, ds, g)
        w_crs = CRS.from_wkt(res.w_wkt)
        if res.method != "native":
            report.note(f"The georeference you set ({res.method}) is applied to the exported coordinates; the original upload is unchanged.")
    else:
        _i, geoms, fields = vectorio.read_all(files.source_path(did, meta), meta["layer"])
        w_crs = None
    if w_crs is None and (spec["crs4326"] or crs_text):
        raise ExportError("This dataset has no CRS, so it cannot be reprojected. Georeference it first.")
    target = CRS.from_epsg(4326) if spec["crs4326"] else (C.parse(crs_text) if crs_text else w_crs)
    if w_crs is not None and not _crs_equal(w_crs, target):
        report.note(f"Coordinates were reprojected from {C.label(w_crs)} to {C.label(target)}.")
        t = C.transformer(C.wkt(w_crs), C.wkt(target))
        has_z = bool(np.any(shapely.has_z(geoms[~shapely.is_missing(geoms)]))) if len(geoms) else False

        def fn(c):
            o = np.array(c, float, copy=True)
            o[:, 0], o[:, 1] = t.transform(c[:, 0], c[:, 1])
            return o

        geoms = shapely.transform(geoms, fn, include_z=has_z)
        if not np.isfinite(shapely.get_coordinates(geoms)).all():
            raise ExportError(f"Some coordinates cannot be expressed in {C.label(target)}. Choose a CRS that covers the data.")
    crs_wkt = C.wkt(target) if w_crs is not None else None
    out_dir.mkdir(parents=True, exist_ok=True)
    out_fields = fields if spec["attrs"] else {}

    progress(0.3, f"Writing {spec['label']}")
    if fmt == "shapefile":
        stage = out_dir / "_shp"
        stage.mkdir(exist_ok=True)
        vectorio.write(stage / f"{base}.shp", geoms, out_fields, spec["driver"], crs_wkt=crs_wkt, layer=base)
        dst = out_dir / f"{base}.zip"
        with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(stage.iterdir()):
                z.write(p, p.name)
    else:
        dst = out_dir / f"{base}{spec['ext']}"
        try:
            vectorio.write(dst, geoms, out_fields, spec["driver"], crs_wkt=crs_wkt, layer=base)
        except Exception as e:
            raise ExportError(f"The {spec['label']} writer failed: {e}")

    progress(0.7, "Validating output")
    with tempfile.TemporaryDirectory() as td:
        try:
            info, got, got_fields = _read_back(dst, fmt, Path(td))
        except Exception as e:
            report.fail("Output opens", f"The exported file could not be re-opened: {e}")
            return dst, report
        report.passed("Output opens", f"Driver {info.get('driver')}.")
        n_exp, n_got = len(geoms), len(got)
        report.check("Feature count", n_exp == n_got, f"{n_got} features.", "The number of features changed during export.",
                     n_exp, n_got)
        if n_exp == n_got:
            exp_cmp = geoms
            as_lines = np.isin(shapely.get_type_id(geoms), (3, 6)) & np.isin(shapely.get_type_id(got), (1, 2, 5))
            if as_lines.any():
                exp_cmp = np.where(as_lines, shapely.boundary(geoms), geoms)      # compare outlines when polygons come back as lines
                report.warn("Geometry types", f"{int(as_lines.sum())} polygon(s) were stored as closed lines by {spec['label']}.")
            else:
                t_exp, t_got = set(shapely.get_type_id(geoms).tolist()), set(shapely.get_type_id(got).tolist())
                if t_exp != t_got:
                    report.warn("Geometry types", "Geometry types changed during export.", sorted(t_exp), sorted(t_got))
                else:
                    report.passed("Geometry types", "Unchanged.")
            lat = float(np.nanmean(shapely.get_coordinates(geoms)[:, 1])) if C.is_geographic(target) and len(geoms) else 0.0
            tight, loose = _tol_units(target, 0.001, lat), _tol_units(target, 0.1, lat)
            nb, md = _compare_geoms(exp_cmp, got, tight)
            if nb == 0:
                report.passed("Coordinates", "Every geometry matches the source within 1 mm.", "within 1 mm", "within 1 mm")
            else:
                nb2, md2 = _compare_geoms(exp_cmp, got, loose)
                m = md * C.meters_per_unit(target, lat)
                if nb2 == 0:
                    report.warn("Coordinates", f"{nb} geometries differ by up to {m:.4f} m: the format stores reduced precision.",
                                "within 1 mm", f"max {m:.4f} m")
                else:
                    report.fail("Coordinates", f"{nb2} geometries differ by more than 0.1 m from the source.", "within 1 mm",
                                "max > 0.1 m" if not np.isfinite(md2) else f"max {md2 * C.meters_per_unit(target, lat):.3f} m")
            if bool(np.any(shapely.has_z(exp_cmp[~shapely.is_missing(exp_cmp)]))) if len(exp_cmp) else False:
                ze = np.concatenate([shapely.get_coordinates(shapely.normalize(x), include_z=True)[:, 2] for x in exp_cmp[:2000] if x is not None])
                zg = np.concatenate([shapely.get_coordinates(shapely.normalize(x), include_z=True)[:, 2] for x in got[:2000] if x is not None])
                if ze.shape == zg.shape:
                    dz = float(np.nanmax(np.abs(ze - zg))) if len(ze) else 0.0
                    report.check("Elevation (Z)", dz < 1e-3, f"Z values preserved (max difference {dz:.2e}).",
                                 f"Z values differ by up to {dz:.3g}.", "< 1 mm", f"{dz:.3g}")
                else:
                    report.warn("Elevation (Z)", "Z values could not be compared (vertex layout changed).")
        # CRS
        if crs_wkt is None:
            report.warn("CRS", "The source has no CRS, so the output has none either.")
        elif info.get("crs") is None:
            if fmt == "dxf":
                report.warn("CRS", f"DXF cannot store a CRS. The coordinates are in {C.label(target)}; keep that with the file.")
            else:
                report.fail("CRS", "The output has no CRS.", C.label(target), None)
        else:
            try:
                ok = _crs_equal(C.parse(info["crs"]), target)
            except Exception:
                ok = False
            report.check("CRS", ok, f"{C.label(target)}.", "The CRS in the output differs from the expected CRS.",
                         C.label(target), str(info["crs"])[:80])
        # attributes
        exp_names = list(fields)
        if not spec["attrs"]:
            if exp_names:
                report.warn("Attributes", f"{len(exp_names)} attribute field(s) are not supported by {spec['label']} and were not written.",
                            exp_names, [])
        else:
            got_names = list(got_fields)
            missing = [n for n in exp_names if n not in got_names]
            if not missing:
                report.passed("Attribute fields", f"{len(exp_names)} field(s) present.", exp_names, got_names)
            else:
                renamed = [n for n in missing if any(g_.lower().startswith(n[:8].lower()) for g_ in got_names)]
                level = "WARN" if len(missing) == len(renamed) or fmt in ("kml",) else "FAIL"
                report.add("Attribute fields", level,
                           ("Some field names were shortened or are not preserved by " + spec["label"] + ": " + ", ".join(missing)),
                           exp_names, got_names)
            if n_exp == n_got:
                pairs = [(n, n) for n in exp_names if n in got_fields]
                taken = {b for _, b in pairs}
                for n in missing:                       # a shortened name still gets its values compared
                    cand = [g_ for g_ in got_names if g_ not in taken and g_.lower().startswith(n[:8].lower())]
                    if len(cand) == 1:
                        pairs.append((n, cand[0]))
                        taken.add(cand[0])
                bad = 0
                for en_, gn_ in pairs:
                    a, b = fields[en_][:5000], got_fields[gn_][:5000]
                    bad += sum(0 if _same_value(x, y) else 1 for x, y in zip(a, b))
                if pairs:
                    report.check("Attribute values", bad == 0, f"Compared {len(pairs)} field(s) over up to 5000 rows.",
                                 f"{bad} attribute values differ from the source.", "0 differences", f"{bad} differences")
    return dst, report
