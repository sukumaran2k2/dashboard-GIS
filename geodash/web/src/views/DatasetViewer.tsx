import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Crosshair, FileDown, Info, MapPinOff } from 'lucide-react';
import { useParams, useNavigate } from '../router';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { RasterViewer } from '../viewers/RasterViewer';
import { VectorViewer } from '../viewers/VectorViewer';
import { PointCloudViewer } from '../viewers/PointCloudViewer';
import { InfoPanel } from '../panels/InfoPanel';
import { GeorefPanel } from '../panels/GeorefPanel';
import { ExportPanel } from '../panels/ExportPanel';

type Tab = 'details' | 'georef' | 'export';

export function DatasetViewer() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: dataset, isLoading, error } = useQuery({
    queryKey: ['dataset', id],
    queryFn: () => api.getDataset(id!),
    enabled: !!id,
    refetchInterval: false,
  });

  const { data: georef } = useQuery({
    queryKey: ['georef', id],
    queryFn: () => api.getGeoref(id!),
    enabled: !!id,
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['dataset', id] });
    qc.invalidateQueries({ queryKey: ['georef', id] });
    qc.invalidateQueries({ queryKey: ['datasets'] });
    qc.invalidateQueries({ queryKey: ['storage'] });
  }

  if (isLoading) {
    return (
      <div className="loading-center" style={{ height: '100%' }}>
        <div className="spinner" />
        <span>Loading dataset…</span>
      </div>
    );
  }

  if (error || !dataset) {
    return (
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', alignItems: 'flex-start', justifyContent: 'center' }}>
        <p>Dataset not found or failed to load.</p>
        <button className="btn btn-secondary" onClick={() => navigate('/library')}>← Back to library</button>
      </div>
    );
  }

  return <ViewerShell key={dataset.id} dataset={dataset} georef={georef} onChanged={invalidateAll} />;
}

function ViewerShell({ dataset, georef, onChanged }: {
  dataset: NonNullable<Awaited<ReturnType<typeof api.getDataset>>>;
  georef: Awaited<ReturnType<typeof api.getGeoref>> | undefined;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const unreferenced = dataset.effective_status === 'unreferenced';
  const [tab, setTab] = useState<Tab>(unreferenced ? 'georef' : 'details');
  const georefVersion = dataset.georef.version;

  const tabs: Array<{ key: Tab; label: string; icon: React.ReactNode }> = [
    { key: 'details', label: 'Details', icon: <Info size={15} aria-hidden="true" /> },
    { key: 'georef', label: 'Georeference', icon: <Crosshair size={15} aria-hidden="true" /> },
    { key: 'export', label: 'Export', icon: <FileDown size={15} aria-hidden="true" /> },
  ];

  return (
    <div className="viewer-shell">
      <div className="viewer-main">
        <div className="viewer-header">
          <nav className="breadcrumbs" aria-label="Breadcrumb" style={{ margin: 0, flex: 1, minWidth: 0, flexWrap: 'nowrap' }}>
            <a href="#/projects" onClick={(e) => { e.preventDefault(); navigate('/projects'); }}>Projects</a>
            <ChevronRight size={14} className="sep" aria-hidden="true" />
            <a href={`#/project/${dataset.project_id}`} onClick={(e) => { e.preventDefault(); navigate(`/project/${dataset.project_id}`); }}
              className="truncate" style={{ maxWidth: 260 }}>{dataset.project_name ?? 'Project'}</a>
            <ChevronRight size={14} className="sep" aria-hidden="true" />
            <span className="viewer-title" title={dataset.filename}>{dataset.filename}</span>
          </nav>
          <StatusBadge status={dataset.status} effective={dataset.effective_status} />
        </div>

        {unreferenced && (
          <div className="georef-banner">
            <MapPinOff size={16} aria-hidden="true" />
            <span style={{ flex: 1 }}>This dataset has no ground coordinates yet, so it cannot be shown on a map.</span>
            <button className="btn btn-sm ds-geo" onClick={() => setTab('georef')}>Georeference</button>
          </div>
        )}

        <div className="viewer-body">
          {dataset.kind === 'raster' && <RasterViewer dataset={dataset} georefVersion={georefVersion} />}
          {dataset.kind === 'vector' && <VectorViewer dataset={dataset} georefVersion={georefVersion} />}
          {dataset.kind === 'pointcloud' && <PointCloudViewer dataset={dataset} />}
        </div>
      </div>

      <aside className="viewer-sidebar" aria-label="Dataset tools">
        <div className="side-tabs" role="tablist" aria-label="Dataset panels">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} id={`tab-${t.key}`}
              className="side-tab" onClick={() => setTab(t.key)}>
              {t.icon}{t.label}{t.key === 'georef' && unreferenced && <span className="dot" aria-label="needs attention" />}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'details' && (
            <InfoPanel embedded dataset={dataset} onDeleted={() => navigate(`/project/${dataset.project_id}`)} onCategoryChange={onChanged} />
          )}
          {tab === 'georef' && (georef
            ? <GeorefPanel embedded dataset={dataset} georef={georef} onSaved={onChanged} />
            : <div className="loading-center" style={{ height: 120 }}><div className="spinner" /></div>)}
          {tab === 'export' && <ExportPanel embedded datasetId={dataset.id} version={georefVersion} />}
        </div>
      </aside>
    </div>
  );
}
