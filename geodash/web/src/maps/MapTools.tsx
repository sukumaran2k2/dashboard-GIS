/**
 * Map utilities shared by the viewers: a live cursor-coordinate readout (click to copy) and a measure tool.
 * Distances and areas are computed by the server on the WGS84 ellipsoid; the browser only collects clicks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import { Ruler, Undo2, X } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../components/Toast';

const SRC = 'measure-src';

export function fmtLength(m: number) {
  return m < 1000 ? `${m.toFixed(m < 10 ? 2 : 1)} m` : `${(m / 1000).toFixed(3)} km`;
}

export function fmtArea(a: number) {
  if (a < 10_000) return `${a.toFixed(1)} m²`;
  if (a < 1_000_000) return `${(a / 10_000).toFixed(3)} ha`;
  return `${(a / 1_000_000).toFixed(3)} km²`;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function MapTools({ map, ready }: { map: maplibregl.Map | null; ready: boolean }) {
  const { showToast } = useToast();
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [pts, setPts] = useState<[number, number][]>([]);
  const [result, setResult] = useState<{ length_m: number; area_m2: number | null } | null>(null);
  const seq = useRef(0);

  // cursor readout
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const move = (e: maplibregl.MapMouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setCursor([e.lngLat.lng, e.lngLat.lat]));
    };
    map.on('mousemove', move);      // the last position stays visible so the readout itself can be clicked
    return () => { cancelAnimationFrame(raf); map.off('mousemove', move); };
  }, [map]);

  // measure layers
  const draw = useCallback((p: [number, number][]) => {
    if (!map || !ready) return;
    const features: GeoJSON.Feature[] = p.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
    if (p.length >= 2) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p } });
    if (p.length >= 3) features.push({ type: 'Feature', properties: { fill: 1 }, geometry: { type: 'Polygon', coordinates: [[...p, p[0]]] } });
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
    const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    if (src) { src.setData(data); return; }
    map.addSource(SRC, { type: 'geojson', data });
    map.addLayer({ id: 'measure-fill', type: 'fill', source: SRC, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e07020', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'measure-casing', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'measure-line', type: 'line', source: SRC, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': '#e07020', 'line-width': 3, 'line-dasharray': [2, 1.2] } });
    map.addLayer({ id: 'measure-pts', type: 'circle', source: SRC, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5.5, 'circle-color': '#e07020', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  }, [map, ready]);

  const clear = useCallback(() => {
    setPts([]);
    setResult(null);
    if (map?.getStyle()) {
      ['measure-pts', 'measure-line', 'measure-casing', 'measure-fill'].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(SRC)) map.removeSource(SRC);
    }
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const canvas = map.getCanvas();
    if (!measuring) { delete canvas.dataset.measuring; canvas.style.cursor = ''; return; }
    canvas.dataset.measuring = '1';
    canvas.style.cursor = 'crosshair';
    const click = (e: maplibregl.MapMouseEvent) => setPts((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMeasuring(false); };
    map.on('click', click);
    window.addEventListener('keydown', esc);
    return () => { map.off('click', click); window.removeEventListener('keydown', esc); delete canvas.dataset.measuring; canvas.style.cursor = ''; };
  }, [map, measuring]);

  useEffect(() => {
    draw(pts);
    if (pts.length < 2) { setResult(null); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api.measure(pts).then((r) => { if (mine === seq.current) setResult(r); }).catch(() => { if (mine === seq.current) setResult(null); });
    }, 120);
    return () => clearTimeout(t);
  }, [pts, draw]);

  useEffect(() => { if (!measuring) clear(); }, [measuring, clear]);

  async function copyCursor() {
    if (!cursor) return;
    const ok = await copyText(`${cursor[1].toFixed(6)}, ${cursor[0].toFixed(6)}`);
    showToast(ok ? 'Coordinates copied' : 'Copy is blocked by the browser', ok ? 'success' : 'error');
  }

  return (
    <>
      <div className="map-tools">
        <button className={`map-tool-btn${measuring ? ' on' : ''}`} onClick={() => setMeasuring((m) => !m)} aria-pressed={measuring}
          title="Measure distance and area on the WGS84 ellipsoid">
          <Ruler size={14} aria-hidden="true" /> Measure
        </button>
        {measuring && (
          <div className="measure-card" aria-live="polite">
            {pts.length < 2 ? (
              <span>Click on the map to add points.</span>
            ) : (
              <>
                <div className="row"><span>Distance</span><strong>{result ? fmtLength(result.length_m) : '…'}</strong></div>
                {pts.length >= 3 && (
                  <div className="row" style={{ marginTop: 4 }}><span>Enclosed area</span><strong>{result?.area_m2 != null ? fmtArea(result.area_m2) : '…'}</strong></div>
                )}
              </>
            )}
            <div className="row" style={{ marginTop: 8, justifyContent: 'flex-start' }}>
              <button className="btn btn-secondary btn-xs" onClick={() => setPts((p) => p.slice(0, -1))} disabled={!pts.length}><Undo2 size={12} /> Undo</button>
              <button className="btn btn-secondary btn-xs" onClick={() => { setPts([]); setResult(null); }} disabled={!pts.length}>Clear</button>
              <button className="btn btn-secondary btn-xs" onClick={() => setMeasuring(false)}><X size={12} /> Done</button>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>Geodesic on WGS84, computed by the server.</div>
          </div>
        )}
      </div>
      {cursor && (
        <button className="map-coords" onClick={copyCursor} title="Click to copy latitude, longitude">
          Lat {cursor[1].toFixed(6)} · Lon {cursor[0].toFixed(6)}
        </button>
      )}
    </>
  );
}
