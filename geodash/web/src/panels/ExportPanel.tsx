import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, exportDownloadUrl, type ExportTarget, type Job } from '../api';
import { useToast } from '../components/Toast';

interface ExportPanelProps {
  datasetId: string;
  /** georeference version: what can be exported (for example COG needs a north-up grid) changes when it does */
  version: number;
  /** rendered inside the viewer's tab bar: no collapsible header of its own */
  embedded?: boolean;
}

export function ExportPanel({ datasetId, version, embedded = false }: ExportPanelProps) {
  const [open, setOpen] = useState(embedded);
  const [targets, setTargets] = useState<ExportTarget[] | null>(null);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [exportCrs, setExportCrs] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [exporting, setExporting] = useState(false);
  const [lossyConfirmed, setLossyConfirmed] = useState(false);
  const { showError } = useToast();
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoadingTargets(true);
    api.exportTargets(datasetId)
      .then((t) => {
        if (!alive) return;
        setTargets(t);
        setSelectedFormat((cur) => (t.some((x) => x.format === cur && x.available) ? cur : ''));
      })
      .catch((e: Error) => { if (alive) showError(e.message); })
      .finally(() => { if (alive) setLoadingTargets(false); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, datasetId, version]);

  // Poll job
  useEffect(() => {
    if (!jobId) return;
    let timer: ReturnType<typeof setInterval>;
    const poll = () => {
      api.getJob(jobId)
        .then((j) => {
          setJob(j);
          if (j.state === 'done' || j.state === 'failed') {
            clearInterval(timer);
            setExporting(false);
            qc.invalidateQueries({ queryKey: ['jobs'] });
          }
        })
        .catch(() => clearInterval(timer));
    };
    poll();
    timer = setInterval(poll, 800);
    return () => clearInterval(timer);
  }, [jobId]);

  async function startExport() {
    if (!selectedFormat) return;
    setExporting(true);
    setJob(null);
    setJobId(null);
    try {
      const r = await api.startExport(datasetId, selectedFormat, exportCrs || null);
      setJobId(r.job_id);
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Export failed');
      setExporting(false);
    }
  }

  const selectedTarget = targets?.find((t) => t.format === selectedFormat);
  const isLossy = selectedTarget?.lossy ?? false;

  return (
    <div className={`panel${embedded ? ' embedded' : ''}`}>
      {!embedded && (
        <div className="panel-header" onClick={() => setOpen(!open)}>
          Export / Convert
          <span className="panel-chevron">{open ? '▲' : '▼'}</span>
        </div>
      )}
      {open && (
        <div className="panel-body">
          {loadingTargets && <div className="spinner" style={{ margin: '8px auto', display: 'block' }} />}

          {targets && targets.length === 0 && (
            <p className="muted">No export formats available.</p>
          )}

          {targets && targets.length > 0 && (
            <>
              <div className="form-group">
                <label className="form-label">Export format</label>
                {targets.map((t) => (
                  <div
                    key={t.format}
                    className={`export-target${!t.available ? ' disabled' : ''}${selectedFormat === t.format ? ' selected' : ''}`}
                    onClick={() => { if (t.available) { setSelectedFormat(t.format); setLossyConfirmed(false); } }}
                    role="radio"
                    aria-checked={selectedFormat === t.format}
                    tabIndex={t.available ? 0 : -1}
                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && t.available) setSelectedFormat(t.format); }}
                    aria-disabled={!t.available}
                  >
                    <div className="export-target-name">
                      {t.label}
                      {t.lossy && <span style={{ color: 'var(--amber)', marginLeft: 8, fontSize: 11 }}>Lossy</span>}
                    </div>
                    {!t.available && t.reason && (
                      <div className="export-target-reason">{t.reason}</div>
                    )}
                    {t.warnings.length > 0 && (
                      <div className="export-target-warn">{t.warnings.join('; ')}</div>
                    )}
                  </div>
                ))}
              </div>

              {isLossy && selectedTarget && (
                <div className="alert alert-warn" style={{ display: 'block' }}>
                  <strong>Lossy conversion</strong>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {selectedTarget.losses.map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                  <div style={{ marginTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={lossyConfirmed}
                        onChange={(e) => setLossyConfirmed(e.target.checked)}
                      />
                      I understand this conversion is lossy
                    </label>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="export-crs">Output CRS (optional, e.g. EPSG:4326)</label>
                <input
                  id="export-crs"
                  type="text"
                  value={exportCrs}
                  onChange={(e) => setExportCrs(e.target.value)}
                  placeholder="Leave blank to keep original"
                />
              </div>

              <button
                className="btn btn-primary"
                onClick={startExport}
                disabled={!selectedFormat || exporting || (isLossy && !lossyConfirmed)}
              >
                {exporting ? 'Exporting…' : 'Start export'}
              </button>
            </>
          )}

          {/* Job progress */}
          {job && (
            <div style={{ marginTop: 12 }}>
              <div className="progress-bar" style={{ marginBottom: 6 }}>
                <div className="progress-bar-fill" style={{ width: `${(job.progress * 100).toFixed(0)}%` }} />
              </div>
              <div className="muted">{job.message || job.state}</div>

              {job.state === 'failed' && (
                <div className="alert alert-error" style={{ marginTop: 8 }}>{job.error ?? 'Export failed'}</div>
              )}

              {job.state === 'done' && job.result && (
                <>
                  <div
                    className={`alert ${job.result.report.overall === 'PASS' ? 'alert-success' : job.result.report.overall === 'WARN' ? 'alert-warn' : 'alert-error'}`}
                    style={{ marginTop: 8, fontSize: 12 }}
                    data-overall={job.result.report.overall}
                  >
                    {job.result.report.overall === 'PASS' && (
                      <strong>✓ Validated: all {job.result.report.checks.length} checks passed</strong>
                    )}
                    {job.result.report.overall === 'WARN' && (
                      <strong>⚠ Completed with warnings — review before use</strong>
                    )}
                    {job.result.report.overall === 'FAIL' && (
                      <strong>✗ Failed validation — file withheld</strong>
                    )}
                  </div>

                  {job.result.report.checks.length > 0 && (
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>Check</th>
                            <th>Status</th>
                            <th>Detail</th>
                          </tr>
                        </thead>
                        <tbody>
                          {job.result.report.checks.map((c, i) => (
                            <tr key={i}>
                              <td style={{ fontSize: 12 }}>{c.name}</td>
                              <td>
                                <span className={`badge badge-${c.status.toLowerCase()}`}>{c.status}</span>
                              </td>
                              <td style={{ fontSize: 11, color: 'var(--tx-2)' }}>
                                {c.detail}
                                {c.status !== 'PASS' && c.expected != null && (
                                  <div>expected {JSON.stringify(c.expected)}, measured {JSON.stringify(c.measured)}</div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {job.result.report.notes.length > 0 && (
                    <ul style={{ fontSize: 12, color: 'var(--tx-2)', marginTop: 6, paddingLeft: 18 }}>
                      {job.result.report.notes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}

                  {job.result.downloadable && job.result.report.overall !== 'FAIL' && (
                    <a
                      href={exportDownloadUrl(job.id)}
                      className="btn btn-primary"
                      style={{ marginTop: 10, display: 'inline-flex' }}
                      download
                    >
                      Download {job.result.filename}
                    </a>
                  )}
                </>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
