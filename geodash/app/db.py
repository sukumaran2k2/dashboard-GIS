"""SQLite access: one connection per request (WAL), versioned migrations."""
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager

from . import config

DB_PATH = config.DATA / "gis.db"

MIGRATIONS = [
    # v1
    """
    CREATE TABLE projects(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL);
    CREATE TABLE datasets(
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL, ext TEXT NOT NULL,
        kind TEXT NOT NULL,            -- raster | vector | pointcloud
        category TEXT NOT NULL,        -- orthomosaic | dem | dsm | dtm | raster | vector | pointcloud | other
        status TEXT NOT NULL,          -- ready | unreferenced
        size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        meta TEXT NOT NULL, created REAL NOT NULL);
    CREATE INDEX datasets_project ON datasets(project_id);
    CREATE TABLE georef(
        dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL);
    CREATE TABLE georef_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        data TEXT, note TEXT, created REAL NOT NULL);
    CREATE TABLE jobs(
        id TEXT PRIMARY KEY,
        dataset_id TEXT REFERENCES datasets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, state TEXT NOT NULL,   -- queued | running | done | failed
        progress REAL NOT NULL DEFAULT 0, message TEXT,
        params TEXT, result TEXT, error TEXT, created REAL NOT NULL, updated REAL NOT NULL);
    """,
    # v2: free-text notes per dataset (survey date, sensor, operator, remarks)
    """
    ALTER TABLE datasets ADD COLUMN notes TEXT NOT NULL DEFAULT '';
    """,
]


def _connect():
    # Autocommit: every statement is durable as soon as it runs. FastAPI tears down request dependencies *after* the
    # response is sent, so deferring the commit to teardown let a client re-read data before it was committed.
    # Operations that need several writes to succeed together use `transaction()`.
    db = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    return db


def init_db():
    config.DATA.mkdir(parents=True, exist_ok=True)
    db = _connect()
    db.execute("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)")
    row = db.execute("SELECT version FROM schema_version").fetchone()
    current = row["version"] if row else 0
    if not row:
        db.execute("INSERT INTO schema_version VALUES(0)")
    for i, sql in enumerate(MIGRATIONS[current:], start=current + 1):
        db.executescript("BEGIN;" + sql + f"UPDATE schema_version SET version={i}; COMMIT;")
    db.execute("UPDATE jobs SET state='failed', error='Interrupted by server restart', updated=? "
               "WHERE state IN ('queued','running')", (time.time(),))
    db.commit()
    db.close()


@contextmanager
def connection():
    db = _connect()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


@contextmanager
def transaction(db):
    """All-or-nothing group of writes on an autocommit connection."""
    db.execute("BEGIN IMMEDIATE")
    try:
        yield db
    except BaseException:
        db.execute("ROLLBACK")
        raise
    else:
        db.execute("COMMIT")


def get_db():
    """FastAPI dependency."""
    with connection() as db:
        yield db


def new_id():
    return uuid.uuid4().hex[:12]


def dumps(o):
    return json.dumps(o, separators=(",", ":"), default=float)


def dataset_dict(r):
    d = dict(r)
    d["meta"] = json.loads(d["meta"])
    return d
