"""GeoDash: GIS dataset management, georeferencing and conversion. FastAPI + SQLite + GDAL/PROJ."""
import json
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .db import init_db
from .errors import ExportError, GeorefError, IngestError
from .routes import datasets, export, georef, projects


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="GeoDash", lifespan=lifespan)


@app.exception_handler(GeorefError)
async def _georef_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=422)


@app.exception_handler(IngestError)
async def _ingest_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=422)


@app.exception_handler(ExportError)
async def _export_error(_, e):
    return JSONResponse({"detail": str(e)}, status_code=500)


for r in (projects.router, datasets.router, georef.router, export.router):
    app.include_router(r)


@app.get("/api/config")
def get_config():
    return {"google_maps": bool(config.GOOGLE_MAPS_API_KEY), "max_upload_gb": config.MAX_UPLOAD_BYTES // 1024**3}


_sessions: dict = {}


@app.get("/api/google/session")
def google_session(type: str = "satellite"):
    """Creates a Google Map Tiles API session (2D tiles). Needs GOOGLE_MAPS_API_KEY with the Map Tiles API enabled."""
    if not config.GOOGLE_MAPS_API_KEY:
        raise HTTPException(404, "Google Maps is not configured. Set the GOOGLE_MAPS_API_KEY environment variable.")
    if type not in ("roadmap", "satellite", "hybrid", "terrain"):
        raise HTTPException(400, "type must be roadmap, satellite, hybrid or terrain")
    hit = _sessions.get(type)
    if hit and hit["at"] > time.time() - 6 * 3600:
        return hit["data"]
    body = {"mapType": "satellite" if type == "hybrid" else type, "language": "en-US", "region": "US"}
    if type == "hybrid":
        body["layerTypes"] = ["layerRoadmap"]
    req = urllib.request.Request(f"https://tile.googleapis.com/v1/createSession?key={config.GOOGLE_MAPS_API_KEY}",
                                 data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            s = json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read())["error"]["message"]
        except Exception:
            msg = str(e)
        raise HTTPException(502, f"Google Maps rejected the request: {msg}")
    except Exception as e:
        raise HTTPException(502, f"Could not reach Google Maps (internet required): {e}")
    data = {"tiles": f"https://tile.googleapis.com/v1/2dtiles/{{z}}/{{x}}/{{y}}?session={s['session']}&key={config.GOOGLE_MAPS_API_KEY}",
            "attribution": "Map data © Google", "expiry": s.get("expiry")}
    _sessions[type] = {"at": time.time(), "data": data}
    return data


if config.WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=config.WEB_DIST, html=True), name="web")
else:
    @app.get("/")
    def _no_frontend():
        return JSONResponse({"detail": "Frontend not built. Run build.bat (or: cd web && npm install && npm run build)."}, status_code=503)
