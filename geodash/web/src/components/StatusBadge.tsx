import type { EffectiveStatus, DatasetStatus } from '../api';

export function StatusBadge({ status, effective }: { status: DatasetStatus; effective?: EffectiveStatus }) {
  const s = effective ?? (status as string);
  if (s === 'ready') return <span className="badge badge-ready">Ready</span>;
  if (s === 'unreferenced') return <span className="badge badge-unreferenced">Needs georeferencing</span>;
  if (s === 'error') return <span className="badge badge-error">Error</span>;
  return <span className="badge badge-neutral">{s}</span>;
}

export function KindBadge({ kind }: { kind: string }) {
  const labels: Record<string, string> = {
    raster: 'Raster',
    vector: 'Vector',
    pointcloud: 'Point cloud',
  };
  return <span className="badge badge-info">{labels[kind] ?? kind}</span>;
}

export function CategoryLabel({ category }: { category: string }) {
  const labels: Record<string, string> = {
    orthomosaic: 'Orthomosaic',
    dem: 'DEM',
    dsm: 'DSM',
    dtm: 'DTM',
    raster: 'Raster',
    vector: 'Vector',
    pointcloud: 'Point cloud',
    other: 'Other',
  };
  return <span>{labels[category] ?? category}</span>;
}
