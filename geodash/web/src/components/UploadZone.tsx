import { useRef, useState, useCallback } from 'react';
import { fmtBytes } from '../api';

interface UploadStatus {
  id: number;
  name: string;
  size: number;
  pct: number;
  done: boolean;
  error: string | null;
}

interface UploadZoneProps {
  projectId: string;
  acceptedFormats: string[];
  /** called after every file finishes (success or failure) so the dataset list can refresh straight away */
  onDone: () => void;
}

export function UploadZone({ projectId, acceptedFormats, onDone }: UploadZoneProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const counter = useRef(0);

  const patch = useCallback((id: number, change: Partial<UploadStatus>) => {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...change } : u)));
  }, []);

  const startUpload = useCallback((files: File[]) => {
    const items = files.map((f) => ({ id: ++counter.current, file: f }));
    setUploads((prev) => [...items.map(({ id, file }) => ({ id, name: file.name, size: file.size, pct: 0, done: false, error: null })), ...prev]);

    items.forEach(({ id, file }) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('file', file);
      xhr.open('POST', `/api/projects/${projectId}/upload`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) patch(id, { pct: (e.loaded / e.total) * 100 });
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          patch(id, { pct: 100, done: true });
        } else {
          let msg = `Upload failed (${xhr.status})`;
          try { msg = (JSON.parse(xhr.responseText) as { detail?: string }).detail ?? msg; } catch { /* not JSON */ }
          patch(id, { pct: 100, error: msg });
        }
        onDone();
      };

      xhr.onerror = () => {
        patch(id, { pct: 100, error: 'Network error: the server could not be reached.' });
        onDone();
      };

      xhr.send(fd);
    });
  }, [projectId, onDone, patch]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length > 0) startUpload(files);
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    if (files.length > 0) startUpload(files);
    e.target.value = '';
  };

  const fmtList = acceptedFormats.length > 0
    ? acceptedFormats.map((e) => e.toUpperCase()).join(' · ')
    : 'GeoTIFF · Shapefile ZIP · LAS/LAZ';

  return (
    <div style={{ marginBottom: 20 }}>
      <div
        className={`drop-zone${dragging ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        aria-label="Upload files"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click(); }}
      >
        <div className="drop-zone-icon">⬆</div>
        <p>Drag & drop files here or <strong>browse</strong></p>
        <div className="formats">{fmtList}</div>
        <input ref={fileInput} type="file" multiple hidden onChange={handleFiles} />
      </div>

      {uploads.map((u) => (
        <div key={u.id} className="upload-item">
          <div className="row">
            <span className="upload-item-name">{u.name}</span>
            <span className="muted">{fmtBytes(u.size)}</span>
          </div>
          <div className="upload-progress">
            <div className={`upload-progress-fill${u.error ? ' error' : ''}`} style={{ width: `${u.pct}%` }} />
          </div>
          {u.error && <span className="upload-status err">✗ {u.error}</span>}
          {u.done && <span className="upload-status ok">✓ Uploaded and validated</span>}
          {!u.done && !u.error && (
            <span className="upload-status">{u.pct < 100 ? `Uploading ${u.pct.toFixed(0)}%` : 'Validating…'}</span>
          )}
        </div>
      ))}
    </div>
  );
}
