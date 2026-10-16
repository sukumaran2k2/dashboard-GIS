/** Shared map plumbing: map creation, basemaps (OSM, Esri, none, Google via the server session) and the selector UI. */
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import maplibregl from 'maplibre-gl';
import { api } from '../api';
import { useToast } from '../components/Toast';

export type Bounds = [number, number, number, number];
export type BasemapKey =
  | 'none' | 'osm' | 'esri'
  | 'google-satellite' | 'google-hybrid' | 'google-roadmap' | 'google-terrain';

export const BASEMAP_LIST: { key: BasemapKey; label: string; google: boolean }[] = [
  { key: 'osm', label: 'OpenStreetMap', google: false },
  { key: 'esri', label: 'Esri World Imagery', google: false },
  { key: 'google-satellite', label: 'Google Satellite', google: true },
  { key: 'google-hybrid', label: 'Google Hybrid', google: true },
  { key: 'google-roadmap', label: 'Google Roads', google: true },
  { key: 'google-terrain', label: 'Google Terrain', google: true },
  { key: 'none', label: 'None (works offline)', google: false },
];

const SRC = 'basemap-src';
const LAYER = 'basemap-layer';
const STORE = 'geodash.basemap';

interface Spec { tiles: string; attribution: string; maxzoom: number }

function loadChoice(): BasemapKey {
  try {
    const v = localStorage.getItem(STORE) as BasemapKey | null;
    if (v && BASEMAP_LIST.some((b) => b.key === v)) return v;
  } catch { /* storage unavailable */ }
  return 'osm';
}

function saveChoice(k: BasemapKey) {
  try { localStorage.setItem(STORE, k); } catch { /* storage unavailable */ }
}

const googleCache = new Map<string, { at: number; spec: Spec }>();

async function resolve(key: BasemapKey): Promise<Spec | null> {
  switch (key) {
    case 'none':
      return null;
    case 'osm':
      return { tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxzoom: 19 };
    case 'esri':
      return {
        tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        attribution: 'Tiles © Esri', maxzoom: 19,
      };
    default: {
      const type = key.replace('google-', '') as 'satellite' | 'hybrid' | 'roadmap' | 'terrain';
      const hit = googleCache.get(type);
      if (hit && Date.now() - hit.at < 30 * 60_000) return hit.spec;
      const s = await api.googleSession(type);
      const spec = { tiles: s.tiles, attribution: s.attribution || 'Map data © Google', maxzoom: 21 };
      googleCache.set(type, { at: Date.now(), spec });
      return spec;
    }
  }
}

/** Puts the chosen basemap under every other layer. Throws (with the server's message) if it cannot be loaded. */
export async function applyBasemap(map: maplibregl.Map, key: BasemapKey, alive: () => boolean) {
  const spec = await resolve(key);
  if (!alive()) return;
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SRC)) map.removeSource(SRC);
  if (!spec) return;
  map.addSource(SRC, { type: 'raster', tiles: [spec.tiles], tileSize: 256, attribution: spec.attribution, maxzoom: spec.maxzoom });
  const first = map.getStyle().layers.find((l) => l.id !== LAYER)?.id;
  map.addLayer({ id: LAYER, type: 'raster', source: SRC }, first);
}

/** A map with no style layers (the basemap hook adds one) that opens directly at `bounds`, with no animation. */
export function createMap(container: HTMLElement, opts: { bounds?: Bounds | null; center?: [number, number]; zoom?: number } = {}) {
  const base = {
    container, style: { version: 8 as const, sources: {}, layers: [] },
    maxZoom: 21, attributionControl: { compact: true },
  };
  const map = new maplibregl.Map(opts.bounds
    ? { ...base, bounds: opts.bounds, fitBoundsOptions: { padding: 40, maxZoom: 20 } }
    : { ...base, center: opts.center ?? [0, 20], zoom: opts.zoom ?? 2 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  return map;
}

export function fitTo(map: maplibregl.Map, b: Bounds, padding = 40) {
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding, maxZoom: 20, animate: false });
}

export function useBasemap(map: maplibregl.Map | null, ready: boolean) {
  const { showError } = useToast();
  const { data: config } = useQuery({ queryKey: ['config'], queryFn: api.config, staleTime: Infinity });
  const [key, setKeyState] = useState<BasemapKey>(loadChoice);
  const setKey = useCallback((k: BasemapKey) => { saveChoice(k); setKeyState(k); }, []);

  useEffect(() => {
    if (!map || !ready) return;
    let alive = true;
    applyBasemap(map, key, () => alive).catch((e: Error) => {
      if (!alive) return;
      showError(`${e.message} Using OpenStreetMap instead.`);
      setKey('osm');
    });
    return () => { alive = false; };
  }, [map, ready, key, setKey, showError]);

  return { key, setKey, googleEnabled: !!config?.google_maps };
}

export function BasemapSelect({ bm }: { bm: ReturnType<typeof useBasemap> }) {
  return (
    <label className="map-overlay">
      <span>Basemap</span>
      <select value={bm.key} onChange={(e) => bm.setKey(e.target.value as BasemapKey)} aria-label="Basemap">
        {BASEMAP_LIST.map((b) => (
          <option key={b.key} value={b.key} disabled={b.google && !bm.googleEnabled}>
            {b.label}{b.google && !bm.googleEnabled ? ' (set GOOGLE_MAPS_API_KEY)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
