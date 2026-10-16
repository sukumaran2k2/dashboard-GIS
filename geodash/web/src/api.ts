/** GeoDash API client – typed, no any sprawl. */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AppConfig {
  google_maps: boolean;
  max_upload_gb: number;
}

export interface Formats {
  raster: string[];
  vector: string[];
  pointcloud: string[];
  archive: string[];
  unsupported: Record<string, string>;
}

export interface Storage {
  used: number;
  disk_free: number;
  disk_total: number;
  datasets: number;
}

export interface Project {
  id: string;
  name: string;
  created: number;
  datasets: number;
  size: number;
}

export type DatasetKind = 'raster' | 'vector' | 'pointcloud';
export type DatasetCategory =
  | 'orthomosaic' | 'dem' | 'dsm' | 'dtm' | 'raster'
  | 'vector' | 'pointcloud' | 'other';
export type DatasetStatus = 'ready' | 'unreferenced' | 'processing' | 'error';
export type EffectiveStatus = 'ready' | 'unreferenced';

export interface RasterMeta {
  format: string;
  warnings: string[];
  native?: { crs: string | null; epsg: number | null; units: string; has_geotransform: boolean; bounds_wgs84: [number, number, number, number] | null; frame: string };
  source?: string;
  source_ext?: string;
  width: number;
  height: number;
  bands: number;
  dtype: string;
  resolution: [number, number] | null;
  nodata: number | null;
  overviews: number;
  tiled: boolean;
  compression: string | null;
  has_alpha: boolean;
  affine: number[] | null;
  stretch: [number, number][];
  epsg?: number | null;
  crs?: string | null;
  bounds_wgs84?: [number, number, number, number] | null;
}

export interface VectorMeta {
  format: string;
  warnings: string[];
  native?: { crs: string | null; epsg: number | null; units: string; has_geotransform: boolean; bounds_wgs84: [number, number, number, number] | null; frame: string };
  source?: string;
  source_ext?: string;
  layer: string;
  layers: string[];
  geometry_type: string;
  has_z: boolean;
  features: number;
  fields: { name: string; dtype: string }[];
  suggested_crs: string | null;
  epsg?: number | null;
  crs?: string | null;
  bounds_wgs84?: [number, number, number, number] | null;
}

export interface TopdownMeta {
  w: number;
  h: number;
  cell: number;
  affine: number[];
}

export interface PointCloudMeta {
  format: string;
  warnings: string[];
  native?: { crs: string | null; epsg: number | null; units: string; has_geotransform: boolean; bounds_wgs84: [number, number, number, number] | null; frame: string };
  source?: string;
  source_ext?: string;
  points: number;
  preview_points: number;
  center: [number, number, number];
  mins: [number, number, number];
  maxs: [number, number, number];
  has_rgb: boolean;
  details: Record<string, unknown>;
  topdown: TopdownMeta;
  epsg?: number | null;
  crs?: string | null;
  bounds_wgs84?: [number, number, number, number] | null;
}

export type DatasetMeta = RasterMeta | VectorMeta | PointCloudMeta;

export interface GeorefState {
  status: string;
  method: 'native' | 'assigned' | 'placed' | 'gcp' | 'none';
  version: number;
  local: boolean;
  bounds_wgs84: [number, number, number, number] | null;
  crs: string | null;
  epsg: number | null;
}

export interface Dataset {
  id: string;
  project_id: string;
  project_name?: string;
  filename: string;
  ext: string;
  kind: DatasetKind;
  category: DatasetCategory;
  status: DatasetStatus;
  effective_status: EffectiveStatus;
  size: number;
  sha256: string;
  notes: string;
  created: number;
  meta: DatasetMeta;
  georef: GeorefState;
}

export interface CrsArea {
  name: string;
  bounds: [number, number, number, number];
}

export interface CrsInfo {
  code: string;
  name: string;
  type: string;
  area: string;
  bounds: [number, number, number, number] | null;
}

export interface CrsDescription {
  name: string;
  epsg: number | null;
  label: string;
  wkt: string;
  type: 'geographic' | 'projected';
  units: string;
  axes: string[];
  area_of_use: CrsArea | null;
  has_vertical: boolean;
}

export interface GeorefEffective {
  crs: CrsDescription;
  frame: string;
  corners_wgs84: [[number, number], [number, number], [number, number], [number, number]];
  bounds_wgs84: [number, number, number, number];
  rotation_deg: number;
  scale: number;
  z_offset: number;
  pivot: [number, number] | null;
  target: [number, number] | null;
  center: [number, number];
  center_wgs84: [number, number];
}

export interface GcpResidualsInfo {
  residuals_m: number[];
  rmse_m: number;
  warnings: string[];
}

export interface GeorefOverride {
  method: string;
  rotation_deg: number;
  scale: number;
  z_offset: number;
  pivot: [number, number] | null;
  target: [number, number] | null;
  params: Record<string, unknown>;
  gcp: GcpResidualsInfo | null;
  local: boolean;
  area_check: boolean;
  verification: GeorefVerification | null;
  version: number;
}

export interface GeorefVerification {
  max_roundtrip_error_m: number;
  passed: boolean;
  tolerance_m: number;
}

export interface GeorefHistoryItem {
  id: string;
  note: string | null;
  created: number;
  as_uploaded: 0 | 1;
}

export interface GeorefFull {
  status: string;
  method: string;
  local: boolean;
  native: {
    crs: string | null;
    epsg: number | null;
    has_geotransform: boolean;
    bounds_wgs84: [number, number, number, number] | null;
  };
  override: GeorefOverride | null;
  effective: GeorefEffective | null;
  warnings: string[];
  history: GeorefHistoryItem[];
}

export interface GeorefPreviewResult extends GeorefFull {
  verification?: GeorefVerification;
  dataset?: Dataset;
}

export interface GeorefBody {
  mode: 'assign' | 'place' | 'gcp';
  crs?: string;
  grid?: { origin_x: number; origin_y: number; pixel_x: number; pixel_y?: number };
  anchor?: { lon: number; lat: number } | { x: number; y: number; crs: string };
  rotation_deg?: number;
  scale?: number;
  z_offset?: number;
  pixel_size?: number | [number, number];
  points?: { col: number; row: number; x: number; y: number }[];
  confirm_outside_area?: boolean;
  note?: string;
}

export interface FeaturesResponse {
  fields: string[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
}

export interface ExportTarget {
  format: string;
  label: string;
  extension: string;
  available: boolean;
  reason: string | null;
  lossy: boolean;
  losses: string[];
  warnings: string[];
}

export interface ExportCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  expected: unknown;
  measured: unknown;
}

export interface ExportReport {
  overall: 'PASS' | 'WARN' | 'FAIL';
  checks: ExportCheck[];
  notes: string[];
}

export interface Job {
  id: string;
  dataset_id: string;
  kind: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  message: string;
  params: Record<string, unknown>;
  result: { filename: string; size: number; downloadable: boolean; report: ExportReport } | null;
  error: string | null;
  created: number;
  dataset_filename?: string | null;
  project_id?: string | null;
}

export interface GoogleSession {
  tiles: string;
  attribution: string;
  expiry: string;
}

export interface TransformResult {
  points: [number, number][];
  notes: string[];
}

// ─── Base request ─────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json() as { detail?: string };
      msg = j.detail ?? msg;
    } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

// ─── API functions ─────────────────────────────────────────────────────────────

export const api = {
  config: () => request<AppConfig>('/api/config'),
  formats: () => request<Formats>('/api/formats'),
  storage: () => request<Storage>('/api/storage'),

  // Projects
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (name: string) => request<Project>('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }),
  updateProject: (id: string, data: { name?: string }) => request<Project>(`/api/projects/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Datasets
  listDatasets: (params: { project?: string; q?: string; kind?: string; category?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    return request<Dataset[]>(`/api/datasets?${p}`);
  },
  getDataset: (id: string) => request<Dataset>(`/api/datasets/${id}`),
  updateDataset: (id: string, data: { category?: DatasetCategory; filename?: string; notes?: string }) =>
    request<Dataset>(`/api/datasets/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteDataset: (id: string) => request<void>(`/api/datasets/${id}`, { method: 'DELETE' }),
  integrityCheck: (id: string) => request<{ sha256_at_upload: string; sha256_now: string; unchanged: boolean }>(`/api/datasets/${id}/integrity`),
  getGeoJSON: (id: string, frame?: 'native') => {
    const q = frame ? '?frame=native' : '';
    return request<GeoJSON.FeatureCollection>(`/api/datasets/${id}/geojson${q}`);
  },
  getFeatures: (id: string, offset = 0, limit = 50) =>
    request<FeaturesResponse>(`/api/datasets/${id}/features?offset=${offset}&limit=${limit}`),
  getGeoref: (id: string) => request<GeorefFull>(`/api/datasets/${id}/georef`),
  previewGeoref: (id: string, body: GeorefBody) => request<GeorefPreviewResult>(`/api/datasets/${id}/georef/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  saveGeoref: (id: string, body: GeorefBody) => request<GeorefPreviewResult>(`/api/datasets/${id}/georef`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  deleteGeoref: (id: string) => request<void>(`/api/datasets/${id}/georef`, { method: 'DELETE' }),
  restoreGeoref: (id: string, hid: string) => request<GeorefPreviewResult>(`/api/datasets/${id}/georef/restore/${hid}`, { method: 'POST' }),

  // Export
  exportTargets: (id: string) => request<ExportTarget[]>(`/api/datasets/${id}/export/targets`),
  startExport: (id: string, format: string, crs?: string | null) =>
    request<{ job_id: string }>(`/api/datasets/${id}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, crs }),
    }),
  getJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}`),
  listJobs: () => request<Job[]>('/api/jobs'),
  measure: (points: [number, number][]) =>
    request<{ length_m: number; segments_m: number[]; area_m2: number | null; perimeter_m: number | null }>('/api/measure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }),
    }),

  // CRS
  searchCrs: (q: string, lon?: number, lat?: number, limit = 20) => {
    const p = new URLSearchParams({ q, limit: String(limit) });
    if (lon !== undefined) p.set('lon', String(lon));
    if (lat !== undefined) p.set('lat', String(lat));
    return request<CrsInfo[]>(`/api/crs/search?${p}`);
  },
  getUtmCrs: (lon: number, lat: number) => request<CrsDescription>(`/api/crs/utm?lon=${lon}&lat=${lat}`),
  describeCrs: (text: string) => request<CrsDescription>(`/api/crs/describe?text=${encodeURIComponent(text)}`),
  transformCoords: (source: string, target: string, points: [number, number][]) =>
    request<TransformResult>('/api/crs/transform', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target, points }),
    }),

  // Google
  googleSession: (type: 'satellite' | 'hybrid' | 'roadmap' | 'terrain') =>
    request<GoogleSession>(`/api/google/session?type=${type}`),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function tileUrl(id: string, version: number): string {
  return `/api/datasets/${id}/tiles/{z}/{x}/{y}.png?v=${version}`;
}

export function imageUrl(id: string): string {
  return `/api/datasets/${id}/image.png`;
}

export function pointsUrl(id: string): string {
  return `/api/datasets/${id}/points`;
}

export function downloadUrl(id: string): string {
  return `/api/datasets/${id}/download`;
}

export function exportDownloadUrl(jobId: string): string {
  return `/api/jobs/${jobId}/download`;
}

export function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < 4) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export { ApiError };
