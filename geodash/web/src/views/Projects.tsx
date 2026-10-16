import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FolderKanban, Plus, Search, Trash2 } from 'lucide-react';
import { api, fmtBytes, fmtDate, type Dataset, type Project } from '../api';
import { useNavigate } from '../router';
import { useToast } from '../components/Toast';
import { ConfirmDialog } from '../components/Modal';
import { ProjectAvatar, ProjectCover } from '../components/ProjectThumb';

export function Projects() {
  const navigate = useNavigate();
  const { showError, showToast } = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [toDelete, setToDelete] = useState<Project | null>(null);

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  });

  const { data: datasets } = useQuery({ queryKey: ['datasets'], queryFn: () => api.listDatasets() });
  const byProject = useMemo(() => {
    const m = new Map<string, Dataset[]>();
    (datasets ?? []).forEach((d) => m.set(d.project_id, [...(m.get(d.project_id) ?? []), d]));
    return m;
  }, [datasets]);

  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const p = await api.createProject(newName.trim());
      await qc.invalidateQueries({ queryKey: ['projects'] });
      setCreating(false);
      setNewName('');
      navigate(`/project/${p.id}`);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create project');
    }
  }

  async function deleteProject(p: Project) {
    setToDelete(null);
    try {
      await api.deleteProject(p.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      await qc.invalidateQueries({ queryKey: ['datasets'] });
      await qc.invalidateQueries({ queryKey: ['storage'] });
      showToast('Project deleted', 'success');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to delete project');
    }
  }

  return (
    <div className="page">
      {toDelete && (
        <ConfirmDialog
          message={`Delete project "${toDelete.name}" and all ${toDelete.datasets} of its datasets permanently?`}
          confirmLabel="Delete project"
          danger
          onConfirm={() => deleteProject(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      )}

      <div className="page-header">
        <div className="page-title">
          <h2>Projects</h2>
          <p className="page-subtitle">Every project groups the datasets of one survey or study.</p>
        </div>
        <div className="search-box" style={{ flex: 'none', width: 260 }}>
          <Search size={16} aria-hidden="true" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" aria-label="Search projects" />
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> New project</button>
      </div>

      {creating && (
        <div className="card" style={{ marginBottom: 20 }}>
          <form onSubmit={createProject} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
              <label className="form-label" htmlFor="proj-name">Project name</label>
              <input id="proj-name" type="text" value={newName} autoFocus onChange={(e) => setNewName(e.target.value)} placeholder="My project" />
            </div>
            <button type="submit" className="btn btn-primary">Create</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
          </form>
        </div>
      )}

      {isLoading ? (
        <div className="loading-center" style={{ height: 120 }}><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <FolderKanban size={36} aria-hidden="true" />
          <strong>{q ? 'No projects match your search' : 'No projects yet'}</strong>
          <span>{q ? 'Try a different name.' : 'Create a project to start uploading data.'}</span>
        </div>
      ) : (
        <div className="project-grid">
          {filtered.map((p) => (
            <div
              key={p.id}
              className="project-card"
              onClick={() => navigate(`/project/${p.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/project/${p.id}`); }}
            >
              <ProjectCover datasets={byProject.get(p.id) ?? []} />
              <div className="project-card-top">
                <ProjectAvatar datasets={byProject.get(p.id) ?? []} size={36} />
                <h3>{p.name}</h3>
                <button
                  className="btn btn-ghost btn-xs"
                  style={{ color: 'var(--red)' }}
                  onClick={(e) => { e.stopPropagation(); setToDelete(p); }}
                  aria-label={`Delete project ${p.name}`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
              <div className="project-card-stats">
                <div><strong>{p.datasets}</strong><span>dataset{p.datasets !== 1 ? 's' : ''}</span></div>
                <div><strong>{fmtBytes(p.size)}</strong><span>stored</span></div>
              </div>
              <div className="muted">Created {fmtDate(p.created)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
