import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, type Dataset, type VectorMeta } from '../api';
import { useToast } from '../components/Toast';
import { BasemapSelect, createMap, esc, fitTo, useBasemap, type Bounds } from '../maps/basemaps';
import { MapTools } from '../maps/MapTools';

interface VectorViewerProps {
  dataset: Dataset;
  georefVersion: number;
}

type TabType = 'map' | 'table';

export function VectorViewer({ dataset, georefVersion }: VectorViewerProps) {
  const [tab, setTab] = useState<TabType>('map');
  const isReferenced = dataset.effective_status === 'ready';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tabs">
        <button className={`tab${tab === 'map' ? ' active' : ''}`} onClick={() => setTab('map')}>Map</button>
        <button className={`tab${tab === 'table' ? ' active' : ''}`} onClick={() => setTab('table')}>Attributes</button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {tab === 'map' && (
          isReferenced
            ? <VectorMapView dataset={dataset} georefVersion={georefVersion} />
            : <LocalVectorView dataset={dataset} />
        )}
        {tab === 'table' && <AttributeTable dataset={dataset} />}
      </div>
    </div>
  );
}

const COLOR = '#037bc0';

function VectorMapView({ dataset, georefVersion }: { dataset: Dataset; georefVersion: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const { showError } = useToast();
  const bounds = dataset.georef.bounds_wgs84 as Bounds | null;
  const bm = useBasemap(map, ready);

  useEffect(() => {
    if (!containerRef.current) return;
    const m = createMap(containerRef.current, { bounds });
    m.on('load', () => setReady(true));
    setMap(m);
    return () => { setReady(false); setMap(null); m.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  useEffect(() => {
    if (!map || !ready) return;
    let alive = true;
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '320px' });
    const ids = ['vector-fill', 'vector-line', 'vector-circle'];
    const handlers: Array<[string, (e: maplibregl.MapLayerMouseEvent) => void]> = [];

    fetch(`/api/datasets/${dataset.id}/geojson?v=${georefVersion}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { detail?: string }).detail ?? r.statusText);
        return r.json() as Promise<GeoJSON.FeatureCollection>;
      })
      .then((gj) => {
        if (!alive) return;
        ids.forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
        if (map.getSource('vector-src')) map.removeSource('vector-src');
        map.addSource('vector-src', { type: 'geojson', data: gj });
        map.addLayer({ id: 'vector-fill', type: 'fill', source: 'vector-src',
          filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
          paint: { 'fill-color': COLOR, 'fill-opacity': 0.3 } });
        map.addLayer({ id: 'vector-line', type: 'line', source: 'vector-src',
          filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': COLOR, 'line-width': 1.8 } });
        map.addLayer({ id: 'vector-circle', type: 'circle', source: 'vector-src',
          filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']],
          paint: { 'circle-radius': 5, 'circle-color': COLOR, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });
        if (bounds) fitTo(map, bounds);

        ids.forEach((layerId) => {
          const click = (e: maplibregl.MapLayerMouseEvent) => {
            if (map.getCanvas().dataset.measuring) return;
            const f = e.features?.[0];
            if (!f) return;
            const rows = Object.entries(f.properties ?? {})
              .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`).join('');
            popup.setLngLat(e.lngLat).setHTML(`<div class="feature-popup"><table>${rows}</table></div>`).addTo(map);
          };
          const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
          const leave = () => { map.getCanvas().style.cursor = ''; };
          map.on('click', layerId, click);
          map.on('mouseenter', layerId, enter);
          map.on('mouseleave', layerId, leave);
          handlers.push([layerId, click]);
        });
      })
      .catch((e: Error) => { if (alive) showError(e.message); });

    return () => {
      alive = false;
      popup.remove();
      if (map.getStyle()) handlers.forEach(([id, h]) => map.off('click', id, h));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, dataset.id, georefVersion]);

  return (
    <div className="map-box">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <BasemapSelect bm={bm} />
      <MapTools map={map} ready={ready} />
    </div>
  );
}

type Pt = [number, number];

function eachCoord(g: GeoJSON.Geometry | null, fn: (c: Pt) => void) {
  if (!g) return;
  switch (g.type) {
    case 'Point': fn(g.coordinates as Pt); break;
    case 'MultiPoint': case 'LineString': g.coordinates.forEach((c) => fn(c as Pt)); break;
    case 'MultiLineString': case 'Polygon': g.coordinates.forEach((r) => r.forEach((c) => fn(c as Pt))); break;
    case 'MultiPolygon': g.coordinates.forEach((p) => p.forEach((r) => r.forEach((c) => fn(c as Pt)))); break;
    case 'GeometryCollection': g.geometries.forEach((x) => eachCoord(x, fn)); break;
  }
}

function LocalVectorView({ dataset }: { dataset: Dataset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [geojson, setGeojson] = useState<GeoJSON.FeatureCollection | null>(null);
  const { showError } = useToast();

  useEffect(() => {
    api.getGeoJSON(dataset.id, 'native').then(setGeojson).catch((e: Error) => showError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!geojson || !canvas || !ctx) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    geojson.features.forEach((f) => eachCoord(f.geometry, ([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }));
    if (!isFinite(minX)) return;
    const pad = 24;
    const scale = Math.min((canvas.width - pad * 2) / (maxX - minX || 1), (canvas.height - pad * 2) / (maxY - minY || 1));
    const tx = (x: number) => pad + (x - minX) * scale;
    const ty = (y: number) => canvas.height - pad - (y - minY) * scale;

    ctx.fillStyle = '#dde5e8';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = COLOR; ctx.fillStyle = 'rgba(3,123,192,0.22)'; ctx.lineWidth = 1.5;
    const path = (pts: number[][], close: boolean) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(tx(x), ty(y)) : ctx.lineTo(tx(x), ty(y))));
      if (close) ctx.closePath();
    };
    const draw = (g: GeoJSON.Geometry | null) => {
      if (!g) return;
      switch (g.type) {
        case 'Point': case 'MultiPoint':
          (g.type === 'Point' ? [g.coordinates] : g.coordinates).forEach(([x, y]) => { ctx.beginPath(); ctx.arc(tx(x), ty(y), 4, 0, 6.2832); ctx.fill(); ctx.stroke(); });
          break;
        case 'LineString': path(g.coordinates, false); ctx.stroke(); break;
        case 'MultiLineString': g.coordinates.forEach((l) => { path(l, false); ctx.stroke(); }); break;
        case 'Polygon': g.coordinates.forEach((r) => { path(r, true); ctx.fill(); ctx.stroke(); }); break;
        case 'MultiPolygon': g.coordinates.forEach((p) => p.forEach((r) => { path(r, true); ctx.fill(); ctx.stroke(); })); break;
        case 'GeometryCollection': g.geometries.forEach(draw); break;
      }
    };
    geojson.features.forEach((f) => draw(f.geometry));
  }, [geojson]);

  return (
    <div className="local-frame-wrap">
      <div style={{ textAlign: 'center' }}>
        <canvas ref={canvasRef} width={720} height={480} style={{ maxWidth: '100%', borderRadius: 4, boxShadow: 'var(--shadow)' }} />
        <p className="muted" style={{ marginTop: 8 }}>
          Stored coordinates drawn as-is. This dataset has no CRS yet, so it cannot be shown on the map: use the Georeference panel.
        </p>
      </div>
    </div>
  );
}

function AttributeTable({ dataset }: { dataset: Dataset }) {
  const [data, setData] = useState<{ fields: string[]; rows: Record<string, unknown>[]; total: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 50;
  const { showError } = useToast();
  const m = dataset.meta as VectorMeta;

  useEffect(() => {
    api.getFeatures(dataset.id, offset, LIMIT)
      .then(setData)
      .catch((e: Error) => showError(e.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id, offset]);

  if (!data) return <div className="loading-center"><div className="spinner" /></div>;

  const fields = data.fields.length > 0 ? data.fields : m.fields.map((f) => f.name);

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '8px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border-2)', fontSize: 12, color: 'var(--tx-2)' }}>
        {data.total.toLocaleString()} features
        {data.total > LIMIT && (
          <span>
            {' · '}
            <button className="btn btn-ghost btn-xs" onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0}>
              ← Prev
            </button>
            {' '}
            {offset + 1}–{Math.min(offset + LIMIT, data.total)}
            {' '}
            <button className="btn btn-ghost btn-xs" onClick={() => setOffset(offset + LIMIT)} disabled={offset + LIMIT >= data.total}>
              Next →
            </button>
          </span>
        )}
      </div>
      <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
        <table>
          <thead>
            <tr>{fields.map((f) => <th key={f}>{f}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                {fields.map((f) => <td key={f} style={{ fontSize: 12 }}>{String(row[f] ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
