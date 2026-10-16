import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, Eye, FolderKanban, FolderOpen, HardDrive, Layers, Map as MapIcon,
  MapPinOff, Pencil, Plus, Search, Trash2, Upload,
} from 'lucide-react';
import { api, downloadUrl, exportDownloadUrl, fmtBytes, fmtDate, imageUrl, type Dataset, type Job, type Project } from '../api';
import { useNavigate } from '../router';
import { useToast } from '../components/Toast';
import { CategoryLabel, KindBadge, StatusBadge } from '../components/StatusBadge';
import { Menu } from '../components/Menu';
import { useAppActions } from '../components/AppActions';
import { ProjectAvatar } from '../components/ProjectThumb';

type Sort = 'newest' | 'oldest' | 'name' | 'size';

/** how many project panels start expanded */
const OPEN_BY_DEFAULT = 3;

export function Dashboard() {
  const navigate = useNavigate();
  const { showError, showToast } = useToast();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [onlyPending, setOnlyPending] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const { data: projects, isLoading } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const { data: datasets } = useQuery({ queryKey: ['datasets'], queryFn: () => api.listDatasets() });
  const { data: storage } = useQuery({ queryKey: ['storage'], queryFn: api.storage });

  const byProject = useMemo(() => {
    const m = new Map<string, Dataset[]>();
    (datasets ?? []).forEach((d) => m.set(d.project_id, [...(m.get(d.project_id) ?? []), d]));
    return m;
  }, [datasets]);

  const pending = useMemo(() => (datasets ?? []).filter((d) => d.effective_status === 'unreferenced'), [datasets]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (projects ?? []).filter((p) => {
      const ds = byProject.get(p.id) ?? [];
      if (onlyPending && !ds.some((d) => d.effective_status === 'unreferenced')) return false;
      return !q || p.name.toLowerCase().includes(q) || ds.some((d) => d.filename.toLowerCase().includes(q));
    });
    const cmp: Record<Sort, (a: Project, b: Project) => number> = {
      newest: (a, b) => b.created - a.created,
      oldest: (a, b) => a.created - b.created,
      name: (a, b) => a.name.localeCompare(b.name),
      size: (a, b) => b.size - a.size,
    };
    return [...list].sort(cmp[sort]);
  }, [projects, byProject, search, sort, onlyPending]);

  async function refresh() {
    await Promise.all(['projects', 'datasets', 'storage'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const p = await api.createProject(newName.trim());
      await refresh();
      setCreating(false);
      setNewName('');
      navigate(`/project/${p.id}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create project');
    }
  }

  const usedPct = storage ? Math.min(100, Math.max(1, (storage.used / storage.disk_total) * 100)) : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">
          <h2>Dashboard</h2>
          <p className="page-subtitle">Your geospatial projects and data at a glance.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> Add project</button>
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={createProject} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
              <label className="form-label" htmlFor="new-project-name">Project name</label>
              <input id="new-project-name" type="text" value={newName} autoFocus onChange={(e) => setNewName(e.target.value)} placeholder="For example: Chennai Port survey 2026" />
            </div>
            <button type="submit" className="btn btn-primary">Create project</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
          </form>
        </div>
      )}

      <div className="dash-stats" aria-label="Summary">
        <Kpi tone="blue" icon={<FolderKanban size={22} />} value={projects?.length} label="Projects"
          footer={projects && <span>{projects.filter((p) => p.datasets > 0).length} with data, {projects.filter((p) => p.datasets === 0).length} empty</span>} />
        <Kpi tone="indigo" icon={<Layers size={22} />} value={datasets?.length} label="Datasets"
          footer={datasets && <span>{datasets.length - pending.length} ready for the map</span>} />
        <Kpi tone={pending.length ? 'amber' : 'green'} icon={<MapPinOff size={22} />} value={datasets ? pending.length : undefined} label="Need georeferencing"
          footer={datasets && <span>{pending.length ? 'Assign a CRS or place them on the map' : 'Everything is located'}</span>} />
        <Kpi tone="slate" icon={<HardDrive size={22} />} value={storage ? fmtBytes(storage.used) : undefined} label="Data stored"
          footer={storage && (
            <>
              <div className="kpi-bar"><div className="kpi-bar-fill" style={{ width: `${usedPct}%` }} /></div>
              <span>{fmtBytes(storage.disk_free)} free of {fmtBytes(storage.disk_total)}</span>
            </>
          )} />
      </div>

      <div className="dash-grid">
        <section className="dash-main" aria-label="Projects">
          <div className="section-head">
            <h3>Projects</h3>
            <span className="count-pill">{shown.length}</span>
          </div>
          <div className="dash-toolbar">
            <div className="search-box">
              <Search size={16} aria-hidden="true" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects and datasets…" aria-label="Search projects and datasets" />
            </div>
            <label className="dash-filter">
              <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
              Needs georeferencing
            </label>
            <label className="dash-sort">
              Sort by
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort projects">
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="name">Name (A to Z)</option>
                <option value="size">Largest first</option>
              </select>
            </label>
          </div>

          {isLoading ? (
            <div aria-busy="true" aria-label="Loading projects">
              {[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 76, marginBottom: 14, borderRadius: 14 }} />)}
            </div>
          ) : shown.length === 0 ? (
            <div className="empty-state">
              <FolderOpen size={36} aria-hidden="true" />
              <strong>{(projects ?? []).length === 0 ? 'No projects yet' : 'No projects match'}</strong>
              <span>{(projects ?? []).length === 0
                ? 'Create a project, then upload rasters, vectors or point clouds.'
                : 'Try a different search or clear the filter.'}</span>
              {(projects ?? []).length === 0 && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> Add project</button>}
            </div>
          ) : (
            shown.map((p, i) => (
              <ProjectPanel
                key={p.id}
                project={p}
                datasets={byProject.get(p.id) ?? []}
                open={collapsed[p.id] === undefined ? i < OPEN_BY_DEFAULT : !collapsed[p.id]}
                onToggle={() => setCollapsed((c) => ({ ...c, [p.id]: !(c[p.id] === undefined ? i >= OPEN_BY_DEFAULT : c[p.id]) }))}
                onChanged={refresh}
                onNotice={showToast}
              />
            ))
          )}
        </section>

        <aside className="dash-aside" aria-label="Overview">
          <AttentionCard pending={pending} />
          <ExportsCard />
          <TypeCard datasets={datasets ?? []} />
          <RecentCard datasets={datasets ?? []} />
        </aside>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────── summary widgets
function Kpi({ icon, value, label, tone, footer }: {
  icon: React.ReactNode; value: string | number | undefined; label: string;
  tone: 'blue' | 'indigo' | 'amber' | 'green' | 'slate'; footer?: React.ReactNode;
}) {
  return (
    <div className="kpi">
      <div className={`kpi-icon tone-${tone}`} aria-hidden="true">{icon}</div>
      <div className="kpi-body">
        <div className="kpi-value">{value ?? '—'}</div>
        <div className="kpi-label">{label}</div>
        {footer && <div className="kpi-footer">{footer}</div>}
      </div>
    </div>
  );
}

function AttentionCard({ pending }: { pending: Dataset[] }) {
  const navigate = useNavigate();
  return (
    <div className="card aside-card">
      <h4 className="aside-title">Needs attention</h4>
      {pending.length === 0 ? (
        <div className="aside-ok"><CheckCircle2 size={18} aria-hidden="true" /> Every dataset has ground coordinates.</div>
      ) : (
        <>
          <p className="muted" style={{ margin: '0 0 8px' }}>
            {pending.length} dataset{pending.length === 1 ? '' : 's'} cannot be shown on a map until georeferenced.
          </p>
          {pending.slice(0, 5).map((d) => (
            <div className="aside-row" key={d.id}>
              <div className="aside-row-main">
                <button className="ds-name" onClick={() => navigate(`/dataset/${d.id}`)} title={d.filename}>{d.filename}</button>
                <div className="muted truncate">{d.project_name}</div>
              </div>
              <button className="btn btn-xs ds-geo" onClick={() => navigate(`/dataset/${d.id}`)}>Georeference</button>
            </div>
          ))}
          {pending.length > 5 && <div className="muted" style={{ marginTop: 6 }}>and {pending.length - 5} more</div>}
        </>
      )}
    </div>
  );
}

function jobLabel(j: Job): { text: string; cls: string } {
  if (j.state === 'failed') return { text: 'Failed', cls: 'fail' };
  if (j.state !== 'done' || !j.result) return { text: `${Math.round(j.progress * 100)}%`, cls: '' };
  const o = j.result.report.overall;
  return o === 'PASS' ? { text: 'Validated', cls: 'pass' } : o === 'WARN' ? { text: 'With warnings', cls: 'warn' } : { text: 'Failed validation', cls: 'fail' };
}

function ExportsCard() {
  const navigate = useNavigate();
  const { data: jobs } = useQuery({
    queryKey: ['jobs'],
    queryFn: api.listJobs,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.state === 'queued' || j.state === 'running') ? 2000 : 30_000),
  });
  const recent = (jobs ?? []).filter((j) => j.kind === 'export').slice(0, 5);
  return (
    <div className="card aside-card">
      <h4 className="aside-title">Recent exports</h4>
      {recent.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No exports yet. Open a dataset and use the Export tab to convert it.</p>
      ) : recent.map((j) => {
        const s = jobLabel(j);
        const fmt = String((j.params as { format?: string }).format ?? '').toUpperCase();
        return (
          <div className="aside-row" key={j.id}>
            <div className="aside-row-main">
              <button className="ds-name" onClick={() => navigate(`/dataset/${j.dataset_id}`)} title={j.dataset_filename ?? ''}>
                {j.result?.filename ?? `${j.dataset_filename ?? 'Dataset'} → ${fmt}`}
              </button>
              <div className="muted truncate">{fmt} · <span className={`job-state ${s.cls}`}>{s.text}</span></div>
            </div>
            {j.result?.downloadable && (
              <a className="btn btn-secondary btn-xs" href={exportDownloadUrl(j.id)} download aria-label={`Download ${j.result.filename}`}>
                <Download size={13} aria-hidden="true" />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TypeCard({ datasets }: { datasets: Dataset[] }) {
  const rows = [
    { key: 'raster', label: 'Raster and imagery', cls: 'bar-blue' },
    { key: 'vector', label: 'Vector', cls: 'bar-indigo' },
    { key: 'pointcloud', label: 'Point clouds', cls: 'bar-sky' },
  ].map((r) => ({ ...r, n: datasets.filter((d) => d.kind === r.key).length }));
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="card aside-card">
      <h4 className="aside-title">Data by type</h4>
      {datasets.length === 0 ? <p className="muted" style={{ margin: 0 }}>No data uploaded yet.</p> : rows.map((r) => (
        <div className="type-row" key={r.key}>
          <div className="type-row-top"><span>{r.label}</span><strong>{r.n}</strong></div>
          <div className="type-bar"><div className={`type-bar-fill ${r.cls}`} style={{ width: `${(r.n / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function RecentCard({ datasets }: { datasets: Dataset[] }) {
  const navigate = useNavigate();
  const recent = useMemo(() => [...datasets].sort((a, b) => b.created - a.created).slice(0, 5), [datasets]);
  return (
    <div className="card aside-card">
      <h4 className="aside-title">Recent uploads</h4>
      {recent.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing yet.</p> : recent.map((d) => (
        <div className="aside-row" key={d.id}>
          <DatasetThumb d={d} small />
          <div className="aside-row-main">
            <button className="ds-name" onClick={() => navigate(`/dataset/${d.id}`)} title={d.filename}>{d.filename}</button>
            <div className="muted truncate">{d.project_name} · {fmtDate(d.created)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────────────── projects
interface PanelProps {
  project: Project;
  datasets: Dataset[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onNotice: (m: string, t?: 'default' | 'error' | 'success') => void;
}

function ProjectPanel({ project, datasets, open, onToggle, onChanged, onNotice }: PanelProps) {
  const navigate = useNavigate();
  const { showError } = useToast();
  const { openUpload } = useAppActions();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = datasets.filter((d) => d.effective_status === 'unreferenced').length;
  const mappable = datasets.some((d) => d.effective_status === 'ready');

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.updateProject(project.id, { name: name.trim() });
      setRenaming(false);
      await onChanged();
    } catch (err) { showError(err instanceof Error ? err.message : 'Rename failed'); }
  }

  async function remove() {
    try {
      await api.deleteProject(project.id);
      onNotice('Project deleted', 'success');
      await onChanged();
    } catch (err) { showError(err instanceof Error ? err.message : 'Delete failed'); }
  }

  return (
    <section className="project-panel">
      <header className="project-panel-head">
        <button className="project-panel-toggle" onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <ProjectAvatar datasets={datasets} size={44} />
        {renaming ? (
          <form onSubmit={rename} style={{ display: 'flex', gap: 6, flex: 1 }}>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Project name" />
            <button className="btn btn-primary btn-sm" type="submit">Save</button>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => { setRenaming(false); setName(project.name); }}>Cancel</button>
          </form>
        ) : (
          <div className="project-panel-title" onClick={() => navigate(`/project/${project.id}`)} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/project/${project.id}`); }}>
            <span className="project-name">{project.name}</span>
            <span className="muted">
              {datasets.length} dataset{datasets.length === 1 ? '' : 's'} · {fmtBytes(project.size)} · created {fmtDate(project.created)}
            </span>
          </div>
        )}
        {pending > 0 && !renaming && <span className="badge badge-unreferenced">{pending} need georeferencing</span>}
        {!renaming && !confirmDelete && (
          <div className="project-panel-actions">
            <button className="btn btn-primary btn-sm" onClick={() => openUpload(project.id)}><Upload size={14} aria-hidden="true" /> Upload data</button>
            <button className="btn btn-secondary btn-sm" disabled={!mappable} title={mappable ? '' : 'No dataset has ground coordinates yet'}
              onClick={() => navigate(`/project/${project.id}/map`)}><MapIcon size={14} aria-hidden="true" /> Open map</button>
            <Menu label={`More actions for ${project.name}`} items={[
              { label: 'Open project', icon: <FolderOpen size={15} />, onSelect: () => navigate(`/project/${project.id}`) },
              { label: 'Rename', icon: <Pencil size={15} />, onSelect: () => setRenaming(true) },
              { label: 'Delete project', icon: <Trash2 size={15} />, danger: true, onSelect: () => setConfirmDelete(true) },
            ]} />
          </div>
        )}
        {confirmDelete && (
          <div className="inline-confirm">
            <span style={{ fontSize: 12 }}>Delete this project and all {datasets.length} dataset{datasets.length === 1 ? '' : 's'}?</span>
            <button className="btn btn-danger btn-xs" onClick={remove}>Yes, delete</button>
            <button className="btn btn-secondary btn-xs" onClick={() => setConfirmDelete(false)}>Cancel</button>
          </div>
        )}
      </header>

      {open && (
        <div className="project-panel-body">
          {datasets.length === 0 ? (
            <div className="muted" style={{ padding: '14px 4px' }}>
              No datasets yet. <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/project/${project.id}`)}>Upload data</button>
            </div>
          ) : datasets.map((d) => <DatasetRow key={d.id} d={d} />)}
        </div>
      )}
    </section>
  );
}

function DatasetThumb({ d, small = false }: { d: Dataset; small?: boolean }) {
  return (
    <div className={`ds-thumb${small ? ' small' : ''}`} aria-hidden="true">
      {d.kind === 'vector'
        ? <svg viewBox="0 0 48 36" width="100%" height="70%"><path d="M6 28 L16 8 L30 14 L42 6 L38 28 Z" fill="var(--accent-light)" stroke="var(--brand-blue)" strokeWidth="2" strokeLinejoin="round" /></svg>
        : <img src={imageUrl(d.id)} alt="" loading="lazy" />}
    </div>
  );
}

function DatasetRow({ d }: { d: Dataset }) {
  const navigate = useNavigate();
  const needs = d.effective_status === 'unreferenced';
  return (
    <div className="ds-row">
      <DatasetThumb d={d} />
      <div className="ds-main">
        <button className="ds-name" onClick={() => navigate(`/dataset/${d.id}`)} title={d.filename}>{d.filename}</button>
        {(d.meta.warnings?.length ?? 0) > 0 && (
          <span className="warn-icon" title={d.meta.warnings.join('\n')} aria-label={`${d.meta.warnings.length} warning(s)`}>
            <AlertTriangle size={14} />
          </span>
        )}
        <div className="muted ds-sub">
          <KindBadge kind={d.kind} />{d.category !== d.kind && <> <CategoryLabel category={d.category} /></>} · {fmtBytes(d.size)}
          {d.georef.crs ? ` · ${d.georef.crs}` : ''} · {fmtDate(d.created)}
        </div>
        {d.notes && <div className="ds-note" title={d.notes}>{d.notes}</div>}
      </div>
      <StatusBadge status={d.status} effective={d.effective_status} />
      <div className="ds-actions">
        <button className="btn btn-secondary btn-xs" onClick={() => navigate(`/dataset/${d.id}`)}><Eye size={13} aria-hidden="true" /> View</button>
        {needs && <button className="btn btn-xs ds-geo" onClick={() => navigate(`/dataset/${d.id}`)}>Georeference</button>}
        <a className="btn btn-secondary btn-xs" href={downloadUrl(d.id)} download><Download size={13} aria-hidden="true" /> Download</a>
      </div>
    </div>
  );
}
