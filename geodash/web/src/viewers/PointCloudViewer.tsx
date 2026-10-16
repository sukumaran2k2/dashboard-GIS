import { useCallback, useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { api, pointsUrl, imageUrl, type Dataset, type PointCloudMeta } from '../api';
import { useToast } from '../components/Toast';
import { BasemapSelect, createMap, fitTo, useBasemap, type Bounds } from '../maps/basemaps';
import { MapTools } from '../maps/MapTools';

interface PointCloudViewerProps {
  dataset: Dataset;
}

type TabType = '3d' | 'footprint';

export function PointCloudViewer({ dataset }: PointCloudViewerProps) {
  const [tab, setTab] = useState<TabType>('3d');
  const isReferenced = dataset.effective_status === 'ready';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="tabs">
        <button className={`tab${tab === '3d' ? ' active' : ''}`} onClick={() => setTab('3d')}>3D</button>
        <button className={`tab${tab === 'footprint' ? ' active' : ''}`} onClick={() => setTab('footprint')}>Map footprint</button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {tab === '3d' && <ThreeDView dataset={dataset} />}
        {tab === 'footprint' && (isReferenced ? <FootprintMapView dataset={dataset} /> : <LocalFootprintView dataset={dataset} />)}
      </div>
    </div>
  );
}

interface Viewer3D {
  setOrtho: (on: boolean) => void;
  setPointSize: (px: number) => void;
  reset: () => void;
}

function niceLength(worldPerPx: number) {
  const target = worldPerPx * 100;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const f = target / pow;
  const len = (f >= 5 ? 5 : f >= 2 ? 2 : 1) * pow;
  return { len, px: len / worldPerPx };
}

function ThreeDView({ dataset }: { dataset: Dataset }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer3D | null>(null);
  const { showError } = useToast();
  const m = dataset.meta as PointCloudMeta;
  const [pointSize, setPointSize] = useState(2);
  const [ortho, setOrtho] = useState(false);
  const [loading, setLoading] = useState(true);
  const [webgl, setWebgl] = useState(true);
  const unit = m.native?.units === 'metre' ? 'm' : (m.native?.units ?? 'units');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setWebgl(false);
      setLoading(false);
      return;
    }
    let disposed = false;
    const size = () => ({ w: host.clientWidth || 800, h: host.clientHeight || 600 });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(size().w, size().h);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a2332);

    const ex = m.maxs[0] - m.mins[0], ey = m.maxs[1] - m.mins[1], ez = m.maxs[2] - m.mins[2];
    const span = Math.max(ex, ey, ez, 1e-6);
    const half = Math.max(ex, ey, 1e-6) * 0.58;

    // Perspective camera: Z is up, as stored in the file.
    const persp = new THREE.PerspectiveCamera(55, size().w / size().h, span / 1e4, span * 100);
    persp.up.set(0, 0, 1);
    const orthoCam = new THREE.OrthographicCamera(-half, half, half, -half, -span * 10, span * 10);
    orthoCam.up.set(0, 1, 0);

    const perspControls = new OrbitControls(persp, renderer.domElement);
    perspControls.enableDamping = true;
    const orthoControls = new OrbitControls(orthoCam, renderer.domElement);
    orthoControls.enableRotate = false;          // straight down, north (+Y) up
    orthoControls.screenSpacePanning = true;
    orthoControls.enabled = false;

    let isOrtho = false;
    const resetCameras = () => {
      persp.position.set(0, -span * 1.25, span * 0.75);
      persp.lookAt(0, 0, 0);
      perspControls.target.set(0, 0, 0);
      orthoCam.position.set(0, 0, span * 2);
      orthoCam.zoom = 1;
      orthoCam.lookAt(0, 0, 0);
      orthoControls.target.set(0, 0, 0);
      perspControls.update();
      orthoControls.update();
    };
    const resize = () => {
      const { w, h } = size();
      renderer.setSize(w, h);
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      orthoCam.left = -half * (w / h);
      orthoCam.right = half * (w / h);
      orthoCam.top = half;
      orthoCam.bottom = -half;
      orthoCam.updateProjectionMatrix();
    };
    resize();
    resetCameras();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let points: THREE.Points | null = null;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      (isOrtho ? orthoControls : perspControls).update();
      renderer.render(scene, isOrtho ? orthoCam : persp);
      const bar = scaleRef.current;
      if (bar && isOrtho) {
        const worldPerPx = (orthoCam.top - orthoCam.bottom) / (orthoCam.zoom * renderer.domElement.clientHeight);
        const { len, px } = niceLength(worldPerPx);
        bar.style.width = `${px}px`;
        bar.dataset.label = `${len >= 1 ? len : len.toPrecision(1)} ${unit}`;
      }
    };
    loop();

    viewerRef.current = {
      setOrtho: (on) => {
        isOrtho = on;
        perspControls.enabled = !on;
        orthoControls.enabled = on;
      },
      setPointSize: (px) => { if (points) (points.material as THREE.PointsMaterial).size = px; },
      reset: resetCameras,
    };

    fetch(pointsUrl(dataset.id))
      .then((r) => {
        if (!r.ok) throw new Error('Could not load the point preview.');
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (disposed) return;
        const n = m.preview_points;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 0, n * 3), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf, n * 12, n * 3), 3, true));
        geometry.computeBoundingSphere();
        const material = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true });
        points = new THREE.Points(geometry, material);
        scene.add(points);
        setLoading(false);
      })
      .catch((e: Error) => { if (!disposed) { showError(e.message); setLoading(false); } });

    return () => {
      disposed = true;
      viewerRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      perspControls.dispose();
      orthoControls.dispose();
      if (points) { points.geometry.dispose(); (points.material as THREE.Material).dispose(); }
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  useEffect(() => { viewerRef.current?.setOrtho(ortho); }, [ortho, loading]);
  useEffect(() => { viewerRef.current?.setPointSize(pointSize); }, [pointSize, loading]);
  const reset = useCallback(() => viewerRef.current?.reset(), []);

  if (!webgl) {
    return <div className="local-frame-wrap"><p className="muted">WebGL is not available in this browser, so the 3D view cannot be shown. The top-down image is on the Map footprint tab.</p></div>;
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />

      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(26,35,50,0.7)' }}>
          <div style={{ color: '#fff', textAlign: 'center' }}>
            <div className="spinner" style={{ borderColor: '#456', borderTopColor: '#adf', margin: '0 auto 8px' }} />
            Loading point cloud…
          </div>
        </div>
      )}

      <div className="viewer3d-hud">
        <label>
          <input type="checkbox" checked={ortho} onChange={(e) => setOrtho(e.target.checked)} />
          {' '}Top-down (orthographic)
        </label>
        <div className="row">
          <span>Point size</span>
          <input type="range" min={1} max={10} step={0.5} value={pointSize}
            onChange={(e) => setPointSize(+e.target.value)} style={{ width: 80 }} aria-label="Point size" />
          <span>{pointSize}</span>
        </div>
        <button className="btn btn-secondary btn-xs" onClick={reset}>Reset view</button>
        <div className="hud-note">
          {m.points.toLocaleString()} points ({m.preview_points.toLocaleString()} shown). Stored coordinates; placement is not applied in this view.
        </div>
      </div>

      {ortho && (
        <>
          <div className="north-arrow" title="+Y of the stored coordinates (grid north when the data has a CRS)">
            <svg width="28" height="36" viewBox="0 0 28 36" aria-hidden="true"><path d="M14 2 L24 30 L14 24 L4 30 Z" fill="#fff" stroke="#1a2332" strokeWidth="1.5" /></svg>
            <span>N</span>
          </div>
          <div className="scale-bar"><div ref={scaleRef} className="scale-bar-line" /></div>
        </>
      )}
    </div>
  );
}

type Corners = [[number, number], [number, number], [number, number], [number, number]];

function FootprintMapView({ dataset }: { dataset: Dataset }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const { showError } = useToast();
  const bounds = dataset.georef.bounds_wgs84 as Bounds | null;
  const bm = useBasemap(map, ready);

  useEffect(() => {
    if (!containerRef.current) return;
    const mp = createMap(containerRef.current, { bounds });
    mp.on('load', () => setReady(true));
    setMap(mp);
    return () => { setReady(false); setMap(null); mp.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  useEffect(() => {
    if (!map || !ready) return;
    let alive = true;
    api.getGeoref(dataset.id).then((g) => {
      const corners = g.effective?.corners_wgs84 as Corners | undefined;
      if (!alive || !corners) return;
      ['pc-image-layer', 'pc-outline-layer'].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      ['pc-image', 'pc-outline'].forEach((id) => { if (map.getSource(id)) map.removeSource(id); });
      map.addSource('pc-image', { type: 'image', url: imageUrl(dataset.id), coordinates: corners });
      map.addLayer({ id: 'pc-image-layer', type: 'raster', source: 'pc-image', paint: { 'raster-opacity': 0.85 } });
      map.addSource('pc-outline', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] } } });
      map.addLayer({ id: 'pc-outline-layer', type: 'line', source: 'pc-outline', paint: { 'line-color': '#037bc0', 'line-width': 2, 'line-dasharray': [3, 2] } });
      if (bounds) fitTo(map, bounds);
    }).catch((e: Error) => { if (alive) showError(e.message); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ready, dataset.id, dataset.georef.version]);

  return (
    <div className="map-box">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <BasemapSelect bm={bm} />
      <MapTools map={map} ready={ready} />
    </div>
  );
}

function LocalFootprintView({ dataset }: { dataset: Dataset }) {
  const m = dataset.meta as PointCloudMeta;
  return (
    <div className="local-frame-wrap">
      <div style={{ textAlign: 'center' }}>
        <img src={imageUrl(dataset.id)} alt="Top-down orthographic view"
          style={{ maxWidth: '80%', maxHeight: '70%', boxShadow: 'var(--shadow-lg)', borderRadius: 4 }} />
        <p className="muted" style={{ marginTop: 8 }}>
          Top-down view · {m.points.toLocaleString()} points · local coordinates. It has no CRS yet: use the Georeference panel to place it.
        </p>
      </div>
    </div>
  );
}
