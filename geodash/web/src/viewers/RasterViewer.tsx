import { useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import { tileUrl, imageUrl, type Dataset, type RasterMeta } from '../api';
import { BasemapSelect, createMap, fitTo, useBasemap, type Bounds } from '../maps/basemaps';
import { MapTools } from '../maps/MapTools';

interface RasterViewerProps {
  dataset: Dataset;
  georefVersion: number;
}

const LAYER = 'raster-layer';
const SOURCE = 'raster-source';

export function RasterViewer({ dataset, georefVersion }: RasterViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [opacity, setOpacity] = useState(1);
  const meta = dataset.meta as RasterMeta;
  const bounds = dataset.georef.bounds_wgs84 as Bounds | null;
  const isReferenced = dataset.effective_status === 'ready' && !!bounds;
  const bm = useBasemap(map, ready);

  useEffect(() => {
    if (!isReferenced || !containerRef.current) return;
    const m = createMap(containerRef.current, { bounds });
    m.on('load', () => setReady(true));
    setMap(m);
    return () => { setReady(false); setMap(null); m.remove(); };
  // The map is created once per dataset; bounds changes are handled by the layer effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id, isReferenced]);

  useEffect(() => {
    if (!map || !ready || !bounds) return;
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    map.addSource(SOURCE, { type: 'raster', tiles: [tileUrl(dataset.id, georefVersion)], tileSize: 256, bounds });
    map.addLayer({ id: LAYER, type: 'raster', source: SOURCE, paint: { 'raster-opacity': opacity } });
    fitTo(map, bounds);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, dataset.id, georefVersion]);

  useEffect(() => {
    if (map && ready && map.getLayer(LAYER)) map.setPaintProperty(LAYER, 'raster-opacity', opacity);
  }, [map, ready, opacity]);

  const isDEM = ['dem', 'dsm', 'dtm'].includes(dataset.category) && meta.bands === 1;

  if (!isReferenced) return <UnreferencedRasterView dataset={dataset} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="viewer-toolbar">
        <span className="muted">Opacity</span>
        <input type="range" min={0} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)}
          style={{ width: 140 }} aria-label="Layer opacity" />
        <span className="muted" style={{ width: 36 }}>{Math.round(opacity * 100)}%</span>
        {isDEM && meta.stretch?.[0] && <DemLegend lo={meta.stretch[0][0]} hi={meta.stretch[0][1]} />}
      </div>
      <div className="map-box" style={{ flex: 1 }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        <BasemapSelect bm={bm} />
        <MapTools map={map} ready={ready} />
      </div>
    </div>
  );
}

function DemLegend({ lo, hi }: { lo: number; hi: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }} title="Colour stretch used for display (2nd to 98th percentile)">
      <span className="muted">{lo.toFixed(1)}</span>
      <div className="legend-ramp" style={{ width: 110 }} />
      <span className="muted">{hi.toFixed(1)}</span>
    </div>
  );
}

function UnreferencedRasterView({ dataset }: { dataset: Dataset }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--canvas-bg)', padding: 20 }}>
      <img src={imageUrl(dataset.id)} alt="Raster preview in its own pixel frame"
        style={{ maxWidth: '80%', maxHeight: '70%', boxShadow: 'var(--shadow-lg)', borderRadius: 4 }} />
      <p className="muted" style={{ marginTop: 12 }}>
        Preview in the image's own pixel frame. It has no ground coordinates yet: use the Georeference panel.
      </p>
    </div>
  );
}
