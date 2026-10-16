"""Writes the small sample files used by the browser tests (web/e2e/verify*.mjs) into web/.testdata/samples.

    .venv\\Scripts\\python tests\\make_samples.py
"""
import sys
import warnings
from pathlib import Path

warnings.simplefilter("ignore")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import fixtures as F  # noqa: E402

out = ROOT / "web" / ".testdata" / "samples"
out.mkdir(parents=True, exist_ok=True)
F.make_geotiff(out / "ortho.tif")                                   # 200 x 150 px RGB, EPSG:32643, has a CRS
F.make_png_noref(out / "noref.png", w=120, h=80)                    # no ground coordinates
F.make_las(out / "local.las", local=True)[0]                        # point cloud in a local frame (no CRS)
F.make_shapefile_zip(out / "unreferenced.zip", with_prj=False)      # shapefile with no .prj
print("samples written to", out)
