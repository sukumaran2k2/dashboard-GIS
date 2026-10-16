import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, fmtBytes, fmtDate } from '../api';
import { useParams, useNavigate } from '../router';
import { useToast } from '../components/Toast';
import { UploadZone } from '../components/UploadZone';
import { StatusBadge, KindBadge, CategoryLabel } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/Modal';
import { ProjectAvatar } from '../components/ProjectThumb';

export function ProjectDetail() {
  const { id: pid } = useParams();
  const navigate = useNavigate();
  const { showError, showToast } = useToast();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeleteDs, setConfirmDeleteDs] = useState<string | null>(null);

  const { data: project, isLoading: loadingP } = useQuery({
    queryKey: ['project', pid],
    queryFn: () => api.listProjects().then((ps) => ps.find((p) => p.id === pid) ?? null),
    enabled: !!pid,
  });

  const { data: datasets, isLoading: loadingDs, refetch: refetchDs } = useQuery({
    queryKey: ['datasets', { project: pid }],
    queryFn: () => api.listDatasets({ project: pid }),
    enabled: !!pid,
  });

  const { data: formats } = useQuery({
    queryKey: ['formats'],
    queryFn: api.formats,
  });

  if (loadingP) return <div className="loading-center" style={{ height: 200 }}><div className="spinner" /></div>;
  if (!project) return <div className="page"><p>Project not found.</p></div>;

  const acceptedFormats = formats
    ? [...formats.raster, ...formats.vector, ...formats.pointcloud, ...formats.archive]
    : [];

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !pid) return;
    try {
      await api.updateProject(pid, { name: newName.trim() });
      await qc.invalidateQueries({ queryKey: ['project', pid] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      setRenaming(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  async function doDeleteProject() {
    if (!pid) return;
    try {
      await api.deleteProject(pid);
      await qc.invalidateQueries({ queryKey: ['projects'] });
      navigate('/projects');
      showToast('Project deleted', 'success');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function deleteDataset(did: string) {
    try {
      await api.deleteDataset(did);
      await refetchDs();
      await qc.invalidateQueries({ queryKey: ['storage'] });
      showToast('Dataset deleted', 'success');
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Delete failed');
    }
    setConfirmDeleteDs(null);
  }

  return (
    <div className="page">
      {confirmDelete && (
        <ConfirmDialog
          message={`Delete project "${project.name}" and ALL its datasets permanently?`}
          onConfirm={doDeleteProject}
          onCancel={() => setConfirmDelete(false)}
          confirmLabel="Delete project"
          danger
        />
      )}
      {confirmDeleteDs && (
        <ConfirmDialog
          message="Delete this dataset permanently?"
          onConfirm={() => deleteDataset(confirmDeleteDs)}
          onCancel={() => setConfirmDeleteDs(null)}
          confirmLabel="Delete dataset"
          danger
        />
      )}

      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <a href="#/projects" onClick={(e) => { e.preventDefault(); navigate('/projects'); }}>Projects</a>
        <span className="sep">/</span>
        <span>{project.name}</span>
      </nav>
      <div className="page-header">
        {renaming ? (
          <form onSubmit={rename} style={{ display: 'flex', gap: 8, flex: 1 }}>
            <input
              type="text"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn btn-primary btn-sm">Save</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenaming(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <ProjectAvatar datasets={datasets ?? []} size={56} />
            <div className="page-title">
              <h2>{project.name}</h2>
              <p className="page-subtitle">
                {datasets?.length ?? 0} dataset{(datasets?.length ?? 0) === 1 ? '' : 's'} · {fmtBytes(project.size)} · created {fmtDate(project.created)}
              </p>
            </div>
          </>
        )}
        {!renaming && (
          <>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { setNewName(project.name); setRenaming(true); }}
            >
              Rename
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => navigate(`/project/${pid}/map`)}
              disabled={!datasets?.some((d) => d.effective_status === 'ready')}
            >
              Open map
            </button>
            <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
              Delete project
            </button>
          </>
        )}
      </div>

      <UploadZone
        projectId={pid!}
        acceptedFormats={acceptedFormats}
        onDone={() => {
          refetchDs();
          qc.invalidateQueries({ queryKey: ['storage'] });
        }}
      />

      <h3 style={{ marginBottom: 12 }}>Datasets</h3>

      {loadingDs ? (
        <div className="loading-center" style={{ height: 100 }}><div className="spinner" /></div>
      ) : !datasets || datasets.length === 0 ? (
        <p className="muted">No datasets yet. Upload files above.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Kind</th>
                <th>Category</th>
                <th>Status</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id}>
                  <td>
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ fontWeight: 600, padding: '2px 4px' }}
                      onClick={() => navigate(`/dataset/${d.id}`)}
                    >
                      {d.filename}
                    </button>
                  </td>
                  <td><KindBadge kind={d.kind} /></td>
                  <td><CategoryLabel category={d.category} /></td>
                  <td><StatusBadge status={d.status} effective={d.effective_status} /></td>
                  <td>{fmtBytes(d.size)}</td>
                  <td>{fmtDate(d.created)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn-secondary btn-xs"
                      onClick={() => navigate(`/dataset/${d.id}`)}
                    >
                      View
                    </button>
                    {' '}
                    {d.effective_status === 'unreferenced' && (
                      <>
                        <button
                          className="btn btn-xs"
                          style={{ background: 'var(--amber)', color: '#fff' }}
                          onClick={() => navigate(`/dataset/${d.id}`)}
                        >
                          Georeference
                        </button>
                        {' '}
                      </>
                    )}
                    <a
                      className="btn btn-secondary btn-xs"
                      href={`/api/datasets/${d.id}/download`}
                      download
                    >
                      Download
                    </a>
                    {' '}
                    <button
                      className="btn btn-danger btn-xs"
                      onClick={() => setConfirmDeleteDs(d.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
