import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Search } from 'lucide-react';
import { api, fmtBytes, fmtDate, type DatasetKind, type DatasetCategory } from '../api';
import { useNavigate } from '../router';
import { StatusBadge, KindBadge } from '../components/StatusBadge';

export function Library() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');

  const { data: datasets, isLoading } = useQuery({
    queryKey: ['datasets', { q, kind, category, status }],
    queryFn: () => api.listDatasets({
      q: q || undefined,
      kind: kind as DatasetKind | undefined || undefined,
      category: category as DatasetCategory | undefined || undefined,
      status: status || undefined,
    }),
  });

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title">
          <h2>Dataset library</h2>
          <p className="page-subtitle">Every dataset across all projects. Filter by type, category or status.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="search-box" style={{ flex: '1 1 220px', maxWidth: 'none' }}>
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search datasets…"
            aria-label="Search datasets"
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 140 }} aria-label="Filter by kind">
          <option value="">All kinds</option>
          <option value="raster">Raster</option>
          <option value="vector">Vector</option>
          <option value="pointcloud">Point cloud</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 160 }} aria-label="Filter by category">
          <option value="">All categories</option>
          <option value="orthomosaic">Orthomosaic</option>
          <option value="dem">DEM</option>
          <option value="dsm">DSM</option>
          <option value="dtm">DTM</option>
          <option value="raster">Raster</option>
          <option value="vector">Vector</option>
          <option value="pointcloud">Point cloud</option>
          <option value="other">Other</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 160 }} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="unreferenced">Needs georeferencing</option>
        </select>
      </div>

      {isLoading ? (
        <div className="loading-center" style={{ height: 120 }}><div className="spinner" /></div>
      ) : !datasets || datasets.length === 0 ? (
        <p className="muted">No datasets found.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Filename</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Project</th>
                <th>Size</th>
                <th>CRS</th>
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
                  <td><StatusBadge status={d.status} effective={d.effective_status} /></td>
                  <td>
                    {d.project_name && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => navigate(`/project/${d.project_id}`)}
                      >
                        {d.project_name}
                      </button>
                    )}
                  </td>
                  <td>{fmtBytes(d.size)}</td>
                  <td style={{ fontSize: 12 }}>{d.georef.crs ?? '—'}</td>
                  <td>{fmtDate(d.created)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button
                      className="btn btn-secondary btn-xs"
                      onClick={() => navigate(`/dataset/${d.id}`)}
                    >
                      View
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
