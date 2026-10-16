"""Point cloud export: LAS, LAZ, XYZ (zip with .prj). The georeference override is applied to the coordinates."""
import math
import zipfile
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS

from .. import files
from .. import crs as C
from ..errors import ExportError
from ..pointio import CHUNK, TextSource, open_points
from .report import Report

SAMPLE = 50_000
RAW_DIMS = ("intensity", "classification", "return_number", "number_of_returns", "gps_time")


def targets(ds, res):
    warn = [] if res.state == "ready" else ["This point cloud has no CRS, so the output will hold local coordinates without a CRS."]
    return [
        {"format": "las", "label": "LAS", "extension": ".las", "available": True, "reason": None, "lossy": False,
         "losses": [], "warnings": warn},
        {"format": "laz", "label": "LAZ (compressed)", "extension": ".laz", "available": True, "reason": None, "lossy": False,
         "losses": [], "warnings": warn},
        {"format": "xyz", "label": "XYZ text (zip with .prj)", "extension": ".zip", "available": True, "reason": None,
         "lossy": True, "losses": ["Only X, Y, Z and RGB are kept (no intensity, classification or returns).",
                                   "Text has no CRS metadata; the CRS is written to a .prj file beside it."],
         "warnings": warn},
    ]


def _xform(res, target: CRS | None):
    t2 = None
    if target is not None and res.w_wkt:
        w = CRS.from_wkt(res.w_wkt)
        if not C.horizontal(w).equals(C.horizontal(target)):
            t2 = C.transformer(res.w_wkt, C.wkt(target))

    def f(x, y, z):
        X, Y = res.forward(x, y)
        if t2 is not None:
            X, Y = t2.transform(X, Y)
        return X, Y, res.z(z)
    return f


def _expected_bounds(meta, f):
    mins, maxs = meta["mins"], meta["maxs"]
    xs = np.array([mins[0], maxs[0], maxs[0], mins[0]])
    ys = np.array([mins[1], mins[1], maxs[1], maxs[1]])
    X, Y, _ = f(xs, ys, np.array([mins[2]] * 4))
    _, _, Z0 = f(xs[:1], ys[:1], np.array([mins[2]]))
    _, _, Z1 = f(xs[:1], ys[:1], np.array([maxs[2]]))
    return [float(X.min()), float(Y.min()), float(min(Z0[0], Z1[0]))], [float(X.max()), float(Y.max()), float(max(Z0[0], Z1[0]))]


class _Stats:
    def __init__(self, n, step):
        self.n, self.step = n, step
        self.mins = np.full(3, np.inf)
        self.maxs = np.full(3, -np.inf)
        self.count = 0
        self.sample = {k: [] for k in ("x", "y", "z", "red", "green", "blue") + RAW_DIMS}
        self.sample_dims = set()

    def add(self, X, Y, Z, extra: dict):
        s = self.count
        xyz = np.column_stack([X, Y, Z])
        self.mins, self.maxs = np.minimum(self.mins, xyz.min(0)), np.maximum(self.maxs, xyz.max(0))
        first = (-s) % self.step
        idx = np.arange(first, len(X), self.step)
        if len(idx):
            self.sample["x"].append(X[idx]); self.sample["y"].append(Y[idx]); self.sample["z"].append(Z[idx])
            for k, v in extra.items():
                self.sample[k].append(np.asarray(v)[idx])
                self.sample_dims.add(k)
        self.count += len(X)

    def arr(self, k):
        return np.concatenate(self.sample[k]) if self.sample[k] else np.array([])


def _write_las(src_path, ext, meta, f, target, dst, compress, progress):
    is_las_src = ext in (".las", ".laz")
    geographic = target is not None and C.is_geographic(target)
    scales = [1e-8, 1e-8, 0.001] if geographic else [0.001] * 3
    n = meta["points"]
    stats = _Stats(n, max(1, math.ceil(n / SAMPLE)))
    lo, hi = _expected_bounds(meta, f)
    if is_las_src:
        with laspy.open(src_path) as r:
            pf_id, version = r.header.point_format.id, str(r.header.version)
    else:
        pf_id, version = (2 if meta["has_rgb"] else 0), "1.2"
    header = laspy.LasHeader(point_format=pf_id, version=version)
    header.scales = scales
    header.offsets = [math.floor(lo[0]), math.floor(lo[1]), math.floor(lo[2])]
    if target is not None:
        header.add_crs(target)
    has_rgb_out = "red" in header.point_format.dimension_names
    done = 0
    with laspy.open(dst, mode="w", header=header, do_compress=compress) as w:
        if is_las_src:
            with laspy.open(src_path) as r:
                for pts in r.chunk_iterator(CHUNK):
                    X, Y, Z = f(np.asarray(pts.x), np.asarray(pts.y), np.asarray(pts.z))
                    new = laspy.ScaleAwarePointRecord.zeros(len(pts), header=header)
                    new.copy_fields_from(pts)
                    new.x, new.y, new.z = X, Y, Z
                    extra = {d: getattr(new, d) for d in RAW_DIMS if d in header.point_format.dimension_names}
                    if has_rgb_out:
                        extra.update(red=new.red, green=new.green, blue=new.blue)
                    stats.add(X, Y, Z, extra)
                    w.write_points(new)
                    done += len(pts)
                    progress(0.05 + 0.65 * done / n, "Writing points")
        else:
            src_pts = open_points(src_path, ext)
            for ch in src_pts.chunks(CHUNK):
                X, Y, Z = f(ch.x, ch.y, ch.z)
                new = laspy.ScaleAwarePointRecord.zeros(len(X), header=header)
                new.x, new.y, new.z = X, Y, Z
                extra = {}
                if has_rgb_out and ch.rgb is not None:
                    new.red, new.green, new.blue = (ch.rgb[:, i].astype(np.uint16) * 257 for i in range(3))
                    extra = {"red": new.red, "green": new.green, "blue": new.blue}
                stats.add(X, Y, Z, extra)
                w.write_points(new)
                done += len(X)
                progress(0.05 + 0.65 * done / n, "Writing points")
    return stats, scales


def _validate_las(dst, meta, target, stats: _Stats, scales, report: Report):
    try:
        r = laspy.open(dst)
    except Exception as e:
        report.fail("Output opens", f"The exported file could not be re-opened: {e}")
        return
    with r:
        h = r.header
        report.passed("Output opens", f"LAS {h.version}, point format {h.point_format.id}.")
        report.check("Point count", h.point_count == stats.count == meta["points"], f"{h.point_count:,} points.",
                     "The number of points changed during export.", meta["points"], h.point_count)
        tol = max(scales) * 1.5
        mins_ok = np.all(np.abs(np.array(h.mins) - stats.mins) <= tol)
        maxs_ok = np.all(np.abs(np.array(h.maxs) - stats.maxs) <= tol)
        report.check("Extent (X, Y, Z min/max)", bool(mins_ok and maxs_ok), "Header extent matches the transformed source extent.",
                     "Header extent differs from the transformed source extent.",
                     [stats.mins.tolist(), stats.maxs.tolist()], [list(map(float, h.mins)), list(map(float, h.maxs))])
        # sampled point-by-point comparison
        step = stats.step
        got = {k: [] for k in stats.sample}
        s = 0
        for pts in r.chunk_iterator(CHUNK):
            first = (-s) % step
            idx = np.arange(first, len(pts), step)
            if len(idx):
                got["x"].append(np.asarray(pts.x)[idx]); got["y"].append(np.asarray(pts.y)[idx]); got["z"].append(np.asarray(pts.z)[idx])
                for k in stats.sample_dims:
                    got[k].append(np.asarray(getattr(pts, k))[idx])
            s += len(pts)
        ok_n = 0
        for axis in ("x", "y", "z"):
            e = stats.arr(axis)
            g = np.concatenate(got[axis]) if got[axis] else np.array([])
            if e.shape != g.shape:
                report.fail(f"Sampled {axis.upper()} coordinates", "Sample sizes differ.", e.shape, g.shape)
                continue
            d = float(np.max(np.abs(e - g))) if len(e) else 0.0
            limit = scales[0 if axis != "z" else 2] * 0.5 + 1e-9 * max(1.0, float(np.max(np.abs(e))) if len(e) else 1.0)
            report.check(f"Sampled {axis.upper()} coordinates", d <= limit,
                         f"{len(e):,} sampled points; largest deviation {d:.2e} (storage resolution {scales[0 if axis != 'z' else 2]:g}).",
                         f"Coordinates deviate by {d:.3g}, more than the storage resolution.", f"<= {limit:.2e}", f"{d:.2e}")
        attr_bad = []
        for k in sorted(stats.sample_dims):
            e = stats.arr(k)
            g = np.concatenate(got[k]) if got[k] else np.array([])
            if e.shape != g.shape or not np.array_equal(e, g):
                attr_bad.append(k)
        if stats.sample_dims:
            report.check("Per-point attributes (colour, intensity, classification...)", not attr_bad,
                         "Sampled values identical to the source: " + ", ".join(sorted(stats.sample_dims)) + ".",
                         "Values differ for: " + ", ".join(attr_bad))
        if target is None:
            report.warn("CRS", "The source has no CRS, so the output has none either.")
        else:
            try:
                c = h.parse_crs()
                ok = c is not None and C.horizontal(C.parse(c)).equals(C.horizontal(target))
            except Exception:
                ok, c = False, None
            report.check("CRS in header", ok, f"{C.label(target)}.", "The CRS stored in the LAS header differs from the expected CRS.",
                         C.label(target), c.to_string() if c is not None else None)


def _write_xyz(src_path, ext, meta, f, target, dst_zip, progress):
    geographic = target is not None and C.is_geographic(target)
    prec = 9 if geographic else 4
    n = meta["points"]
    stats = _Stats(n, max(1, math.ceil(n / SAMPLE)))
    src_pts = open_points(src_path, ext)
    txt = dst_zip.with_suffix(".xyz")
    done = 0
    with open(txt, "w", newline="\n") as out:
        for ch in src_pts.chunks(CHUNK):
            X, Y, Z = f(ch.x, ch.y, ch.z)
            X, Y, Z = np.round(X, prec), np.round(Y, prec), np.round(Z, 4)
            rgb = ch.rgb
            extra = {"red": rgb[:, 0], "green": rgb[:, 1], "blue": rgb[:, 2]} if rgb is not None else {}
            stats.add(X, Y, Z, extra)
            cols = [X, Y, Z] + ([rgb[:, 0], rgb[:, 1], rgb[:, 2]] if rgb is not None else [])
            fmt = ["%.{}f".format(prec), "%.{}f".format(prec), "%.4f"] + (["%d"] * 3 if rgb is not None else [])
            np.savetxt(out, np.column_stack(cols), fmt=" ".join(fmt))
            done += len(X)
            progress(0.05 + 0.65 * done / n, "Writing points")
    with zipfile.ZipFile(dst_zip, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(txt, txt.name)
        if target is not None:
            z.writestr(txt.with_suffix(".prj").name, target.to_wkt(version="WKT1_ESRI"))
    txt.unlink()
    return stats


def _validate_xyz(dst_zip, meta, target, stats: _Stats, report: Report, work: Path):
    try:
        with zipfile.ZipFile(dst_zip) as z:
            z.extractall(work)
        xyz = next(work.glob("*.xyz"))
        src = TextSource(xyz)
    except Exception as e:
        report.fail("Output opens", f"The exported file could not be re-opened: {e}")
        return
    report.passed("Output opens", f"{src.count:,} points read back.")
    report.check("Point count", src.count == stats.count == meta["points"], "", "The number of points changed during export.",
                 meta["points"], src.count)
    prec_tol = 0.5e-4 + 1e-9
    step, s = stats.step, 0
    got = {"x": [], "y": [], "z": []}
    for ch in src.chunks(CHUNK):
        first = (-s) % step
        idx = np.arange(first, len(ch.x), step)
        got["x"].append(ch.x[idx]); got["y"].append(ch.y[idx]); got["z"].append(ch.z[idx])
        s += len(ch.x)
    geographic = target is not None and C.is_geographic(target)
    for axis in ("x", "y", "z"):
        e, g = stats.arr(axis), np.concatenate(got[axis])
        lim = (0.5e-9 if geographic and axis != "z" else prec_tol) + 1e-12
        d = float(np.max(np.abs(e - g))) if len(e) and e.shape == g.shape else float("inf")
        report.check(f"Sampled {axis.upper()} coordinates", d <= lim * 1.01, f"{len(e):,} sampled points; largest deviation {d:.2e}.",
                     f"Coordinates deviate by {d:.3g} after the text round trip.", f"<= {lim:.1e}", f"{d:.2e}")
    if target is None:
        report.warn("CRS", "The source has no CRS, so no .prj was written.")
    else:
        prj = next(work.glob("*.prj"), None)
        try:
            ok = prj is not None and C.horizontal(C.parse(prj.read_text())).equals(C.horizontal(target))
        except Exception:
            ok = False
        report.check(".prj CRS", ok, C.label(target), "The .prj file does not describe the expected CRS.", C.label(target), None)
    report.warn("Format", "XYZ text keeps only X, Y, Z and RGB. Use LAS/LAZ to keep every point attribute.")


def export(did, ds, g, res, fmt, crs_text, out_dir: Path, progress, base: str):
    meta = ds["meta"]
    src_path = files.source_path(did, meta)
    ext = meta["source_ext"]
    ready = res.state == "ready"
    if crs_text and not ready:
        raise ExportError("This point cloud has no CRS, so it cannot be reprojected. Place it or assign a CRS first.")
    target = None
    if ready:
        target = C.parse(crs_text) if crs_text else CRS.from_wkt(res.w_wkt)
    f = _xform(res, target)
    report = Report()
    if ready and res.method != "native":
        report.note(f"The georeference you set ({res.method}) is applied to the exported coordinates; the original upload is unchanged.")
    if ready and res.z_offset:
        report.note(f"A vertical offset of {res.z_offset:g} was added to Z. No geoid/datum conversion is applied.")
    if ready and C.horizontal(CRS.from_wkt(res.w_wkt)).equals(C.horizontal(target)) is False:
        report.note(f"Coordinates were reprojected to {C.label(target)}.")
    out_dir.mkdir(parents=True, exist_ok=True)
    if fmt in ("las", "laz"):
        dst = out_dir / f"{base}.{fmt}"
        stats, scales = _write_las(src_path, ext, meta, f, target, dst, fmt == "laz", progress)
        progress(0.75, "Validating output")
        _validate_las(dst, meta, target, stats, scales, report)
        return dst, report
    if fmt == "xyz":
        dst = out_dir / f"{base}.zip"
        stats = _write_xyz(src_path, ext, meta, f, target, dst, progress)
        progress(0.75, "Validating output")
        work = out_dir / "_chk"
        work.mkdir(exist_ok=True)
        _validate_xyz(dst, meta, target, stats, report, work)
        import shutil
        shutil.rmtree(work, ignore_errors=True)
        return dst, report
    raise ExportError(f"Unsupported point cloud export format '{fmt}'.")
