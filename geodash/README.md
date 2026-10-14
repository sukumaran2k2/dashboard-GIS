# GeoDash
Dashboard for uploading, organizing and viewing existing GeoTIFF / DEM / DSM, Shapefile (.zip) and LAS/LAZ data. No photogrammetry.

## Run on Windows
Requires Python 3.10-3.13 (python.org, tick "Add python.exe to PATH"). Internet is needed on first run for `pip`, and while using the app for basemap tiles
(Leaflet and three.js are bundled in `static\vendor`, so no CDN is needed for them).

    cd geodash
    run.bat

Open http://127.0.0.1:8000. `run.bat` creates `.venv`, installs `requirements.txt` and starts the server.

Manual equivalent:

    python -m venv .venv
    .venv\Scripts\python -m pip install -r requirements.txt
    .venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port 8000

## Data
Stored in `geodash\data` (SQLite `geodash.db` + `files\<id>\original.*`, untouched uploads). Override the location with the `GEODASH_DATA` environment variable.
To back up, copy that folder while the server is stopped.

## Notes
- Shapefiles: upload one `.zip` containing `.shp`, `.shx`, `.dbf` and `.prj`.
- Very large GeoTIFFs display fastest when tiled with overviews (Cloud Optimized GeoTIFF).
- The 3D viewer shows a subsample (max 1.5M points) of LAS/LAZ files; clouds without a CRS appear only in 3D.
