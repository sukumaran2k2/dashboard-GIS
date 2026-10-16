/** App-wide actions: command palette (Ctrl/Cmd+K) and the quick upload dialog. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, FolderKanban, FolderPlus, LayoutDashboard, Library, Moon, Search, Sun, Upload } from 'lucide-react';
import { api } from '../api';
import { useNavigate } from '../router';
import { useToast } from './Toast';
import { Modal } from './Modal';
import { UploadZone } from './UploadZone';
import { saveTheme, storedTheme, type Theme } from '../theme';

interface Actions {
  openPalette: () => void;
  openUpload: (projectId?: string) => void;
  theme: Theme;
  toggleTheme: () => void;
}

const Ctx = createContext<Actions>({ openPalette: () => undefined, openUpload: () => undefined, theme: 'light', toggleTheme: () => undefined });
export const useAppActions = () => useContext(Ctx);

export function AppActionsProvider({ children }: { children: React.ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [upload, setUpload] = useState<{ projectId?: string } | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || storedTheme());

  const toggleTheme = useCallback(() => {
    setTheme((t) => { const n = t === 'dark' ? 'light' : 'dark'; saveTheme(n); return n; });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<Actions>(() => ({
    openPalette: () => setPalette(true),
    openUpload: (projectId?: string) => setUpload({ projectId }),
    theme, toggleTheme,
  }), [theme, toggleTheme]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {palette && <CommandPalette onClose={() => setPalette(false)} onUpload={() => { setPalette(false); setUpload({}); }} theme={theme} toggleTheme={toggleTheme} />}
      {upload && <QuickUpload initialProject={upload.projectId} onClose={() => setUpload(null)} />}
    </Ctx.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────── command palette
interface Item { key: string; group: string; label: string; sub?: string; icon: React.ReactNode; run: () => void }

function CommandPalette({ onClose, onUpload, theme, toggleTheme }: { onClose: () => void; onUpload: () => void; theme: Theme; toggleTheme: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { showError } = useToast();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const { data: datasets } = useQuery({ queryKey: ['datasets'], queryFn: () => api.listDatasets() });

  const go = useCallback((to: string) => { onClose(); navigate(to); }, [navigate, onClose]);

  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const has = (t: string) => !s || t.toLowerCase().includes(s);
    const pages: Array<[string, string, React.ReactNode]> = [
      ['Dashboard', '/', <LayoutDashboard size={16} />], ['Projects', '/projects', <FolderKanban size={16} />], ['Dataset library', '/library', <Library size={16} />],
    ];
    const nav: Item[] = pages.filter(([l]) => has(l)).map(([l, to, icon]) => ({ key: `p${to}`, group: 'Go to', label: l, icon, run: () => go(to) }));
    const found: Item[] = [
      ...(projects ?? []).filter((p) => has(p.name)).slice(0, s ? 8 : 5).map((p) => ({
        key: `pr${p.id}`, group: 'Projects', label: p.name, sub: `${p.datasets} dataset${p.datasets === 1 ? '' : 's'}`,
        icon: <FolderKanban size={16} />, run: () => go(`/project/${p.id}`),
      })),
      ...(datasets ?? []).filter((d) => has(d.filename) || has(d.project_name ?? '')).slice(0, s ? 8 : 5).map((d) => ({
        key: `d${d.id}`, group: 'Datasets', label: d.filename, sub: d.project_name, icon: <FileStack size={16} />, run: () => go(`/dataset/${d.id}`),
      })),
    ];
    const actions: Item[] = [];
    if (has('upload data')) actions.push({ key: 'a-up', group: 'Actions', label: 'Upload data…', icon: <Upload size={16} />, run: onUpload });
    const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    if (has(themeLabel) || has('theme')) actions.push({ key: 'a-theme', group: 'Actions', label: themeLabel, icon: theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />, run: () => { toggleTheme(); onClose(); } });
    if (s && !(projects ?? []).some((p) => p.name.toLowerCase() === s)) {
      actions.push({
        key: 'a-new', group: 'Actions', label: `Create project “${q.trim()}”`, icon: <FolderPlus size={16} />,
        run: async () => {
          try {
            const p = await api.createProject(q.trim());
            await qc.invalidateQueries({ queryKey: ['projects'] });
            go(`/project/${p.id}`);
          } catch (e) { showError(e instanceof Error ? e.message : 'Could not create the project'); }
        },
      });
    }
    // with a query, the best matches come first so Enter opens what the user searched for
    return s ? [...found, ...nav, ...actions] : [...nav, ...actions, ...found];
  }, [q, projects, datasets, theme, go, onUpload, onClose, toggleTheme, qc, showError]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
  }

  let lastGroup = '';
  return (
    <div className="palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label="Search and commands" onKeyDown={onKey}>
        <div className="palette-input">
          <Search size={18} aria-hidden="true" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects and datasets, or type a command…" aria-label="Search" />
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="palette-empty">Nothing matches “{q}”.</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group, <div className="palette-group" key={`g-${it.group}`}>{it.group}</div>) : null;
            return (
              <div key={it.key}>
                {head}
                <button data-idx={i} role="option" aria-selected={i === active} className={`palette-item${i === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)} onClick={() => it.run()}>
                  {it.icon}<span>{it.label}</span>{it.sub && <span className="sub">{it.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> to move</span>
          <span><span className="kbd">Enter</span> to open</span>
          <span><span className="kbd">Esc</span> to close</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────── quick upload
function QuickUpload({ initialProject, onClose }: { initialProject?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { showError } = useToast();
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });
  const { data: formats } = useQuery({ queryKey: ['formats'], queryFn: api.formats });
  const [pid, setPid] = useState(initialProject ?? '');
  const [newName, setNewName] = useState('');
  const accepted = formats ? [...formats.raster, ...formats.vector, ...formats.pointcloud, ...formats.archive] : [];
  const chosen = projects?.find((p) => p.id === pid);

  useEffect(() => { if (!pid && projects?.length) setPid(projects[0].id); }, [projects, pid]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      const p = await api.createProject(newName.trim());
      await qc.invalidateQueries({ queryKey: ['projects'] });
      setPid(p.id);
      setNewName('');
    } catch (err) { showError(err instanceof Error ? err.message : 'Could not create the project'); }
  }

  return (
    <Modal title="Upload data" onClose={onClose} wide
      footer={<>
        {chosen && <button className="btn btn-secondary" onClick={() => { onClose(); navigate(`/project/${chosen.id}`); }}>Open project</button>}
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </>}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <div className="form-group" style={{ flex: '1 1 240px', marginBottom: 0 }}>
          <label className="form-label" htmlFor="qu-project">Add to project</label>
          <select id="qu-project" value={pid} onChange={(e) => setPid(e.target.value)}>
            {(projects ?? []).length === 0 && <option value="">No projects yet: create one</option>}
            {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <form onSubmit={create} style={{ display: 'flex', gap: 8, flex: '1 1 260px', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
            <label className="form-label" htmlFor="qu-new">or a new project</label>
            <input id="qu-new" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New project name" />
          </div>
          <button className="btn btn-secondary" type="submit" disabled={!newName.trim()}>Create</button>
        </form>
      </div>
      {pid ? (
        <UploadZone key={pid} projectId={pid} acceptedFormats={accepted}
          onDone={() => { ['datasets', 'projects', 'storage'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); }} />
      ) : <p className="muted">Create a project first.</p>}
    </Modal>
  );
}
