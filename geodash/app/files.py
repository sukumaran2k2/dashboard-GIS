import hashlib
from pathlib import Path

from . import config


def ds_dir(did: str) -> Path:
    return config.FILES / did


def source_path(did: str, meta: dict) -> Path:
    return ds_dir(did) / meta["source"]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            h.update(chunk)
    return h.hexdigest()
