import { FolderKanban, Shapes } from 'lucide-react';
import { imageUrl, type Dataset } from '../api';

const RANK: Record<string, number> = { orthomosaic: 0, raster: 1, dsm: 2, dtm: 3, dem: 4, pointcloud: 5 };

/** Datasets that have a preview picture (rasters and point clouds), best first: georeferenced orthomosaics lead. */
export function previewDatasets(datasets: Dataset[]): Dataset[] {
  return datasets
    .filter((d) => d.kind === 'raster' || d.kind === 'pointcloud')
    .sort((a, b) =>
      (a.effective_status === 'ready' ? 0 : 1) - (b.effective_status === 'ready' ? 0 : 1)
      || (RANK[a.category] ?? 9) - (RANK[b.category] ?? 9)
      || b.created - a.created);
}

/** Small square thumbnail shown next to a project name. */
export function ProjectAvatar({ datasets, size = 40 }: { datasets: Dataset[]; size?: number }) {
  const first = previewDatasets(datasets)[0];
  const hasVector = datasets.some((d) => d.kind === 'vector');
  return (
    <div className="project-avatar" style={{ width: size, height: size }} aria-hidden="true">
      {first
        ? <img src={imageUrl(first.id)} alt="" loading="lazy" />
        : hasVector ? <Shapes size={Math.round(size * 0.45)} /> : <FolderKanban size={Math.round(size * 0.45)} />}
    </div>
  );
}

/** Cover collage for a project card: up to three previews, or a placeholder. */
export function ProjectCover({ datasets }: { datasets: Dataset[] }) {
  const pics = previewDatasets(datasets).slice(0, 3);
  const vectors = datasets.filter((d) => d.kind === 'vector').length;
  if (pics.length === 0) {
    return (
      <div className="project-cover empty" aria-hidden="true">
        {vectors > 0 ? <Shapes size={28} /> : <FolderKanban size={28} />}
        <span>{datasets.length === 0 ? 'No data yet' : vectors > 0 ? `${vectors} vector dataset${vectors === 1 ? '' : 's'}` : 'No preview'}</span>
      </div>
    );
  }
  return (
    <div className={`project-cover n${pics.length}`} aria-hidden="true">
      {pics.map((d) => <img key={d.id} src={imageUrl(d.id)} alt="" loading="lazy" />)}
      {datasets.length > pics.length && <span className="project-cover-more">+{datasets.length - pics.length}</span>}
    </div>
  );
}
