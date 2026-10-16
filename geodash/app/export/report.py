import math

import numpy as np


def jsonable(v):
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return f if math.isfinite(f) else str(f)
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): jsonable(x) for k, x in v.items()}
    return str(v)


class Report:
    """Result of re-opening an exported file and comparing it with what was expected.
    Only an all-PASS report may be described as validated."""

    def __init__(self):
        self.checks = []
        self.notes = []

    def add(self, name, status, detail="", expected=None, measured=None):
        assert status in ("PASS", "WARN", "FAIL")
        self.checks.append({"name": name, "status": status, "detail": detail,
                            "expected": jsonable(expected), "measured": jsonable(measured)})

    def passed(self, name, detail="", expected=None, measured=None):
        self.add(name, "PASS", detail, expected, measured)

    def warn(self, name, detail, expected=None, measured=None):
        self.add(name, "WARN", detail, expected, measured)

    def fail(self, name, detail, expected=None, measured=None):
        self.add(name, "FAIL", detail, expected, measured)

    def check(self, name, ok, detail_ok="", detail_bad="", expected=None, measured=None, severity="FAIL"):
        self.add(name, "PASS" if ok else severity, detail_ok if ok else detail_bad, expected, measured)

    def note(self, text):
        self.notes.append(text)

    @property
    def overall(self):
        s = {c["status"] for c in self.checks}
        if not self.checks or "FAIL" in s:
            return "FAIL"
        return "WARN" if "WARN" in s else "PASS"

    def to_dict(self):
        return {"overall": self.overall, "checks": self.checks, "notes": self.notes}
