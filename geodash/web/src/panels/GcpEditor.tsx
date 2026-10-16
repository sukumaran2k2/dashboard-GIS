/**
 * Control-point georeferencing workspace for rasters without ground coordinates.
 * The user pairs points on the image with ground positions (typed, clicked or dragged on the map);
 * the server fits the transform and reports residuals. Nothing is fitted in the browser.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { api, imageUrl, type Dataset, type RasterMeta } from '../api';
import { useToast } from '../components/Toast';
import { BasemapSelect, createMap, useBasemap, type Bounds } from '../maps/basemaps';

export interface GcpPoint { col: number; row: number; x: number | null; y: number | null }
export const isComplete = (p: GcpPoint): p is GcpPoint & { x: number; y: number } => p.x !== null && p.y !== null;

interface GcpResult { rmse_m: number; residuals_m: number[]; warnings: string[] }

interface Props {
  dataset: Dataset;
  points: GcpPoint[];
  setPoints: React.Dispatch<React.SetStateAction<GcpPoint[]>>;
  crs: string;
  setCrs: (s: string) => void;
  onSave: () => Promise<boolean>;
}

const isWgs84 = (crs: string) => ['EPSG:4326', '4326'].includes(crs.trim().toUpperCase());

export function GcpEditor({ dataset, points, setPoints, crs, setCrs, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const complete = points.filter(isComplete).length;
  return (
    <div>
      <div className="form-group">
        <label className="form-label" htmlFor="gcp-crs">CRS of the ground coordinates</label>
        <input id="gcp-crs" type="text" value={crs} onChange={(e) => setCrs(e.target.value)} placeholder="EPSG:4326" />
      </div>
      <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 8 }}>
        Pair at least 3 points on the image with their real positions (4 or more lets the fit be checked).
        Points with no ground position yet are not used.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>Open control-point editor</button>
        <span className="muted">{points.length} point{points.length === 1 ? '' : 's'}, {complete} with ground position</span>
      </div>
      {open && (
        <Workspace dataset={dataset} points={points} setPoints={setPoints} crs={crs} setCrs={setCrs}
          onSave={onSave} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────────── workspace
function Workspace({ dataset, points, setPoints, crs, setCrs, onSave, onClose }: Props & { onClose: () => void }) {
  const { showError } = useToast();
  const m = dataset.meta as RasterMeta;
  const [selected, setSelected] = useState<number | null>(points.length ? 0 : null);
  const [result, setResult] = useState<{ r: GcpResult; index: number[] } | null>(null);
  const [crsNote, setCrsNote] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef({ points, selected, crs });
  latest.current = { points, selected, crs };

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  useEffect(() => { setResult(null); }, [points, crs]);

  async function checkCrs() {
    try { setCrsNote((await api.describeCrs(crs)).label); } catch (e) { setCrsNote(e instanceof Error ? e.message : 'Invalid CRS'); }
  }

  const completeIdx = points.map((p, i) => (isComplete(p) ? i : -1)).filter((i) => i >= 0);

  async function preview() {
    setBusy(true);
    try {
      const r = await api.previewGeoref(dataset.id, { mode: 'gcp', crs, points: points.filter(isComplete) });
      if (r.override?.gcp) setResult({ r: r.override.gcp as GcpResult, index: completeIdx });
    } catch (e) { showError(e instanceof Error ? e.message : 'Preview failed'); }
    setBusy(false);
  }

  async function save() {
    setBusy(true);
    const ok = await onSave();
    setBusy(false);
    if (ok) onClose();
  }

  const addPoint = useCallback((col: number, row: number) => {
    setPoints((prev) => [...prev, { col: Math.round(col * 10) / 10, row: Math.round(row * 10) / 10, x: null, y: null }]);
    setSelected(latest.current.points.length);
  }, [setPoints]);

  const setGround = useCallback(async (idx: number, lon: number, lat: number) => {
    try {
      let x = lon, y = lat;
      if (!isWgs84(latest.current.crs)) {
        const r = await api.transformCoords('EPSG:4326', latest.current.crs, [[lon, lat]]);
        [x, y] = r.points[0];
      }
      setPoints((prev) => prev.map((p, i) => (i === idx ? { ...p, x, y } : p)));
    } catch (e) { showError(e instanceof Error ? e.message : 'Coordinate conversion failed'); }
  }, [setPoints, showError]);

  const resFor = (i: number) => {
    if (!result) return null;
    const k = result.index.indexOf(i);
    return k >= 0 ? result.r.residuals_m[k] : null;
  };

  return (
    <div className="gcp-workspace" role="dialog" aria-label="Control point editor">
      <div className="place-big-header">
        <strong>Control points: {dataset.filename}</strong>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Ground CRS
          <input type="text" value={crs} onChange={(e) => setCrs(e.target.value)} onBlur={checkCrs} style={{ width: 130 }} aria-label="Ground CRS" />
        </label>
        {crsNote && <span className="muted">{crsNote}</span>}
        <span style={{ marginLeft: 'auto' }} />
        {result && (
          <span style={{ fontWeight: 600, color: result.r.rmse_m > 1 ? 'var(--amber)' : 'var(--green)' }}>
            RMSE {result.r.rmse_m.toFixed(3)} m
          </span>
        )}
        <button className="btn btn-secondary btn-sm" onClick={preview} disabled={busy || completeIdx.length < 3}>
          Check fit
        </button>
        <span className="muted">{completeIdx.length} of {points.length} usable (3 needed)</span>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || completeIdx.length < 3}>Save georeferencing</button>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
      </div>
      {result && result.r.warnings.length > 0 && (
        <div className="alert alert-warn" style={{ margin: '8px 14px 0' }}>{result.r.warnings.join(' ')}</div>
      )}
      <div className="gcp-panes">
        <div className="gcp-pane">
          <div className="gcp-pane-title">Image: click to add a point, drag to pan, scroll to zoom</div>
          <ImagePicker url={imageUrl(dataset.id)} width={m.width} height={m.height} points={points} selected={selected}
            onAdd={addPoint} onSelect={setSelected} />
        </div>
        <div className="gcp-pane">
          <div className="gcp-pane-title">
            Map: {selected !== null ? `click to set the ground position of point ${selected + 1} (markers can be dragged)` : 'select a point first'}
          </div>
          <GroundMap dataset={dataset} points={points} crs={crs} selected={selected} onPick={(lon, lat) => { if (selected !== null) setGround(selected, lon, lat); }}
            onDrag={setGround} onSelect={setSelected} />
        </div>
      </div>
      <div className="gcp-table-wrap">
        <table className="gcp-table">
          <thead><tr><th>#</th><th>Image col</th><th>Image row</th><th>Ground X</th><th>Ground Y</th><th>Residual (m)</th><th /></tr></thead>
          <tbody>
            {points.map((p, i) => {
              const res = resFor(i);
              return (
                <tr key={i} className={i === selected ? 'selected' : undefined} onClick={() => setSelected(i)}>
                  <td>{i + 1}</td>
                  <td>{p.col}</td>
                  <td>{p.row}</td>
                  {(['x', 'y'] as const).map((k) => (
                    <td key={k}>
                      <input type="number" step="any" value={p[k] ?? ''} aria-label={`Point ${i + 1} ground ${k.toUpperCase()}`}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = e.target.value === '' ? null : parseFloat(e.target.value);
                          setPoints((prev) => prev.map((q, j) => (j === i ? { ...q, [k]: v !== null && Number.isFinite(v) ? v : null } : q)));
                        }}
                        style={{ width: 130 }} />
                    </td>
                  ))}
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: res !== null && res > 1 ? 'var(--amber)' : undefined }}>
                    {res !== null ? res.toFixed(3) : isComplete(p) ? '' : 'needs ground position'}
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)' }} aria-label={`Remove point ${i + 1}`}
                      onClick={(e) => { e.stopPropagation(); setPoints((prev) => prev.filter((_, j) => j !== i)); setSelected(null); }}>Remove</button>
                  </td>
                </tr>
              );
            })}
            {points.length === 0 && <tr><td colSpan={7} className="muted">No points yet. Click the image to add the first one.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────────── image
interface PickerProps {
  url: string; width: number; height: number; points: GcpPoint[]; selected: number | null;
  onAdd: (col: number, row: number) => void; onSelect: (i: number) => void;
}

function ImagePicker({ url, width, height, points, selected, onAdd, onSelect }: PickerProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const view = useRef({ s: 1, ox: 0, oy: 0, fit: 1 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const live = useRef({ points, selected, img });
  live.current = { points, selected, img };

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
  }, [url]);

  const draw = useCallback(() => {
    const c = canvas.current, w = wrap.current;
    const { points: pts, selected: sel, img: im } = live.current;
    if (!c || !w) return;
    if (c.width !== w.clientWidth || c.height !== w.clientHeight) { c.width = w.clientWidth; c.height = w.clientHeight; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const v = view.current;
    ctx.fillStyle = '#c9d4d9';
    ctx.fillRect(0, 0, c.width, c.height);
    if (im) {
      ctx.imageSmoothingEnabled = v.s < 2.5;
      ctx.drawImage(im, v.ox, v.oy, width * v.s, height * v.s);
      ctx.strokeStyle = '#037bc0'; ctx.lineWidth = 1;
      ctx.strokeRect(v.ox, v.oy, width * v.s, height * v.s);
    }
    pts.forEach((p, i) => {
      const x = v.ox + p.col * v.s, y = v.oy + p.row * v.s;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.2832);
      ctx.fillStyle = i === sel ? '#e07020' : isComplete(p) ? '#2c2e77' : '#b07d0a';
      ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    });
  }, [width, height]);

  const fit = useCallback(() => {
    const w = wrap.current;
    if (!w) return;
    const s = Math.min(w.clientWidth / width, w.clientHeight / height) * 0.96;
    view.current = { s, fit: s, ox: (w.clientWidth - width * s) / 2, oy: (w.clientHeight - height * s) / 2 };
    draw();
  }, [width, height, draw]);

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const ro = new ResizeObserver(fit);
    ro.observe(w);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = w.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const v = view.current;
      const s = Math.min(Math.max(v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), v.fit * 0.5), 80);
      v.ox = px - ((px - v.ox) / v.s) * s;
      v.oy = py - ((py - v.oy) / v.s) * s;
      v.s = s;
      draw();
    };
    w.addEventListener('wheel', wheel, { passive: false });
    return () => { ro.disconnect(); w.removeEventListener('wheel', wheel); };
  }, [fit, draw]);

  useEffect(() => { draw(); }, [img, points, selected, draw]);

  const pos = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={wrap} className="gcp-image" role="img" aria-label="Raster image: click to add control points">
      <canvas ref={canvas} style={{ display: 'block', cursor: 'crosshair' }}
        onMouseDown={(e) => { const p = pos(e); drag.current = { x: p.x, y: p.y, ox: view.current.ox, oy: view.current.oy, moved: false }; }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const p = pos(e);
          if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) < 4) return;
          d.moved = true;
          view.current.ox = d.ox + p.x - d.x; view.current.oy = d.oy + p.y - d.y;
          draw();
        }}
        onMouseUp={(e) => {
          const d = drag.current; drag.current = null;
          if (!d || d.moved) return;
          const p = pos(e), v = view.current;
          const hit = live.current.points.findIndex((q) => Math.hypot(v.ox + q.col * v.s - p.x, v.oy + q.row * v.s - p.y) < 11);
          if (hit >= 0) { onSelect(hit); return; }
          const col = (p.x - v.ox) / v.s, row = (p.y - v.oy) / v.s;
          if (col >= 0 && col <= width && row >= 0 && row <= height) onAdd(col, row);
        }}
        onMouseLeave={() => { drag.current = null; }}
      />
      <div className="gcp-image-note">Shown from a reduced-resolution preview; coordinates are stored at full resolution.</div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────────────── map
interface GroundMapProps {
  dataset: Dataset; points: GcpPoint[]; crs: string; selected: number | null;
  onPick: (lon: number, lat: number) => void;
  onDrag: (idx: number, lon: number, lat: number) => void;
  onSelect: (i: number) => void;
}

function GroundMap({ dataset, points, crs, selected, onPick, onDrag, onSelect }: GroundMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const bm = useBasemap(map, ready);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [lonlats, setLonlats] = useState<Array<[number, number] | null>>([]);
  const [goto, setGoto] = useState('');
  const latest = useRef({ onPick, onDrag, onSelect });
  latest.current = { onPick, onDrag, onSelect };

  useEffect(() => {
    if (!el.current) return;
    const b = dataset.georef.bounds_wgs84 as Bounds | null;
    const mp = createMap(el.current, b ? { bounds: b } : {});
    mp.on('load', () => setReady(true));
    mp.on('click', (e) => latest.current.onPick(e.lngLat.lng, e.lngLat.lat));
    setMap(mp);
    return () => { markers.current.forEach((x) => x.remove()); markers.current = []; setReady(false); setMap(null); mp.remove(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id]);

  // ground positions of the points, as longitude/latitude for display
  const key = points.map((p) => `${p.x},${p.y}`).join('|') + '@' + crs;
  useEffect(() => {
    let alive = true;
    const idx = points.map((p, i) => (isComplete(p) ? i : -1)).filter((i) => i >= 0);
    const t = setTimeout(async () => {
      const out: Array<[number, number] | null> = points.map(() => null);
      try {
        if (idx.length) {
          const src = idx.map((i) => [points[i].x as number, points[i].y as number] as [number, number]);
          const r = isWgs84(crs) ? { points: src } : await api.transformCoords(crs, 'EPSG:4326', src);
          idx.forEach((i, k) => { out[i] = r.points[k]; });
        }
      } catch { /* an invalid CRS is reported by the editor header */ }
      if (alive) setLonlats(out);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!map) return;
    markers.current.forEach((x) => x.remove());
    markers.current = [];
    lonlats.forEach((ll, i) => {
      if (!ll) return;
      const node = document.createElement('div');
      node.textContent = String(i + 1);
      node.className = 'gcp-marker' + (i === selected ? ' sel' : '');
      const mk = new maplibregl.Marker({ element: node, draggable: true }).setLngLat(ll).addTo(map);
      node.addEventListener('click', (e) => { e.stopPropagation(); latest.current.onSelect(i); });
      mk.on('dragend', () => { const p = mk.getLngLat(); latest.current.onDrag(i, p.lng, p.lat); });
      markers.current.push(mk);
    });
  }, [map, lonlats, selected]);

  function go() {
    const nums = goto.split(/[ ,;]+/).map(Number).filter((n) => Number.isFinite(n));
    if (map && nums.length === 2) map.jumpTo({ center: [nums[1], nums[0]], zoom: Math.max(map.getZoom(), 16) });
  }

  return (
    <div className="map-box" style={{ flex: 1 }}>
      <div ref={el} style={{ position: 'absolute', inset: 0 }} />
      <BasemapSelect bm={bm} />
      <div className="map-overlay" style={{ top: 44 }}>
        <input value={goto} onChange={(e) => setGoto(e.target.value)} placeholder="Go to: lat, lon" style={{ width: 130, fontSize: 12 }}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} aria-label="Go to latitude and longitude" />
        <button className="btn btn-secondary btn-xs" onClick={go}>Go</button>
      </div>
    </div>
  );
}
