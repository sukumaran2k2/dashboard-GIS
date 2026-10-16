import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Dataset, type GeorefFull, type GeorefBody, type CrsInfo,
  type RasterMeta, type VectorMeta,
} from '../api';
import { useToast } from '../components/Toast';
import { PlaceMapEmbed } from './PlaceMapEmbed';
import { GcpEditor, isComplete, type GcpPoint } from './GcpEditor';

interface GeorefPanelProps {
  dataset: Dataset;
  georef: GeorefFull;
  onSaved: () => void;
  defaultOpen?: boolean;
  /** rendered inside the viewer's tab bar: no collapsible header of its own */
  embedded?: boolean;
}

export function GeorefPanel({ dataset, georef, onSaved, defaultOpen, embedded = false }: GeorefPanelProps) {
  const [open, setOpen] = useState(embedded || (defaultOpen ?? false));
  const [mode, setMode] = useState<'assign' | 'place' | 'gcp'>('assign');
  const qc = useQueryClient();
  const { showError, showToast } = useToast();

  const isRaster = dataset.kind === 'raster';
  const hasAffine = isRaster && (dataset.meta as RasterMeta).affine !== null;

  // CRS search state
  const [crsSearch, setCrsSearch] = useState('');
  const [crsResults, setCrsResults] = useState<CrsInfo[]>([]);
  const [selectedCrs, setSelectedCrs] = useState('');
  const [crsDesc, setCrsDesc] = useState('');
  const [wktInput, setWktInput] = useState('');
  const [wktValid, setWktValid] = useState<boolean | null>(null);
  const [wktError, setWktError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Grid fields
  const [gridOriginX, setGridOriginX] = useState('');
  const [gridOriginY, setGridOriginY] = useState('');
  const [gridPixelX, setGridPixelX] = useState('');

  // Place mode state
  const [anchorLon, setAnchorLon] = useState<number | null>(null);
  const [anchorLat, setAnchorLat] = useState<number | null>(null);
  const [anchorX, setAnchorX] = useState('');
  const [anchorY, setAnchorY] = useState('');
  const [anchorCrs, setAnchorCrs] = useState('EPSG:4326');
  const [anchorMode, setAnchorMode] = useState<'lonlat' | 'xy'>('lonlat');
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const [zOffset, setZOffset] = useState(0);
  const [pixelSize, setPixelSize] = useState('');
  const [placeCrs, setPlaceCrs] = useState('');
  const [outsideConfirm, setOutsideConfirm] = useState(false);
  const [confirmOutside, setConfirmOutside] = useState(false);

  // Preview result
  const [preview, setPreview] = useState<GeorefFull | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  // History
  const [showHistory, setShowHistory] = useState(false);
  const [reverting, setReverting] = useState(false);

  // GCP
  const [gcpPoints, setGcpPoints] = useState<GcpPoint[]>([]);
  const [gcpCrs, setGcpCrs] = useState('EPSG:4326');

  // Start from what the dataset has now (its saved placement, or its own location) so that saving never
  // silently resets a placement the user did not touch.
  useEffect(() => {
    const eff = georef.effective, ov = georef.override;
    if (eff?.center_wgs84) { setAnchorLon(eff.center_wgs84[0]); setAnchorLat(eff.center_wgs84[1]); }
    setRotation(ov?.rotation_deg ?? 0);
    setZOffset(ov?.z_offset ?? 0);
    setScale(ov?.scale ?? 1);
    const ps = (ov?.params as { pixel_size?: unknown } | undefined)?.pixel_size;
    if (typeof ps === 'number') setPixelSize(String(ps));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset.id, georef.override?.version, georef.status]);

  const searchDebounce = useCallback((q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (!q.trim()) { setCrsResults([]); return; }
      api.searchCrs(q).then(setCrsResults).catch(() => setCrsResults([]));
    }, 300);
  }, []);

  useEffect(() => { searchDebounce(crsSearch); }, [crsSearch, searchDebounce]);

  async function validateWkt(text: string) {
    if (!text.trim()) { setWktValid(null); setWktError(''); return; }
    try {
      const d = await api.describeCrs(text);
      setWktValid(true); setWktError('');
      setSelectedCrs(text);
      setCrsDesc(`${d.label} · ${d.units}`);
    } catch (err) {
      setWktValid(false);
      setWktError(err instanceof Error ? err.message : 'Invalid CRS');
    }
  }

  function selectCrsFromList(info: CrsInfo) {
    const code = `EPSG:${info.code}`;
    setSelectedCrs(code);
    setCrsDesc(`${info.name} · ${info.type}`);
    setCrsResults([]); setCrsSearch('');
  }

  function buildAssignBody(): GeorefBody {
    const body: GeorefBody = { mode: 'assign', crs: selectedCrs };
    if (!hasAffine && isRaster && gridOriginX && gridOriginY && gridPixelX) {
      body.grid = { origin_x: parseFloat(gridOriginX), origin_y: parseFloat(gridOriginY), pixel_x: parseFloat(gridPixelX) };
    }
    if (confirmOutside) body.confirm_outside_area = true;
    return body;
  }

  function buildPlaceBody(): GeorefBody {
    const body: GeorefBody = { mode: 'place', rotation_deg: rotation };
    if (anchorMode === 'lonlat' && anchorLon !== null && anchorLat !== null) {
      body.anchor = { lon: anchorLon, lat: anchorLat };
    } else if (anchorMode === 'xy' && anchorX && anchorY) {
      body.anchor = { x: parseFloat(anchorX), y: parseFloat(anchorY), crs: anchorCrs };
    }
    if (placeCrs) body.crs = placeCrs;
    if (georef.local) body.scale = scale;
    if (dataset.kind === 'pointcloud') body.z_offset = zOffset;
    if (isRaster && !hasAffine && pixelSize) body.pixel_size = parseFloat(pixelSize);
    if (confirmOutside) body.confirm_outside_area = true;
    return body;
  }

  function buildGcpBody(): GeorefBody {
    return { mode: 'gcp', crs: gcpCrs, points: gcpPoints.filter(isComplete) };
  }

  async function handlePreview() {
    setPreviewing(true); setPreviewError(''); setPreview(null); setOutsideConfirm(false);
    try {
      const body = mode === 'assign' ? buildAssignBody() : mode === 'place' ? buildPlaceBody() : buildGcpBody();
      const r = await api.previewGeoref(dataset.id, body);
      setPreview(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      setPreviewError(msg);
      if (msg.includes('confirm_outside_area')) setOutsideConfirm(true);
    }
    setPreviewing(false);
  }

  async function handleSave(): Promise<boolean> {
    setSaving(true); setPreviewError('');
    let ok = false;
    try {
      const body = mode === 'assign' ? buildAssignBody() : mode === 'place' ? buildPlaceBody() : buildGcpBody();
      await api.saveGeoref(dataset.id, body);
      await qc.invalidateQueries({ queryKey: ['georef', dataset.id] });
      await qc.invalidateQueries({ queryKey: ['dataset', dataset.id] });
      showToast('Georeferencing saved', 'success');
      setPreview(null); onSaved();
      ok = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setPreviewError(msg);
      showError(msg);
      if (msg.includes('confirm_outside_area')) setOutsideConfirm(true);
    }
    setSaving(false);
    return ok;
  }

  async function handleRevert() {
    setReverting(true);
    try {
      await api.deleteGeoref(dataset.id);
      await qc.invalidateQueries({ queryKey: ['georef', dataset.id] });
      await qc.invalidateQueries({ queryKey: ['dataset', dataset.id] });
      showToast('Reverted to as-uploaded', 'success');
      setPreview(null); onSaved();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Revert failed');
    }
    setReverting(false);
  }

  async function restoreHistory(hid: string) {
    try {
      await api.restoreGeoref(dataset.id, hid);
      await qc.invalidateQueries({ queryKey: ['georef', dataset.id] });
      await qc.invalidateQueries({ queryKey: ['dataset', dataset.id] });
      showToast('Georef restored', 'success');
      onSaved();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Restore failed');
    }
  }

  async function convertXYToLonLat() {
    if (!anchorX || !anchorY) return;
    try {
      const r = await api.transformCoords(anchorCrs, 'EPSG:4326', [[parseFloat(anchorX), parseFloat(anchorY)]]);
      if (r.points[0]) {
        setAnchorLon(r.points[0][0]);
        setAnchorLat(r.points[0][1]);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Coordinate transform failed');
    }
  }

  async function lookupUtm() {
    const lon = anchorLon ?? 77.59;
    const lat = anchorLat ?? 12.97;
    try {
      const d = await api.getUtmCrs(lon, lat);
      const code = `EPSG:${d.epsg ?? ''}`;
      setSelectedCrs(code);
      setCrsDesc(`UTM zone · ${d.label}`);
    } catch { /* ignore */ }
  }

  const suggested = dataset.kind === 'vector' ? (dataset.meta as VectorMeta).suggested_crs : null;

  function onPlacePreviewResult(result: GeorefFull | null, err: string) {
    if (result) setPreview(result);
    setPreviewError(err);
    if (err.includes('confirm_outside_area')) setOutsideConfirm(true);
  }

  return (
    <div className={`panel${embedded ? ' embedded' : ''}`}>
      {!embedded && (
        <div className="panel-header" onClick={() => setOpen(!open)}>
          Georeference
          <span className="panel-chevron">{open ? '▲' : '▼'}</span>
        </div>
      )}
      {open && (
        <div className="panel-body">
          <div className="form-group">
            <label className="form-label">Mode</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`btn btn-sm ${mode === 'assign' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('assign')}>Assign CRS</button>
              <button className={`btn btn-sm ${mode === 'place' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('place')}>Place on map</button>
              {isRaster && (
                <button className={`btn btn-sm ${mode === 'gcp' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('gcp')}>Control points</button>
              )}
            </div>
          </div>

          {mode === 'assign' && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="crs-search">Search CRS</label>
                <input id="crs-search" type="search" value={crsSearch} onChange={(e) => setCrsSearch(e.target.value)} placeholder="e.g. WGS 84, UTM 43N…" />
                {crsResults.length > 0 && (
                  <div className="crs-list">
                    {crsResults.map((c) => (
                      <div
                        key={c.code}
                        className={`crs-list-item${selectedCrs === `EPSG:${c.code}` ? ' selected' : ''}`}
                        onClick={() => selectCrsFromList(c)}
                        role="option" aria-selected={selectedCrs === `EPSG:${c.code}`}
                        tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') selectCrsFromList(c); }}
                      >
                        <div className="crs-list-item-code">EPSG:{c.code}</div>
                        <div className="crs-list-item-name">{c.name}</div>
                        <div className="crs-list-item-type">{c.type} · {c.area}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                {suggested && (
                  <span className="chip" onClick={() => { setSelectedCrs(suggested); setCrsDesc('Suggested from data'); }}>
                    Use {suggested}
                  </span>
                )}
                <span className="chip" onClick={lookupUtm}>UTM at anchor</span>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="wkt-input">Paste WKT or EPSG:xxxx</label>
                <input
                  id="wkt-input" type="text" value={wktInput}
                  onChange={(e) => setWktInput(e.target.value)}
                  onBlur={() => validateWkt(wktInput)}
                  placeholder="EPSG:4326 or WKT string"
                  style={wktValid === false ? { borderColor: 'var(--red)' } : wktValid === true ? { borderColor: 'var(--green)' } : undefined}
                />
                {wktError && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>{wktError}</div>}
              </div>

              {selectedCrs && (
                <div className="crs-result">
                  <div className="crs-result-name">{selectedCrs}</div>
                  {crsDesc && <div className="crs-result-detail">{crsDesc}</div>}
                </div>
              )}

              {isRaster && !hasAffine && (
                <div style={{ border: '1px solid var(--border-2)', borderRadius: 4, padding: 10, marginBottom: 10 }}>
                  <div className="form-label" style={{ marginBottom: 8 }}>Ground transform</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div><label className="form-label" htmlFor="g-ox">Top-left X</label><input id="g-ox" type="number" value={gridOriginX} onChange={(e) => setGridOriginX(e.target.value)} /></div>
                    <div><label className="form-label" htmlFor="g-oy">Top-left Y</label><input id="g-oy" type="number" value={gridOriginY} onChange={(e) => setGridOriginY(e.target.value)} /></div>
                    <div><label className="form-label" htmlFor="g-px">Pixel size</label><input id="g-px" type="number" value={gridPixelX} onChange={(e) => setGridPixelX(e.target.value)} /></div>
                  </div>
                </div>
              )}
            </>
          )}

          {mode === 'place' && (
            <>
              <PlaceMapEmbed
                dataset={dataset}
                georef={georef}
                anchorLon={anchorLon}
                anchorLat={anchorLat}
                rotation={rotation}
                placeCrs={placeCrs}
                scale={scale}
                zOffset={zOffset}
                pixelSize={pixelSize}
                onAnchorChange={(lon, lat) => { setAnchorLon(lon); setAnchorLat(lat); }}
                onRotationChange={setRotation}
                onPreviewResult={onPlacePreviewResult}
                confirmOutside={confirmOutside}
              />

              <div className="form-group">
                <label className="form-label">Anchor (footprint centre)</label>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <button className={`btn btn-xs ${anchorMode === 'lonlat' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAnchorMode('lonlat')}>Lon/Lat</button>
                  <button className={`btn btn-xs ${anchorMode === 'xy' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAnchorMode('xy')}>X/Y + CRS</button>
                </div>
                {anchorMode === 'lonlat' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label className="form-label" htmlFor="a-lon">Longitude</label>
                      <input id="a-lon" type="number" step="any" value={anchorLon ?? ''} onChange={(e) => setAnchorLon(e.target.value ? parseFloat(e.target.value) : null)} />
                    </div>
                    <div>
                      <label className="form-label" htmlFor="a-lat">Latitude</label>
                      <input id="a-lat" type="number" step="any" value={anchorLat ?? ''} onChange={(e) => setAnchorLat(e.target.value ? parseFloat(e.target.value) : null)} />
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div><label className="form-label" htmlFor="a-x">X</label><input id="a-x" type="number" step="any" value={anchorX} onChange={(e) => setAnchorX(e.target.value)} /></div>
                      <div><label className="form-label" htmlFor="a-y">Y</label><input id="a-y" type="number" step="any" value={anchorY} onChange={(e) => setAnchorY(e.target.value)} /></div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, marginTop: 6 }}>
                      <input id="a-crs" type="text" value={anchorCrs} onChange={(e) => setAnchorCrs(e.target.value)} placeholder="EPSG:32643" aria-label="Anchor CRS" />
                      <button className="btn btn-secondary btn-sm" onClick={convertXYToLonLat}>Convert</button>
                    </div>
                  </>
                )}
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="p-rot">Rotation (deg CCW)</label>
                <div className="nudge-row">
                  <input id="p-rot" className="nudge-input" type="number" step="1" value={rotation} onChange={(e) => setRotation(parseFloat(e.target.value) || 0)} />
                  <input type="range" min={-180} max={180} step={1} value={rotation} onChange={(e) => setRotation(+e.target.value)} style={{ flex: 1 }} aria-label="Rotation slider" />
                  <button className="btn btn-secondary btn-xs" onClick={() => setRotation((r) => r - 1)}>-1</button>
                  <button className="btn btn-secondary btn-xs" onClick={() => setRotation((r) => r + 1)}>+1</button>
                  <button className="btn btn-secondary btn-xs" onClick={() => setRotation((r) => r - 15)}>-15</button>
                  <button className="btn btn-secondary btn-xs" onClick={() => setRotation((r) => r + 15)}>+15</button>
                </div>
              </div>

              {dataset.kind === 'pointcloud' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="z-off">Z offset</label>
                  <input id="z-off" type="number" step="any" value={zOffset} onChange={(e) => setZOffset(parseFloat(e.target.value) || 0)} />
                </div>
              )}

              {georef.local && (
                <div className="form-group">
                  <label className="form-label" htmlFor="sc">Scale</label>
                  <input id="sc" type="number" step="any" min="0.0001" value={scale} onChange={(e) => setScale(parseFloat(e.target.value) || 1)} />
                </div>
              )}

              {isRaster && !hasAffine && (
                <div className="form-group">
                  <label className="form-label" htmlFor="px-sz">Pixel size (ground units/pixel)</label>
                  <input id="px-sz" type="number" step="any" value={pixelSize} onChange={(e) => setPixelSize(e.target.value)} />
                </div>
              )}

              {(dataset.kind === 'vector' || dataset.kind === 'pointcloud') && (
                <div className="form-group">
                  <label className="form-label" htmlFor="wk-crs">Working CRS (optional)</label>
                  <input id="wk-crs" type="text" value={placeCrs} onChange={(e) => setPlaceCrs(e.target.value)} placeholder="EPSG:32643" />
                </div>
              )}

              {preview?.effective && (
                <div className="crs-result">
                  <div className="crs-result-name">Preview: {preview.effective.crs.label}</div>
                  <div className="crs-result-detail">
                    Rotation: {preview.effective.rotation_deg?.toFixed(2)} deg · Bounds: {preview.effective.bounds_wgs84.map((v) => v.toFixed(4)).join(', ')}
                  </div>
                  {preview.override?.verification && (
                    <div style={{ marginTop: 4, fontSize: 11 }}>
                      Round-trip: {(preview.override.verification.max_roundtrip_error_m * 1000).toFixed(2)} mm{' '}
                      <span className={preview.override.verification.passed ? 'badge badge-ready' : 'badge badge-error'}>
                        {preview.override.verification.passed ? 'PASS' : 'FAIL'}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {mode === 'gcp' && isRaster && (
            <GcpEditor dataset={dataset} points={gcpPoints} setPoints={setGcpPoints} crs={gcpCrs} setCrs={setGcpCrs} onSave={handleSave} />
          )}

          {outsideConfirm && (
            <div className="alert alert-warn" style={{ marginBottom: 10 }}>
              The selected CRS may not cover this area.
              <div style={{ marginTop: 6 }}>
                <label style={{ display: 'flex', gap: 6, cursor: 'pointer', alignItems: 'center' }}>
                  <input type="checkbox" checked={confirmOutside} onChange={(e) => setConfirmOutside(e.target.checked)} />
                  I understand, use this CRS anyway
                </label>
              </div>
            </div>
          )}

          {previewError && !outsideConfirm && (
            <div className="alert alert-error" style={{ marginBottom: 10 }}>{previewError}</div>
          )}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {mode === 'assign' && (
              <button className="btn btn-secondary btn-sm" onClick={handlePreview} disabled={previewing}>
                {previewing ? 'Previewing...' : 'Preview'}
              </button>
            )}
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || (mode === 'gcp' && gcpPoints.filter(isComplete).length < 3)}
            >
              {saving ? 'Saving...' : 'Save georeferencing'}
            </button>
          </div>

          <div className="divider" />
          <RevertSection
            georef={georef}
            onRevert={handleRevert}
            reverting={reverting}
            showHistory={showHistory}
            setShowHistory={setShowHistory}
            onRestore={restoreHistory}
          />
        </div>
      )}
    </div>
  );
}

function RevertSection({ georef, onRevert, reverting, showHistory, setShowHistory, onRestore }: {
  georef: GeorefFull; onRevert: () => void; reverting: boolean;
  showHistory: boolean; setShowHistory: (v: boolean) => void; onRestore: (hid: string) => void;
}) {
  const [confirmRevert, setConfirmRevert] = useState(false);
  return (
    <div>
      {!confirmRevert ? (
        <button className="btn btn-secondary btn-sm" onClick={() => setConfirmRevert(true)} disabled={reverting}>
          Revert to as-uploaded
        </button>
      ) : (
        <div className="inline-confirm">
          <span style={{ fontSize: 12, color: 'var(--tx-2)' }}>Are you sure?</span>
          <button className="btn btn-danger btn-xs" onClick={() => { onRevert(); setConfirmRevert(false); }} disabled={reverting}>
            {reverting ? 'Reverting...' : 'Yes, revert'}
          </button>
          <button className="btn btn-secondary btn-xs" onClick={() => setConfirmRevert(false)}>Cancel</button>
        </div>
      )}
      {georef.history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost btn-xs" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Hide' : 'Show'} history ({georef.history.length})
          </button>
          {showHistory && georef.history.map((h) => (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 }}>
              <span style={{ flex: 1, color: 'var(--tx-2)' }}>
                {h.note ?? (h.as_uploaded ? 'As uploaded' : 'Saved')}
                {' '}<span className="muted">{new Date(h.created * 1000).toLocaleString()}</span>
              </span>
              <button className="btn btn-secondary btn-xs" onClick={() => onRestore(h.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
