import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import { api, fmtBytes, imageUrl, tileUrl } from '../api';
import type { Dataset, RasterMeta } from '../api';
import { useParams, useNavigate } from '../router';
import { useToast } from '../components/Toast';
import { BasemapSelect, createMap, esc, fitTo, useBasemap, type Bounds } from '../maps/basemaps';
import { MapTools } from '../maps/MapTools';

interface LayerState {
  dataset: Dataset;
  visible: boolean;
  opacity: number;
}

const PALETTE = ['#037bc0', '#c42b3c', '#7b3fb5', '#d68910', '#2c2e77', '#1e8449'];

const ready = (d: Dataset) => d.effective_status === 'ready' && !!d.georef.bounds_wgs84;
const srcId = (d: Dataset) => `ds-${d.id}`;
const layerIds = (d: Dataset) => (d.kind === 'vector'
  ? [`ly-${d.id}-fill`, `ly-${d.id}-line`, `ly-${d.id}-circle`]
  : [`ly-${d.id}`]);

function unionBounds(ds: Dataset[]): Bounds | null {
  const bs = ds.filter(ready).map((d) => d.georef.bounds_wgs84 as Bounds);
  if (!bs.length) return null;
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
}

export function ProjectMap() {
  const { id: pid } = useParams();
  const navigate = useNavigate();
  const { showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [layers, setLayers] = useState<LayerState[]>([]);
  const [tick, setTick] = useState(0);
  const loadingVectors = useRef(new Set<string>());
  const fitted = useRef(false);
  const bm = useBasemap(map, mapReady);

  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const project = projects?.find((p) => p.id === pid);
  const { data: datasets } = useQuery({
    queryKey: ['datasets', { project: pid }],
    queryFn: () => api.listDatasets({ project: pid }),
    enabled: !!pid,
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const m = createMap(containerRef.current);
    m.on('load', () => setMapReady(true));
    setMap(m);
    return () => { setMapReady(false); setMap(null); fitted.current = false; loadingVectors.current.clear(); m.remove(); };
  }, []);

  useEffect(() => {
    if (!datasets) return;
    setLayers(datasets.map((d) => ({ dataset: d, visible: ready(d), opacity: 1 })));
  }, [datasets]);

  useEffect(() => {
    if (!map || !mapReady || !datasets || fitted.current) return;
    const b = unionBounds(datasets);
    if (b) { fitTo(map, b); fitted.current = true; }
  }, [map, mapReady, datasets]);

  // add sources/layers, then apply visibility, opacity and stacking order
  useEffect(() => {
    if (!map || !mapReady) return;
    const popup = new maplibregl.Popup({ maxWidth: '320px' });
    layers.forEach((l, idx) => {
      const d = l.dataset;
      if (!ready(d)) return;
      const b = d.georef.bounds_wgs84 as Bounds;
      if (!map.getSource(srcId(d))) {
        if (d.kind === 'raster') {
          map.addSource(srcId(d), { type: 'raster', tiles: [tileUrl(d.id, d.georef.version)], tileSize: 256, bounds: b });
          map.addLayer({ id: `ly-${d.id}`, type: 'raster', source: srcId(d) });
        } else if (d.kind === 'pointcloud') {
          api.getGeoref(d.id).then((g) => {
            const k = g.effective?.corners_wgs84;
            if (!k || map.getSource(srcId(d))) return;
            map.addSource(srcId(d), { type: 'image', url: imageUrl(d.id), coordinates: k as [[number, number], [number, number], [number, number], [number, number]] });
            map.addLayer({ id: `ly-${d.id}`, type: 'raster', source: srcId(d) });
            setTick((t) => t + 1);
          }).catch((e: Error) => showError(e.message));
        } else if (!loadingVectors.current.has(d.id)) {
          loadingVectors.current.add(d.id);
          const color = PALETTE[idx % PALETTE.length];
          fetch(`/api/datasets/${d.id}/geojson?v=${d.georef.version}`)
            .then(async (r) => {
              if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { detail?: string }).detail ?? r.statusText);
              return r.json() as Promise<GeoJSON.FeatureCollection>;
            })
            .then((gj) => {
              if (map.getSource(srcId(d))) return;
              map.addSource(srcId(d), { type: 'geojson', data: gj });
              map.addLayer({ id: `ly-${d.id}-fill`, type: 'fill', source: srcId(d), filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']], paint: { 'fill-color': color } });
              map.addLayer({ id: `ly-${d.id}-line`, type: 'line', source: srcId(d), filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': color, 'line-width': 1.8 } });
              map.addLayer({ id: `ly-${d.id}-circle`, type: 'circle', source: srcId(d), filter: ['any', ['==', ['geometry-type'], 'Point'], ['==', ['geometry-type'], 'MultiPoint']], paint: { 'circle-color': color, 'circle-radius': 5, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });
              layerIds(d).forEach((id) => {
                map.on('click', id, (e) => {
                  if (map.getCanvas().dataset.measuring) return;
                  const f = e.features?.[0];
                  if (!f) return;
                  const rows = Object.entries(f.properties ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v ?? '—')}</td></tr>`).join('');
                  popup.setLngLat(e.lngLat).setHTML(`<div class="feature-popup"><b>${esc(d.filename)}</b><table>${rows}</table></div>`).addTo(map);
                });
              });
              setTick((t) => t + 1);
            })
            .catch((e: Error) => showError(`${d.filename}: ${e.message}`))
            .finally(() => loadingVectors.current.delete(d.id));
        }
      }
      layerIds(d).forEach((id) => {
        if (!map.getLayer(id)) return;
        map.setLayoutProperty(id, 'visibility', l.visible ? 'visible' : 'none');
        if (d.kind === 'vector') {
          if (id.endsWith('-fill')) map.setPaintProperty(id, 'fill-opacity', l.opacity * 0.35);
          else if (id.endsWith('-line')) map.setPaintProperty(id, 'line-opacity', l.opacity);
          else { map.setPaintProperty(id, 'circle-opacity', l.opacity); map.setPaintProperty(id, 'circle-stroke-opacity', l.opacity); }
        } else {
          map.setPaintProperty(id, 'raster-opacity', l.opacity);
        }
      });
    });
    // first item in the list is drawn on top
    [...layers].reverse().forEach((l) => layerIds(l.dataset).forEach((id) => { if (map.getLayer(id)) map.moveLayer(id); }));
    return () => { popup.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mapReady, layers, tick]);

  function updateLayer(i: number, patch: Partial<LayerState>) {
    setLayers((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function moveLayer(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= layers.length) return;
    setLayers((prev) => { const next = [...prev]; [next[i], next[j]] = [next[j], next[i]]; return next; });
  }

  const legend = useMemo(() => layers.filter((l) => l.visible && ready(l.dataset)), [layers]);
  const readyCount = layers.filter((l) => ready(l.dataset)).length;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div className="project-map-panel">
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate(`/project/${pid}`)}>← Back</button>
          <strong style={{ fontSize: 13 }}>{project?.name}</strong>
        </div>

        <div style={{ padding: 10, flex: 1 }}>
          <h4 style={{ marginBottom: 8 }}>Layers</h4>
          {layers.length === 0 && <p className="muted">This project has no datasets yet.</p>}
          {layers.length > 0 && readyCount === 0 && <p className="muted">None of the datasets has ground coordinates yet. Open one and use Georeference.</p>}
          {layers.map((layer, i) => {
            const d = layer.dataset;
            const unreferenced = !ready(d);
            return (
              <div key={d.id} className="layer-item" style={unreferenced ? { opacity: 0.8 } : undefined}>
                <div className="layer-item-name">{d.filename}</div>
                <div className="layer-item-meta">
                  {d.kind}
                  {unreferenced ? (
                    <>
                      {' · '}
                      <button className="btn btn-ghost btn-xs" style={{ color: 'var(--amber)', padding: '0 4px' }} onClick={() => navigate(`/dataset/${d.id}`)}>
                        Needs georeferencing
                      </button>
                    </>
                  ) : ` · ${d.georef.crs ?? ''} · ${fmtBytes(d.size)}`}
                </div>
                {!unreferenced && (
                  <div className="layer-item-controls">
                    <label style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={layer.visible} onChange={(e) => updateLayer(i, { visible: e.target.checked })} aria-label={`Show ${d.filename}`} />
                      {' '}Visible
                    </label>
                    <input type="range" min={0} max={1} step={0.05} value={layer.opacity} onChange={(e) => updateLayer(i, { opacity: +e.target.value })}
                      style={{ flex: 1, minWidth: 60 }} aria-label={`Opacity of ${d.filename}`} />
                    <span className="opacity-val">{Math.round(layer.opacity * 100)}%</span>
                    <button className="btn btn-secondary btn-xs" onClick={() => moveLayer(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                    <button className="btn btn-secondary btn-xs" onClick={() => moveLayer(i, 1)} disabled={i === layers.length - 1} aria-label="Move down">↓</button>
                    <button className="btn btn-secondary btn-xs" onClick={() => map && fitTo(map, d.georef.bounds_wgs84 as Bounds)}>Zoom</button>
                    <button className="btn btn-secondary btn-xs" onClick={() => navigate(`/dataset/${d.id}`)}>Open</button>
                  </div>
                )}
              </div>
            );
          })}

          {legend.length > 0 && (
            <>
              <h4 style={{ margin: '14px 0 8px' }}>Legend</h4>
              {legend.map((l) => {
                const d = l.dataset;
                if (d.kind === 'raster' && ['dem', 'dsm', 'dtm'].includes(d.category) && (d.meta as RasterMeta).bands === 1) {
                  const st = (d.meta as RasterMeta).stretch?.[0];
                  return (
                    <div key={d.id} style={{ marginBottom: 8, fontSize: 12 }}>
                      <div>{d.filename}</div>
                      <div className="legend-ramp" />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{st?.[0].toFixed(1)}</span><span>elevation</span><span>{st?.[1].toFixed(1)}</span>
                      </div>
                    </div>
                  );
                }
                if (d.kind === 'vector') {
                  const color = PALETTE[layers.indexOf(l) % PALETTE.length];
                  return <div key={d.id} style={{ fontSize: 12, marginBottom: 6 }}><span className="swatch" style={{ background: color }} /> {d.filename}</div>;
                }
                return <div key={d.id} style={{ fontSize: 12, marginBottom: 6 }}>{d.filename}: {d.kind === 'pointcloud' ? 'top-down view of the points' : 'image colours'}</div>;
              })}
            </>
          )}
        </div>
      </div>

      <div className="map-box" style={{ flex: 1 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0, background: 'var(--canvas-bg)' }} />
        <BasemapSelect bm={bm} />
        <MapTools map={map} ready={mapReady} />
      </div>
    </div>
  );
}
