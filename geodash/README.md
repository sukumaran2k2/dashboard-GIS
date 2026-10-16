# GeoDash

Local GIS dataset manager: upload, validate, view, georeference and convert raster, vector and point-cloud data.
Python (FastAPI, SQLite, GDAL/PROJ via rasterio + pyogrio + pyproj, laspy) with a React + MapLibre + three.js UI.
Runs natively on Windows; no Docker, WSL or database server.

## Run it

```
build.bat      # once: builds the web UI (needs Node 20+)
run.bat        # creates .venv, installs Python deps, starts http://127.0.0.1:8000
```

Optional settings go in `.env.bat` (not committed), e.g. `set GOOGLE_MAPS_API_KEY=...`.
Data (database, uploads, exports) is stored in `data/`; override with the `GEODASH_DATA` environment variable.
Uploads and scratch files are written under the data folder, so keep it on a drive with free space.

Tests:
- Backend: `.venv\Scripts\python -m pytest` (70 tests; synthetic data with known coordinates, plus round-trip and corruption checks).
- Browser (real Microsoft Edge via playwright-core). These tests create and delete projects, so run them against a
  throwaway server on port 8765, never the one that holds your data:
  ```
  set GEODASH_DATA=D:\gis\geodash\.stress\data_test
  .venv\Scripts\python -m uvicorn app.main:app --port 8765
  .venv\Scripts\python tests\make_samples.py
  cd web
  node e2e/verify.mjs          (also verify2.mjs, verify3.mjs, verify5.mjs, verify6.mjs)
  ```
  They drive the UI (dashboard, drag handles, control points, export, upload, popups) and compare what the server stored.
  `verify4.mjs` loads a LiDAR file from a fixed path (edit it). Set `GEODASH_URL` to use a different address.

## Formats

| Type | Accepted | Not supported (reported in the UI) |
|---|---|---|
| Raster | GeoTIFF/COG, PNG/JPEG (no ground transform, so they need georeferencing), Esri ASCII grid, Erdas IMG, SRTM HGT, JPEG 2000 | ECW, MrSID (licensed SDKs) |
| Vector | Shapefile (.zip), GeoJSON, GeoPackage, KML, KMZ, GPX, DXF, CSV with coordinate columns, zipped File Geodatabase (read) | DWG (proprietary) |
| Point cloud | LAS, LAZ, XYZ/PTS/TXT, PLY (points) | E57, meshes (OBJ, GLB, PLY with faces), IFC |

ZIP archives are inspected, size-limited and checked for unsafe paths before use.

Exports: raster to GeoTIFF, COG, PNG + world file; vector to GeoPackage, GeoJSON, Shapefile (zip), KML, DXF; point cloud to LAS, LAZ, XYZ (zip with .prj).

## Workspace features

- **Search and commands** (Ctrl+K, or the search box in the header): jump to any project or dataset, upload, switch theme, or create a project by typing its name.
- **Quick upload** from the header into any project, or a new one.
- **Light and dark themes**, remembered per browser.
- **Dataset notes** (survey date, sensor, operator…) and renaming, shown on the dashboard.
- **Map tools** on every data map: live cursor coordinates (click to copy), and a measure tool for distance and enclosed area. Measurements are geodesic on the WGS84 ellipsoid, computed by the server.
- **Location shortcuts**: copy a dataset's centre or WGS84 bounds, or open the centre in Google Maps.
- **Dashboard**: projects at a glance, datasets that need georeferencing, recent exports with their validation result and download, data by type, recent uploads.

## How georeferencing works

The uploaded file is never modified (its SHA-256 is recorded at upload and can be re-checked in the UI).
A georeference is stored beside it and applied when rendering and exporting:

```
native coordinates --pyproj--> working CRS --rigid motion (rotate/move about a pivot)--> final coordinates
```

- **Assign CRS**: the coordinates already are in a CRS. The extent is checked against the CRS area of use; an implausible choice is refused unless confirmed.
- **Place on map**: a footprint centre is put at an anchor (lon/lat, or x/y in a CRS) with a rotation. Data with no known coordinates is placed in a UTM zone chosen from the anchor. Rotation and scaling are refused in geographic (degree) CRSs.
- **Control points** (rasters): affine fit from three or more points, with residuals and RMSE reported.
- Rasters keep their own CRS and pixel grid when moved (no resampling). Z is preserved; an explicit, labelled vertical offset is available. No geoid or datum conversion is applied.
- Every save runs a round-trip check (tolerance 1 mm) and is rejected if it fails. Each change is kept in a history that can be restored.
- A shapefile or CSV without a CRS is never assumed to be WGS84. It stays "unreferenced" until the user chooses.

## How exports are validated

Each export is re-opened and compared with what was expected, and the result is shown as a report:

- Rasters: size, bands, type, NoData, CRS, transform, footprint on the Earth, every pixel block, COG layout.
- Vectors: feature count, geometry types, coordinates (within 1 mm), CRS, attribute names and values.
- Point clouds: point count, extent, sampled coordinates and attributes, CRS in the header.

`PASS` means every check passed. `WARN` means the file was produced with stated limitations (for example DXF has no attributes or CRS). `FAIL` means the file is deleted and not offered for download.

## Limits

- Google Maps basemap needs an API key with the Map Tiles API enabled and internet access. It has not been tested against the live service. Check Google's current terms before use.
- Basemap imagery is for locating data; it is not survey-grade. Typed coordinates are authoritative.
- Browser display of vector data is capped at 500,000 features; very large point clouds are previewed from a sample of about 1.5 million points (the exports use every point).
- Single user, no authentication. Do not expose the port to an untrusted network.
- Mesh formats and E57 are not supported yet.
