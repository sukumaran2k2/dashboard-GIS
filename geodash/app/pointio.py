"""Chunked point-cloud readers: LAS/LAZ (laspy), delimited text (XYZ/PTS/TXT) and PLY (trimesh)."""
import itertools
import re
from pathlib import Path

import laspy
import numpy as np

from . import crs as C
from .errors import IngestError

POINT_EXT = {".las", ".laz", ".xyz", ".pts", ".txt", ".ply"}
CHUNK = 1_000_000


class Chunk:
    __slots__ = ("x", "y", "z", "rgb")

    def __init__(self, x, y, z, rgb=None):
        self.x, self.y, self.z, self.rgb = x, y, z, rgb


class PointSource:
    count = 0
    mins = maxs = None        # [x, y, z]
    has_rgb = False
    crs = None                # pyproj CRS or None
    info = None               # dict of format details
    warnings = ()

    def chunks(self, n=CHUNK):
        raise NotImplementedError


class LasSource(PointSource):
    def __init__(self, path: Path):
        self.path = path
        try:
            with laspy.open(path) as f:
                h = f.header
                self.count = int(h.point_count)
                self.mins, self.maxs = list(map(float, h.mins)), list(map(float, h.maxs))
                self.has_rgb = "red" in h.point_format.dimension_names
                self.info = {"version": str(h.version), "point_format": h.point_format.id,
                             "scales": list(map(float, h.scales)), "offsets": list(map(float, h.offsets))}
                try:
                    c = h.parse_crs()
                    self.crs = C.parse(c) if c is not None else None
                except Exception:
                    self.crs = None
                if self.has_rgb:
                    first = next(f.chunk_iterator(min(self.count, 200_000)))
                    mx = max(int(first.red.max()), int(first.green.max()), int(first.blue.max())) if len(first) else 0
                    self.has_rgb = mx > 0
                    self._shift = 8 if mx > 255 else 0
        except IngestError:
            raise
        except Exception as e:
            raise IngestError("Not a readable LAS/LAZ file (corrupt, truncated or wrong format): " + str(e).replace(str(path), "file")[:200])
        if self.count == 0:
            raise IngestError("The point cloud contains no points.")

    def chunks(self, n=CHUNK):
        with laspy.open(self.path) as f:
            for ch in f.chunk_iterator(n):
                rgb = None
                if self.has_rgb:
                    rgb = (np.stack([ch.red, ch.green, ch.blue], 1) >> self._shift).astype(np.uint8)
                yield Chunk(np.asarray(ch.x), np.asarray(ch.y), np.asarray(ch.z), rgb)


class TextSource(PointSource):
    def __init__(self, path: Path):
        self.path = path
        head = []
        with open(path, "r", errors="replace") as f:
            for line in itertools.islice(f, 40):
                if line.strip():
                    head.append(line.rstrip("\r\n"))
        if not head:
            raise IngestError("The file is empty.")
        self.skip = 0
        toks0 = re.split(r"[,;\t ]+", head[0].strip())
        if len(toks0) == 1 and re.fullmatch(r"\d+", toks0[0]) and len(head) > 1:   # PTS point count line
            self.skip = 1
            head = head[1:]
        self.names = None
        first = head[0]
        toks = [t for t in re.split(r"[,;\t ]+", first.strip()) if t]
        def isnum(t):
            try:
                float(t)
                return True
            except ValueError:
                return False
        if not all(isnum(t) for t in toks):
            self.names = [t.strip().lower() for t in toks]
            self.skip += 1
            head = head[1:]
        if not head:
            raise IngestError("The file has a header but no data rows.")
        data0 = head[0]
        self.delim = "," if "," in data0 else (";" if ";" in data0 else ("\t" if "\t" in data0 else None))
        vals = [t for t in re.split(r"[,;\t ]+", data0.strip()) if t]
        self.ncols = len(vals)
        if self.ncols < 3 or not all(isnum(t) for t in vals):
            raise IngestError("Could not read numeric X Y Z columns from this file.")
        self.cols = self._map_columns()
        self.has_rgb = self.cols.get("rgb") is not None
        self._scan()

    def _map_columns(self):
        n = self.ncols
        names = self.names
        self.warnings = []
        if names and len(names) == n:
            def idx(opts):
                for o in opts:
                    if o in names:
                        return names.index(o)
            x, y, z = idx(["x", "easting", "lon", "longitude", "east"]), idx(["y", "northing", "lat", "latitude", "north"]), idx(["z", "elevation", "height", "elev", "alt"])
            r, g, b = idx(["r", "red"]), idx(["g", "green"]), idx(["b", "blue"])
            if None not in (x, y, z):
                return {"xyz": (x, y, z), "rgb": (r, g, b) if None not in (r, g, b) else None}
        layout = {3: ((0, 1, 2), None), 4: ((0, 1, 2), None), 6: ((0, 1, 2), (3, 4, 5)), 7: ((0, 1, 2), (4, 5, 6))}
        if n in layout:
            return {"xyz": layout[n][0], "rgb": layout[n][1]}
        self.warnings = [f"{n} columns found; using the first three as X Y Z and ignoring the rest."]
        return {"xyz": (0, 1, 2), "rgb": None}

    def _read(self, n):
        with open(self.path, "r", errors="replace") as f:
            for _ in range(self.skip):
                f.readline()
            while True:
                lines = list(itertools.islice(f, n))
                if not lines:
                    return
                lines = [l for l in lines if l.strip()]
                if not lines:
                    continue
                try:
                    a = np.loadtxt(lines, delimiter=self.delim, usecols=range(self.ncols), ndmin=2, dtype=np.float64)
                except Exception as e:
                    raise IngestError("A data row could not be parsed as numbers: " + str(e)[:160])
                yield a

    def _scan(self):
        mins, maxs, cnt, mx_rgb = np.full(3, np.inf), np.full(3, -np.inf), 0, 0
        for a in self._read(CHUNK):
            xyz = a[:, self.cols["xyz"]]
            ok = np.isfinite(xyz).all(1)
            xyz = xyz[ok]
            if len(xyz):
                mins, maxs, cnt = np.minimum(mins, xyz.min(0)), np.maximum(maxs, xyz.max(0)), cnt + len(xyz)
            if self.has_rgb and len(a):
                mx_rgb = max(mx_rgb, float(np.nanmax(a[:, self.cols["rgb"]])))
        if cnt == 0:
            raise IngestError("The file contains no valid points.")
        self.count, self.mins, self.maxs = cnt, mins.tolist(), maxs.tolist()
        self._rgb_div = 257.0 if mx_rgb > 255 else 1.0
        if self.has_rgb and mx_rgb == 0:
            self.has_rgb = False
        self.info = {"columns": self.ncols, "header": self.names}

    def chunks(self, n=CHUNK):
        for a in self._read(n):
            xyz = a[:, self.cols["xyz"]]
            ok = np.isfinite(xyz).all(1)
            rgb = None
            if self.has_rgb:
                rgb = np.clip(a[:, self.cols["rgb"]] / self._rgb_div, 0, 255).astype(np.uint8)[ok]
            yield Chunk(xyz[ok, 0], xyz[ok, 1], xyz[ok, 2], rgb)


class PlySource(PointSource):
    def __init__(self, path: Path):
        import trimesh
        if path.stat().st_size > 1024**3:
            raise IngestError("PLY files over 1 GB are not supported. Convert to LAS/LAZ.")
        try:
            obj = trimesh.load(str(path), process=False, force=None)
        except Exception as e:
            raise IngestError("Not a readable PLY file: " + str(e)[:160])
        if isinstance(obj, trimesh.Trimesh) and len(obj.faces):
            raise IngestError("This PLY contains a triangle mesh. Meshes are not supported yet; only point clouds are.")
        v = np.asarray(getattr(obj, "vertices", []), float)
        if len(v) == 0:
            raise IngestError("The PLY file contains no points.")
        col = getattr(obj, "colors", None)
        if col is None and hasattr(obj, "visual"):
            try:
                col = obj.visual.vertex_colors
            except Exception:
                col = None
        self._v = v
        self._rgb = np.asarray(col)[:, :3].astype(np.uint8) if col is not None and len(col) == len(v) else None
        if self._rgb is not None and self._rgb.max() == 0:
            self._rgb = None
        self.has_rgb = self._rgb is not None
        self.count = len(v)
        self.mins, self.maxs = v.min(0).tolist(), v.max(0).tolist()
        self.info = {}

    def chunks(self, n=CHUNK):
        for i in range(0, self.count, n):
            v = self._v[i:i + n]
            yield Chunk(v[:, 0], v[:, 1], v[:, 2], self._rgb[i:i + n] if self._rgb is not None else None)


def open_points(path: Path, ext: str) -> PointSource:
    ext = ext.lower()
    if ext in (".las", ".laz"):
        return LasSource(path)
    if ext in (".xyz", ".pts", ".txt"):
        return TextSource(path)
    if ext == ".ply":
        return PlySource(path)
    raise IngestError(f"Unsupported point cloud format '{ext}'.")
