import pytest

from app import db as D


@pytest.fixture(scope="module", autouse=True)
def _init(client):
    D.init_db()


def test_writes_are_visible_to_other_connections_immediately():
    """A client that re-reads right after a write must see it (no commit deferred to request teardown)."""
    a, b = D._connect(), D._connect()
    try:
        a.execute("INSERT INTO projects VALUES('vis1','visible',0)")
        assert b.execute("SELECT name FROM projects WHERE id='vis1'").fetchone()["name"] == "visible"
    finally:
        a.execute("DELETE FROM projects WHERE id='vis1'")
        a.close(); b.close()


def test_transaction_is_all_or_nothing():
    db = D._connect()
    try:
        with pytest.raises(RuntimeError):
            with D.transaction(db):
                db.execute("INSERT INTO projects VALUES('tx1','a',0)")
                db.execute("INSERT INTO projects VALUES('tx2','b',0)")
                raise RuntimeError("fail midway")
        assert db.execute("SELECT COUNT(*) FROM projects WHERE id IN ('tx1','tx2')").fetchone()[0] == 0
        with D.transaction(db):
            db.execute("INSERT INTO projects VALUES('tx3','c',0)")
        assert db.execute("SELECT COUNT(*) FROM projects WHERE id='tx3'").fetchone()[0] == 1
    finally:
        db.execute("DELETE FROM projects WHERE id IN ('tx1','tx2','tx3')")
        db.close()
