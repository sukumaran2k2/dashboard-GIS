/**
 * Interactive placement map. Dragging is only an input device: every move/rotate is sent to the server
 * (POST /georef/preview) and the footprint is drawn from the corners the server returns. No geodesy runs here
 * except the screen angle used to turn a handle drag into a rotation delta.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, imageUrl, type Dataset, type GeorefBody, type GeorefFull } from '../api';
import { BasemapSelect, createMap, useBasemap, type Bounds } from '../maps/basemaps';

type Corners = [[number, number], [number, number], [number, number], [number, number]];

const IMG_SRC = 'place-image';
const IMG_LAYER = 'place-image-layer';
const OUT_SRC = 'place-outline';
const OUT_LAYER = 'place-outline-layer';

interface PlaceMapProps {
  dataset: Dataset;
  georef: GeorefFull;
  anchorLon: number | null;
  anchorLat: number | null;
  rotation: number;
  placeCrs: string;
  scale: number;
  zOffset: number;
  pixelSize: string;
  confirmOutside: boolean;
  onAnchorChange: (lon: number, lat: number) => void;
  onRotationChange: (deg: number) => void;
  onPreviewResult: (result: GeorefFull | null, err: string) => void;
}

function handle(bg: string, size: number, round: boolean, cursor: string, title: string) {
  const el = document.createElement('div');
  el.title = title;
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:${round ? '50%' : '3px'};background:${bg};border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5);cursor:${cursor}`;
  return el;
}

const screenAngle = (c: { x: number; y: number }, p: { x: number; y: number }) => (Math.atan2(p.x - c.x, -(p.y - c.y)) * 180) / Math.PI;
const wrap180 = (a: number) => ((a + 540) % 360) - 180;

export function PlaceMapEmbed(props: PlaceMapProps) {
  const { dataset, georef, anchorLon, anchorLat, rotation, onRotationChange } = props;
  const latest = useRef(props);
  latest.current = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [big, setBig] = useState(false);
  const bm = useBasemap(map, ready);

  const work = useRef<{ lon: number | null; lat: number | null; rot: number }>({ lon: anchorLon, lat: anchorLat, rot: rotation });
  const centre = useRef<maplibregl.Marker | null>(null);
  const rotate = useRef<maplibregl.Marker | null>(null);
  const corners = useRef<Corners | null>((georef.effective?.corners_wgs84 as Corners | undefined) ?? null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = useRef(false);
  const lastDragEnd = useRef(0);
  const autoFit = useRef(!!(georef.effective?.corners_wgs84));      // already placed: the map opens on it
  const [goto, setGoto] = useState('');

  const hasImage = dataset.kind !== 'vector';

  const buildBody = useCallback((lon: number, lat: number, rot: number): GeorefBody => {
    const p = latest.current;
    const body: GeorefBody = { mode: 'place', anchor: { lon, lat }, rotation_deg: rot };
    if (p.placeCrs) body.crs = p.placeCrs;
    if (p.georef.local) body.scale = p.scale;
    if (p.dataset.kind === 'pointcloud') body.z_offset = p.zOffset;
    if (p.dataset.kind === 'raster' && !(p.dataset.meta as { affine?: unknown }).affine && p.pixelSize) body.pixel_size = parseFloat(p.pixelSize);
    if (p.confirmOutside) body.confirm_outside_area = true;
    return body;
  }, []);

  const placeRotateHandle = useCallback(() => {
    const m = map, c = centre.current, r = rotate.current, k = corners.current;
    if (!m || !c || !r || !k || dragging.current) return;
    const mid = [(k[0][0] + k[1][0]) / 2, (k[0][1] + k[1][1]) / 2] as [number, number];
    const cp = m.project(c.getLngLat());
    const mp = m.project(mid);
    const dx = mp.x - cp.x, dy = mp.y - cp.y;
    const len = Math.hypot(dx, dy) || 1;
    r.setLngLat(m.unproject([mp.x + (dx / len) * 26, mp.y + (dy / len) * 26]));
  }, [map]);

  const draw = useCallback((k: Corners) => {
    corners.current = k;
    if (!map || !ready) return;
    if (hasImage) {
      const src = map.getSource(IMG_SRC) as maplibregl.ImageSource | undefined;
      if (src) src.setCoordinates(k);
      else {
        map.addSource(IMG_SRC, { type: 'image', url: imageUrl(dataset.id), coordinates: k });
        map.addLayer({ id: IMG_LAYER, type: 'raster', source: IMG_SRC, paint: { 'raster-opacity': 0.75, 'raster-fade-duration': 0 } });
      }
    }
    const outline: GeoJSON.Feature = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...k, k[0]]] } };
    const o = map.getSource(OUT_SRC) as maplibregl.GeoJSONSource | undefined;
    if (o) o.setData(outline);
    else {
      map.addSource(OUT_SRC, { type: 'geojson', data: outline });
      map.addLayer({ id: OUT_LAYER, type: 'line', source: OUT_SRC, paint: { 'line-color': '#e07020', 'line-width': 2.5, 'line-dasharray': [3, 2] } });
    }
    placeRotateHandle();
  }, [map, ready, hasImage, dataset.id, placeRotateHandle]);

  const runPreview = useCallback(() => {
    const { lon, lat, rot } = work.current;
    if (lon === null || lat === null) return;
    const mine = ++seq.current;
    api.previewGeoref(dataset.id, buildBody(lon, lat, rot)).then((r) => {
      if (mine !== seq.current) return;                       // a newer preview is already in flight
      const k = r.effective?.corners_wgs84 as Corners | undefined;
      if (k) {
        draw(k);
        if (map && !autoFit.current) {                         // first placement: make sure the footprint is actually visible
          autoFit.current = true;
          const px = k.map((c) => map.project(c as [number, number]));
          const size = Math.max(Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x)), Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y)));
          if (size < 60) {
            const xs = k.map((c) => c[0]), ys = k.map((c) => c[1]);
            map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 120, maxZoom: 19, animate: false });
          }
        }
      }
      latest.current.onPreviewResult(r, '');
    }).catch((e: Error) => {
      if (mine === seq.current) latest.current.onPreviewResult(null, e.message);
    });
  }, [dataset.id, buildBody, draw, map]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(runPreview, 120);
  }, [runPreview]);

  const ensureMarkers = useCallback((lon: number, lat: number) => {
    if (!map || centre.current) return;
    const c = new maplibregl.Marker({ element: handle('#2c2e77', 18, true, 'grab', 'Drag to move'), draggable: true }).setLngLat([lon, lat]).addTo(map);
    const r = new maplibregl.Marker({ element: handle('#e07020', 14, false, 'crosshair', 'Drag to rotate'), draggable: true }).setLngLat([lon, lat]).addTo(map);
    centre.current = c;
    rotate.current = r;

    c.on('dragstart', () => { dragging.current = true; });
    c.on('drag', () => {
      const ll = c.getLngLat();
      work.current.lon = ll.lng; work.current.lat = ll.lat;
      latest.current.onAnchorChange(ll.lng, ll.lat);
      schedule();
    });
    c.on('dragend', () => { dragging.current = false; lastDragEnd.current = Date.now(); placeRotateHandle(); });

    // The reference angle is taken on pointer-down: MapLibre only reports `dragstart` after the pointer has already
    // moved a few pixels, which would lose the start of the gesture.
    let a0 = 0, r0 = 0;
    r.getElement().addEventListener('pointerdown', () => {
      a0 = screenAngle(map.project(c.getLngLat()), map.project(r.getLngLat()));
      r0 = work.current.rot;
    });
    r.on('dragstart', () => { dragging.current = true; });
    r.on('drag', () => {
      const a = screenAngle(map.project(c.getLngLat()), map.project(r.getLngLat()));
      const rot = Math.round((r0 - wrap180(a - a0)) * 10) / 10;       // clockwise drag = negative (counter-clockwise positive)
      work.current.rot = rot;
      latest.current.onRotationChange(rot);
      schedule();
    });
    r.on('dragend', () => { dragging.current = false; lastDragEnd.current = Date.now(); placeRotateHandle(); });
  }, [map, schedule, placeRotateHandle]);

  // map lifecycle
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const b = (georef.effective?.bounds_wgs84 ?? georef.native.bounds_wgs84) as Bounds | null | undefined;
    const m = createMap(el, b ? { bounds: b } : anchorLon !== null && anchorLat !== null ? { center: [anchorLon, anchorLat], zoom: 15 } : {});
    m.on('load', () => setReady(true));
    setMap(m);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      seq.current++;
      centre.current?.remove(); rotate.current?.remove();
      centre.current = null; rotate.current = null;
      setReady(false); setMap(null);
      m.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  // click sets the anchor
  useEffect(() => {
    if (!map) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (Date.now() - lastDragEnd.current < 350) return;
      work.current.lon = e.lngLat.lng; work.current.lat = e.lngLat.lat;
      latest.current.onAnchorChange(e.lngLat.lng, e.lngLat.lat);
      ensureMarkers(e.lngLat.lng, e.lngLat.lat);
      centre.current?.setLngLat(e.lngLat);
      schedule();
    };
    map.on('click', onClick);
    map.on('zoomend', placeRotateHandle);
    return () => { map.off('click', onClick); map.off('zoomend', placeRotateHandle); };
  }, [map, ensureMarkers, schedule, placeRotateHandle]);

  // draw the current placement as soon as the map is ready; show handles when an anchor exists
  useEffect(() => {
    if (!map || !ready) return;
    if (corners.current) draw(corners.current);
    if (work.current.lon !== null && work.current.lat !== null) {
      ensureMarkers(work.current.lon, work.current.lat);
      if (!corners.current) schedule();
    }
  }, [map, ready, draw, ensureMarkers, schedule]);

  // values typed in the panel (numbers, slider, nudge buttons)
  useEffect(() => {
    if (dragging.current) return;
    const w = work.current;
    const moved = anchorLon !== w.lon || anchorLat !== w.lat;
    const turned = Math.abs(rotation - w.rot) > 1e-9;
    if (!moved && !turned) return;
    w.lon = anchorLon; w.lat = anchorLat; w.rot = rotation;
    if (anchorLon === null || anchorLat === null) return;
    ensureMarkers(anchorLon, anchorLat);
    centre.current?.setLngLat([anchorLon, anchorLat]);
    if (moved && map && !map.getBounds().contains([anchorLon, anchorLat])) map.easeTo({ center: [anchorLon, anchorLat] });
    schedule();
  }, [anchorLon, anchorLat, rotation, map, ensureMarkers, schedule]);

  // settings that change the preview but are not anchor/rotation
  useEffect(() => { if (work.current.lon !== null) schedule(); },
    [props.placeCrs, props.scale, props.zOffset, props.pixelSize, props.confirmOutside, schedule]);

  function go() {
    const n = goto.split(/[ ,;]+/).map(Number).filter((v) => Number.isFinite(v));
    if (!map || n.length !== 2 || Math.abs(n[0]) > 90 || Math.abs(n[1]) > 180) return;
    const [lat, lon] = n;
    work.current.lon = lon; work.current.lat = lat;
    latest.current.onAnchorChange(lon, lat);
    ensureMarkers(lon, lat);
    centre.current?.setLngLat([lon, lat]);
    map.jumpTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15) });
    autoFit.current = true;
    schedule();
  }

  // full-screen mode
  useEffect(() => {
    if (!map) return;
    const raf = requestAnimationFrame(() => { map.resize(); placeRotateHandle(); });
    if (!big) return () => cancelAnimationFrame(raf);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', esc);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', esc); };
  }, [big, map, placeRotateHandle]);

  return (
    <div style={{ margin: '8px 0' }}>
      <div className={big ? 'map-box fullscreen' : 'map-box'} style={big ? undefined : { height: 280 }}>
        {big && (
          <div className="place-big-header">
            <strong>Place on map</strong>
            <span className="muted">Click to set the centre · drag the navy dot to move · drag the orange square to rotate</span>
            <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              Rotation (° CCW)
              <input type="number" step="1" value={rotation} style={{ width: 80 }}
                onChange={(e) => onRotationChange(parseFloat(e.target.value) || 0)} aria-label="Rotation in degrees" />
            </label>
            <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {anchorLon !== null && anchorLat !== null ? `${anchorLon.toFixed(6)}, ${anchorLat.toFixed(6)}` : 'No anchor yet'}
            </span>
            <button className="btn btn-primary btn-sm" onClick={() => setBig(false)}>Done</button>
          </div>
        )}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, ...(big ? {} : { height: '100%' }) }}>
          <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
          <BasemapSelect bm={bm} />
          <div className="map-overlay" style={{ top: 44 }}>
            <input value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="Go to: lat, lon" style={{ width: 130, fontSize: 12 }}
              onKeyDown={(e) => { if (e.key === 'Enter') go(); }} aria-label="Go to latitude and longitude" />
            <button className="btn btn-secondary btn-xs" onClick={go}>Set centre</button>
          </div>
          {!big && (
            <button className="btn btn-secondary btn-xs" style={{ position: 'absolute', bottom: 26, right: 8, zIndex: 5 }}
              onClick={() => setBig(true)}>Enlarge map</button>
          )}
        </div>
      </div>
      <div className="basemap-note" style={{ marginTop: 4 }}>
        Basemap imagery is only for locating the dataset and is not survey-grade. Typed coordinates are authoritative.
      </div>
      <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
        Click the map to place the centre · drag the navy dot to move · drag the orange square to rotate
      </div>
    </div>
  );
}
