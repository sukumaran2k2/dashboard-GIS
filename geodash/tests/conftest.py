import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
_scratch = ROOT / ".pytest_tmp_data"        # keep test data on the project drive, not the system drive
_scratch.mkdir(exist_ok=True)
os.environ["GEODASH_DATA"] = tempfile.mkdtemp(prefix="geodash_test_", dir=_scratch)

import pytest  # noqa: E402


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def tmp(tmp_path):
    return tmp_path
