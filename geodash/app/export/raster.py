"""Raster export: GeoTIFF, Cloud-Optimized GeoTIFF, PNG + world file. Every output is re-opened and compared."""
import random
import shutil
import warnings
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
import rasterio
import rasterio.shutil
from affine import Affine
from pyproj import CRS
from rasterio.crs import CRS as RioCRS
from rasterio.enums import ColorInterp, MaskFlags
from rasterio.errors import NotGeoreferencedWarning
from rasterio.windows import Window

from .. import config, files, geo, render
from .. import crs as C
from ..errors import ExportError
from .report import Report

BLOCK = 512
FLOAT = ("float32", "float64")
INTS = ("uint8", "int8", "uint16", "int16", "uint32", "int32")


def _rotated(a: Affine | None):
    return a is not None and (abs(a.b) > 1e-12 * abs(a.a) or abs(a.d) > 1e-12 * abs(a.e))


def _png_lossless(meta):
    n = meta["bands"]
    if meta["dtype"] != "uint8" or meta["nodata"] is not None:
        return False
    return (n in (1, 3)) or (n in (2, 4) and meta["has_alpha"])


def targets(ds, res):
    meta = ds["meta"]
    ready = res.state == "ready"
    rot = _rotated(res.raster_affine) if ready else False
    warn = [] if ready else ["This raster has no CRS or ground coordinates, so the output will carry none either."]
    png_lossless = _png_lossless(meta)
    return [
        {"format": "geotiff", "label": "GeoTIFF", "extension": ".tif", "available": True, "reason": None, "lossy": False,
         "losses": [], "warnings": warn},
        {"format": "cog", "label": "Cloud-Optimized GeoTIFF", "extension": ".tif",
         "available": ready and not rot,
         "reason": None if ready and not rot else ("COG needs ground coordinates." if not ready else
                                                  "COG requires a north-up grid; this raster is rotated. Export as GeoTIFF instead."),
         "lossy": False, "losses": [], "warnings": []},
        {"format": "png", "label": "PNG + world file (zip)", "extension": ".zip",
         "available": meta["width"] * meta["height"] <= config.PNG_EXPORT_MAX_PIXELS,
         "reason": None if meta["width"] * meta["height"] <= config.PNG_EXPORT_MAX_PIXELS else
         f"Too large for PNG ({config.PNG_EXPORT_MAX_PIXELS:,} pixel limit).",
         "lossy": not png_lossless,
         "losses": [] if png_lossless else
         ["Pixel values are converted to 8-bit display colours; elevation or multi-band values are not preserved.",
          "NoData becomes transparency."],
         "warnings": warn},
    ]


# ----------------------------------------------------------------------------- writing
def _windows(w, h):
    for r in range(0, h, BLOCK):
        for c in range(0, w, BLOCK):
            yield Window(c, r, min(BLOCK, w - c), min(BLOCK, h - r))


def _write_geotiff(src_path, dst, crs_wkt, affine, progress, p0=0.0, p1=1.0):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(src_path) as src:
            profile = dict(driver="GTiff", width=src.width, height=src.height, count=src.count, dtype=src.dtypes[0],
                           nodata=src.nodata, tiled=True, blockxsize=256, blockysize=256, compress="deflate", BIGTIFF="IF_SAFER")
            if src.dtypes[0] in FLOAT:
                profile["predictor"] = 3
            elif src.dtypes[0] in INTS:
                profile["predictor"] = 2
            if crs_wkt:
                profile["crs"] = RioCRS.from_wkt(crs_wkt)
                profile["transform"] = affine
            flags = src.mask_flag_enums[0]
            copy_mask = MaskFlags.per_dataset in flags and MaskFlags.alpha not in flags and MaskFlags.nodata not in flags
            wins = list(_windows(src.width, src.height))
            with rasterio.open(dst, "w", **profile) as out:
                try:
                    out.colorinterp = src.colorinterp
                except Exception:
                    pass
                out.descriptions = src.descriptions
                try:
                    out.scales, out.offsets, out.units = src.scales, src.offsets, src.units
                except Exception:
                    pass
                out.update_tags(**src.tags())
                for i, w in enumerate(wins):
                    out.write(src.read(window=w), window=w)
                    if copy_mask:
                        out.write_mask(src.dataset_mask(window=w), window=w)
                    if i % 8 == 0:
                        progress(p0 + (p1 - p0) * i / len(wins), "Writing pixels")


def _png_array(src_path, meta):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(src_path) as src:
            lossless = _png_lossless(meta)
            if lossless:
                arr = src.read()
                if arr.shape[0] == 1:
                    return arr[0], "L"
                if arr.shape[0] == 2:
                    return np.dstack([arr[0], arr[1]]), "LA"
                return np.moveaxis(arr, 0, -1), "RGB" if arr.shape[0] == 3 else "RGBA"
            n_data = meta["bands"] - (1 if meta["has_alpha"] else 0)
            idx = [1, 2, 3] if n_data >= 3 else [1]
            arr = src.read(idx, masked=True)
            valid = ~np.ma.getmaskarray(arr).any(0)
            if meta["has_alpha"]:
                valid &= src.read(src.count) > 0
            rgb = render._to_rgb(np.ma.filled(arr.astype(np.float64), 0), meta, len(idx))
            return np.dstack([rgb, (valid * 255).astype(np.uint8)]), "RGBA"


def _world_file_text(a: Affine):
    cx, cy = a.a * 0.5 + a.b * 0.5 + a.c, a.d * 0.5 + a.e * 0.5 + a.f      # pixel-centre of the top-left pixel
    return "\n".join(repr(float(v)) for v in (a.a, a.d, a.b, a.e, cx, cy)) + "\n"


def _write_png_zip(src_path, dst_zip, meta, crs_wkt, affine, work: Path):
    from PIL import Image
    arr, mode = _png_array(src_path, meta)
    stem = dst_zip.stem
    png = work / f"{stem}.png"
    Image.fromarray(arr).save(png, compress_level=6)
    parts = [png]
    if crs_wkt:
        crs = CRS.from_wkt(crs_wkt)
        (work / f"{stem}.pgw").write_text(_world_file_text(affine))
        (work / f"{stem}.prj").write_text(crs.to_wkt(version="WKT1_ESRI"))           # read by Esri software
        (work / f"{stem}.png.aux.xml").write_text(                                   # read by GDAL / QGIS
            f'<PAMDataset>\n  <SRS dataAxisToSRSAxisMapping="1,2">{escape(crs.to_wkt())}</SRS>\n</PAMDataset>\n')
        parts += [work / f"{stem}.pgw", work / f"{stem}.prj", work / f"{stem}.png.aux.xml"]
    with zipfile.ZipFile(dst_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for p in parts:
            z.write(p, p.name)
    return png, arr


# ----------------------------------------------------------------------------- validation
def _affine_error_px(got: Affine, exp: Affine):
    pix = max(abs(exp.a), abs(exp.e), 1e-30)
    lin = max(abs(got[i] - exp[i]) for i in (0, 1, 3, 4)) / pix
    trans = max(abs(got[2] - exp[2]), abs(got[5] - exp[5])) / pix
    return max(lin, trans)


def _compare_pixels(src_path, dst, report):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with rasterio.open(src_path) as a, rasterio.open(dst) as b:
            wins = list(_windows(a.width, a.height))
            sampled = a.width * a.height > 200_000_000
            if sampled:
                random.Random(7).shuffle(wins)
                wins = wins[:64]
            bad = 0
            for w in wins:
                x, y = a.read(window=w), b.read(window=w)
                if not np.array_equal(x, y, equal_nan=True):
                    bad += 1
            scope = f"{len(wins)} sampled blocks" if sampled else f"all {len(wins)} blocks"
            report.check("Pixel values identical to source", bad == 0, f"Compared {scope}.",
                         f"{bad} of {len(wins)} blocks differ.", expected="0 differing blocks", measured=f"{bad} differing blocks")
            if sampled:
                report.note("Raster is very large: pixel values were checked on a sample of blocks, not every pixel.")


def _validate_tiff(src_path, dst, meta, crs_wkt, affine, report: Report, cog: bool):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", NotGeoreferencedWarning)
            out = rasterio.open(dst)
    except Exception as e:
        report.fail("Output opens", f"The exported file could not be re-opened: {e}")
        return
    with out:
        report.passed("Output opens", f"Driver {out.driver}.")
        report.check("Dimensions", (out.width, out.height) == (meta["width"], meta["height"]),
                     f"{out.width} x {out.height} px.", "Size differs from the source.",
                     f"{meta['width']} x {meta['height']}", f"{out.width} x {out.height}")
        report.check("Bands and data type", out.count == meta["bands"] and out.dtypes[0] == meta["dtype"],
                     f"{out.count} band(s), {out.dtypes[0]}.", "Band count or data type differs from the source.",
                     f"{meta['bands']} x {meta['dtype']}", f"{out.count} x {out.dtypes[0]}")
        same_nd = (out.nodata == meta["nodata"]) or (out.nodata is not None and meta["nodata"] is not None
                                                      and np.isnan(out.nodata) and np.isnan(meta["nodata"]))
        report.check("NoData value", same_nd, "", "NoData value differs from the source.", meta["nodata"], out.nodata)
        if crs_wkt:
            got = out.crs
            ok = got is not None and C.horizontal(CRS.from_wkt(got.to_wkt())).equals(C.horizontal(CRS.from_wkt(crs_wkt)))
            report.check("CRS", ok, f"{C.label(CRS.from_wkt(crs_wkt))}.", "CRS in the output differs from the expected CRS.",
                         C.label(CRS.from_wkt(crs_wkt)), got.to_string() if got else None)
            err = _affine_error_px(out.transform, affine)
            report.check("Georeferencing transform", err < 1e-6,
                         f"Largest deviation {err:.2e} pixel.", f"Transform deviates by {err:.3g} pixel from the expected placement.",
                         "< 1e-6 pixel", f"{err:.3g} pixel")
            frame = [list(out.transform @ (0, 0)), list(out.transform @ (out.width, 0)),
                     list(out.transform @ (out.width, out.height)), list(out.transform @ (0, out.height))]
            exp_frame = [list(affine @ (0, 0)), list(affine @ (meta["width"], 0)), list(affine @ (meta["width"], meta["height"])),
                         list(affine @ (0, meta["height"]))]
            got_b = geo.bounds_wgs84(C.wkt(CRS.from_wkt(got.to_wkt())), frame) if got else None
            exp_b = geo.bounds_wgs84(crs_wkt, exp_frame)
            if got_b and exp_b:
                d = max(abs(g - e) for g, e in zip(got_b, exp_b))
                report.check("Footprint on the Earth", d < 1e-7, f"WGS84 extent agrees to {d:.1e} degrees (about {d * 111320:.3f} m).",
                             f"WGS84 extent differs by {d:.3g} degrees.", exp_b, got_b)
        else:
            report.warn("CRS", "The source has no CRS, so the output has none either. Georeference it first for a usable file.")
        _compare_pixels(src_path, dst, report)
        if cog:
            from rio_cogeo.cogeo import cog_validate
            ok, errs, warns = cog_validate(str(dst), quiet=True)
            report.check("Valid Cloud-Optimized GeoTIFF", ok, "Passes the COG layout validation.",
                         "; ".join(errs) or "Not a valid COG.")
            for w in warns:
                report.warn("COG note", w)
            report.check("Overviews present", len(out.overviews(1)) > 0 or max(out.width, out.height) <= 512,
                         f"{len(out.overviews(1))} overview level(s).", "No overviews were built.", severity="WARN")


def _validate_png(src_path, png_path, arr, meta, crs_wkt, affine, report: Report, lossless):
    from PIL import Image
    with Image.open(png_path) as im:
        report.check("PNG opens", True, f"{im.size[0]} x {im.size[1]}, mode {im.mode}.")
        report.check("Dimensions", im.size == (meta["width"], meta["height"]), "", "Image size differs from the source.",
                     f"{meta['width']} x {meta['height']}", f"{im.size[0]} x {im.size[1]}")
        back = np.array(im)
    report.check("Pixels written correctly", np.array_equal(back, arr), "Re-read pixels equal the rendered pixels.",
                 "The PNG pixels differ from what was written.")
    if lossless:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", NotGeoreferencedWarning)
            with rasterio.open(src_path) as s:
                orig = s.read()
        orig = orig[0] if orig.shape[0] == 1 else np.moveaxis(orig, 0, -1)
        report.check("Pixel values identical to source", np.array_equal(back, orig), "8-bit values are unchanged.",
                     "Values differ from the source.")
    else:
        report.warn("Pixel values", "Values were converted to 8-bit display colours. This image is for viewing, not analysis.")
    if crs_wkt:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", NotGeoreferencedWarning)
            with rasterio.open(png_path) as r:       # GDAL reads the .pgw/.prj sidecars: an independent check
                err = _affine_error_px(r.transform, affine)
                report.check("World file read back by GDAL", err < 1e-6, f"GDAL interprets the .pgw within {err:.2e} pixel.",
                             f"GDAL reads a transform {err:.3g} pixel away from the expected one.", "< 1e-6 pixel", f"{err:.3g} pixel")
                ok = r.crs is not None and C.horizontal(CRS.from_wkt(r.crs.to_wkt())).equals(C.horizontal(CRS.from_wkt(crs_wkt)))
                report.check("CRS read back by GDAL", ok, C.label(CRS.from_wkt(crs_wkt)) + " (from the .aux.xml sidecar).",
                             "GDAL does not read the expected CRS from the sidecar files.", C.label(CRS.from_wkt(crs_wkt)),
                             r.crs.to_string() if r.crs else None)
        prj = png_path.with_suffix(".prj")
        try:
            ok = prj.exists() and C.horizontal(C.parse(prj.read_text())).equals(C.horizontal(CRS.from_wkt(crs_wkt)))
        except Exception:
            ok = False
        report.check(".prj sidecar (Esri software)", ok, "Describes the expected CRS.", "The .prj file does not describe the expected CRS.")
    else:
        report.warn("CRS", "The source has no CRS, so no world file or .prj was written.")


# ----------------------------------------------------------------------------- entry point
def export(did, ds, g, res, fmt, crs_text, out_dir: Path, progress, base: str):
    meta = ds["meta"]
    src_path = files.source_path(did, meta)
    ready = res.state == "ready"
    crs_wkt = res.w_wkt if ready else None
    affine = res.raster_affine if ready else None
    if crs_text:
        want = C.parse(crs_text)
        if not ready or not C.horizontal(want).equals(C.horizontal(CRS.from_wkt(crs_wkt))):
            raise ExportError("Rasters are exported in their own CRS (they are not resampled). "
                              "Leave the CRS unset, or reproject the raster in a GIS first.")
    report = Report()
    if ready and res.method != "native":
        report.note(f"The georeference you set ({res.method}) is applied to the exported file; the uploaded original is unchanged.")
    out_dir.mkdir(parents=True, exist_ok=True)
    if fmt in ("geotiff", "cog"):
        dst = out_dir / f"{base}.tif"
        if fmt == "cog":
            if not ready:
                raise ExportError("COG needs ground coordinates.")
            if _rotated(affine):
                raise ExportError("COG requires a north-up grid; this raster is rotated. Export as GeoTIFF.")
            tmp = out_dir / "_stage.tif"
            _write_geotiff(src_path, tmp, crs_wkt, affine, progress, 0.0, 0.5)
            progress(0.55, "Building overviews")
            cont = meta["dtype"] in FLOAT or meta["dtype"] not in ("uint8",)
            rasterio.shutil.copy(tmp, dst, driver="COG", compress="deflate", blocksize=512, bigtiff="IF_SAFER",
                                 overview_resampling="bilinear" if cont else "average")
            tmp.unlink(missing_ok=True)
        else:
            _write_geotiff(src_path, dst, crs_wkt, affine, progress, 0.0, 0.85)
        progress(0.88, "Validating output")
        _validate_tiff(src_path, dst, meta, crs_wkt, affine, report, cog=(fmt == "cog"))
        return dst, report
    if fmt == "png":
        dst = out_dir / f"{base}.zip"
        work = out_dir / "_png"
        work.mkdir(exist_ok=True)
        progress(0.1, "Rendering image")
        png, arr = _write_png_zip(src_path, dst, meta, crs_wkt, affine, work)
        progress(0.7, "Validating output")
        _validate_png(src_path, png, arr, meta, crs_wkt, affine, report, _png_lossless(meta))
        with zipfile.ZipFile(dst) as z:
            report.check("ZIP contents", z.testzip() is None, ", ".join(z.namelist()), "The ZIP archive is damaged.")
        shutil.rmtree(work, ignore_errors=True)
        return dst, report
    raise ExportError(f"Unsupported raster export format '{fmt}'.")
