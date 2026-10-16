import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download, ExternalLink, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { api, fmtBytes, fmtDate, downloadUrl, type Dataset, type RasterMeta, type VectorMeta, type PointCloudMeta } from '../api';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Modal';
import { useNavigate } from '../router';
import { copyText } from '../maps/MapTools';

interface InfoPanelProps {
  dataset: Dataset;
  onDeleted: () => void;
  onCategoryChange: () => void;
  /** rendered inside the viewer's tab bar: no collapsible header of its own */
  embedded?: boolean;
}

const CATEGORIES = ['orthomosaic', 'dem', 'dsm', 'dtm', 'raster', 'vector', 'pointcloud', 'other'] as const;

export function InfoPanel({ dataset, onDeleted, onCategoryChange, embedded = false }: InfoPanelProps) {
  const [open, setOpen] = useState(true);
  const [checkingIntegrity, setCheckingIntegrity] = useState(false);
  const [integrity, setIntegrity] = useState<{ sha256_at_upload: string; sha256_now: string; unchanged: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editCategory, setEditCategory] = useState(false);
  const [newCategory, setNewCategory] = useState(dataset.category);
  const [editName, setEditName] = useState(false);
  const [name, setName] = useState(dataset.filename);
  const [editNotes, setEditNotes] = useState(false);
  const [notes, setNotes] = useState(dataset.notes ?? '');
  const { showError, showToast } = useToast();
  const navigate = useNavigate();

  const { data: georef } = useQuery({
    queryKey: ['georef', dataset.id],
    queryFn: () => api.getGeoref(dataset.id),
  });

  async function verifyIntegrity() {
    setCheckingIntegrity(true);
    setIntegrity(null);
    try {
      setIntegrity(await api.integrityCheck(dataset.id));
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Integrity check failed');
    }
    setCheckingIntegrity(false);
  }

  async function doDelete() {
    try {
      await api.deleteDataset(dataset.id);
      showToast('Dataset deleted', 'success');
      navigate(`/project/${dataset.project_id}`);
      onDeleted();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Delete failed');
    }
    setConfirmDelete(false);
  }

  async function save(patch: { category?: Dataset['category']; filename?: string; notes?: string }, done: () => void, msg: string) {
    try {
      await api.updateDataset(dataset.id, patch);
      onCategoryChange();
      showToast(msg, 'success');
      done();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function copy(text: string, what: string) {
    const ok = await copyText(text);
    showToast(ok ? `${what} copied` : 'Copy is blocked by the browser', ok ? 'success' : 'error');
  }

  const m = dataset.meta;

  function details(): [string, string][] {
    const rows: [string, string][] = [
      ['Type', dataset.kind === 'pointcloud' ? 'Point cloud' : dataset.kind === 'raster' ? 'Raster' : 'Vector'],
      ['Format', m.format],
      ['File size', fmtBytes(dataset.size)],
      ['Uploaded', fmtDate(dataset.created)],
    ];
    if (dataset.kind === 'raster') {
      const rm = m as RasterMeta;
      rows.push(
        ['Dimensions', `${rm.width.toLocaleString()} × ${rm.height.toLocaleString()} px`],
        ['Bands', `${rm.bands} (${rm.dtype})`],
        ['Pixel size', rm.resolution ? `${rm.resolution[0].toPrecision(5)} × ${rm.resolution[1].toPrecision(5)}` : '—'],
        ['NoData', String(rm.nodata ?? '—')],
        ['Overviews', String(rm.overviews)],
        ['Compression', rm.compression ?? 'None'],
      );
    } else if (dataset.kind === 'vector') {
      const vm = m as VectorMeta;
      rows.push(
        ['Geometry', vm.geometry_type],
        ['Features', vm.features.toLocaleString()],
        ['Attributes', String(vm.fields.length)],
        ['Layer', vm.layer],
      );
    } else {
      const pm = m as PointCloudMeta;
      rows.push(
        ['Points', pm.points.toLocaleString()],
        ['Colour', pm.has_rgb ? 'RGB' : 'Coloured by height'],
        ['Min X, Y, Z', pm.mins.map((v) => v.toFixed(2)).join(', ')],
        ['Max X, Y, Z', pm.maxs.map((v) => v.toFixed(2)).join(', ')],
      );
    }
    if (georef?.effective) {
      rows.push(['CRS', `${georef.effective.crs.label} (${georef.effective.crs.name})`], ['Units', georef.effective.crs.units]);
    }
    rows.push(['SHA-256', `${dataset.sha256.slice(0, 16)}…`]);
    return rows;
  }

  const warnings = m.warnings ?? [];
  const centre = georef?.effective?.center_wgs84;
  const bounds = georef?.effective?.bounds_wgs84;

  const body = (
    <div className="panel-body">
      <div className="info-section">
        <div className="info-section-title">Name</div>
        {editName ? (
          <form className="title-edit" onSubmit={(e) => { e.preventDefault(); save({ filename: name }, () => setEditName(false), 'Renamed'); }}>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Dataset name" />
            <button className="btn btn-primary btn-sm" type="submit">Save</button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setEditName(false); setName(dataset.filename); }}>Cancel</button>
          </form>
        ) : (
          <div className="title-edit">
            <strong style={{ wordBreak: 'break-word' }}>{dataset.filename}</strong>
            <button className="btn-icon" onClick={() => { setName(dataset.filename); setEditName(true); }} aria-label="Rename dataset" title="Rename">
              <Pencil size={14} />
            </button>
          </div>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="alert alert-warn" style={{ display: 'block' }}>
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      {centre && bounds && (
        <div className="info-section">
          <div className="info-section-title">Location</div>
          <div className="loc-row">
            <span className="loc-coords">{centre[1].toFixed(6)}, {centre[0].toFixed(6)}</span>
            <button className="btn btn-secondary btn-xs" onClick={() => copy(`${centre[1].toFixed(6)}, ${centre[0].toFixed(6)}`, 'Coordinates')}>
              <Copy size={12} aria-hidden="true" /> Copy
            </button>
            <a className="btn btn-secondary btn-xs" href={`https://www.google.com/maps/search/?api=1&query=${centre[1].toFixed(7)},${centre[0].toFixed(7)}`}
              target="_blank" rel="noreferrer">
              <ExternalLink size={12} aria-hidden="true" /> Google Maps
            </a>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            Centre (lat, lon, WGS84) ·{' '}
            <button className="btn btn-ghost btn-xs" style={{ padding: '0 2px' }}
              onClick={() => copy(bounds.map((v) => v.toFixed(7)).join(','), 'Bounds')}>copy bounds W,S,E,N</button>
          </div>
        </div>
      )}

      <div className="info-section">
        <div className="info-section-title">Notes</div>
        {editNotes ? (
          <>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} autoFocus aria-label="Dataset notes"
              placeholder="Survey date, sensor, flight height, operator, remarks…" />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn btn-primary btn-sm" onClick={() => save({ notes }, () => setEditNotes(false), 'Notes saved')}>Save notes</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setEditNotes(false); setNotes(dataset.notes ?? ''); }}>Cancel</button>
            </div>
          </>
        ) : dataset.notes ? (
          <div>
            <div className="notes-text">{dataset.notes}</div>
            <button className="btn btn-ghost btn-xs" style={{ marginTop: 4 }} onClick={() => setEditNotes(true)}><Pencil size={12} /> Edit notes</button>
          </div>
        ) : (
          <button className="btn btn-secondary btn-xs" onClick={() => setEditNotes(true)}><Pencil size={12} /> Add notes</button>
        )}
      </div>

      <div className="info-section">
        <div className="info-section-title">Category</div>
        {editCategory ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={newCategory} onChange={(e) => setNewCategory(e.target.value as Dataset['category'])} style={{ flex: 1 }} aria-label="Select category">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" onClick={() => save({ category: newCategory }, () => setEditCategory(false), 'Category updated')}>Save</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditCategory(false)}>Cancel</button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ textTransform: 'capitalize' }}>{dataset.category}</span>
            <button className="btn btn-ghost btn-xs" onClick={() => { setEditCategory(true); setNewCategory(dataset.category); }}>Edit</button>
          </div>
        )}
      </div>

      <div className="info-section">
        <div className="info-section-title">Details</div>
        <div className="info-list">
          {details().map(([k, v]) => (
            <Fragment key={k}><div className="info-key">{k}</div><div className="info-val">{v}</div></Fragment>
          ))}
        </div>
        {georef?.warnings && georef.warnings.length > 0 && (
          <div className="alert alert-warn" style={{ marginTop: 10, display: 'block' }}>
            {georef.warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        )}
      </div>

      <div className="divider" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <a href={downloadUrl(dataset.id)} className="btn btn-secondary btn-sm" download style={{ justifyContent: 'center' }}>
          <Download size={14} aria-hidden="true" /> Download original file
        </a>
        <button className="btn btn-secondary btn-sm" onClick={verifyIntegrity} disabled={checkingIntegrity} style={{ justifyContent: 'center' }}>
          <ShieldCheck size={14} aria-hidden="true" /> {checkingIntegrity ? 'Checking…' : 'Verify file integrity'}
        </button>
        {integrity && (
          <div className={`alert ${integrity.unchanged ? 'alert-success' : 'alert-error'}`} style={{ fontSize: 12 }}>
            {integrity.unchanged ? <><Check size={14} /> File unchanged since upload</> : '✗ File has been modified since upload'}
          </div>
        )}
        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)', justifyContent: 'center' }} onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} aria-hidden="true" /> Delete dataset
        </button>
      </div>
    </div>
  );

  return (
    <>
      {confirmDelete && (
        <ConfirmDialog
          message="Delete this dataset and its files permanently?"
          onConfirm={doDelete}
          onCancel={() => setConfirmDelete(false)}
          confirmLabel="Delete dataset"
          danger
        />
      )}
      <div className={`panel${embedded ? ' embedded' : ''}`}>
        {!embedded && (
          <div className="panel-header" onClick={() => setOpen(!open)}>
            Info
            <span className="panel-chevron">{open ? '▲' : '▼'}</span>
          </div>
        )}
        {(embedded || open) && body}
      </div>
    </>
  );
}
