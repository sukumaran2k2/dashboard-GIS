import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("GEODASH_DATA", ROOT / "data"))
FILES = DATA / "files"
TMP = DATA / "tmp"
WEB_DIST = ROOT / "web" / "dist"

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
MAX_UPLOAD_BYTES = int(float(os.environ.get("GEODASH_MAX_UPLOAD_GB", "20")) * 1024**3)

MAX_PREVIEW_POINTS = 1_500_000
TOPDOWN_MAX_DIM = 2048
ZIP_MAX_ENTRIES = 5000
ZIP_MAX_UNCOMPRESSED = 40 * 1024**3
PNG_EXPORT_MAX_PIXELS = 100_000_000

FILES.mkdir(parents=True, exist_ok=True)

# Upload spool files and scratch space live on the data drive, not the (often small) system drive.
TMP.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TMP)
for _stale in TMP.iterdir():
    try:
        _stale.unlink() if _stale.is_file() else None
    except OSError:
        pass
