import { ExternalLink, FolderKanban, LayoutDashboard, Library as LibraryIcon, Moon, Search, Sun, Upload } from 'lucide-react';
import { HashRouter, useRouter } from './router';
import { Dashboard } from './views/Dashboard';
import { Projects } from './views/Projects';
import { ProjectDetail } from './views/ProjectDetail';
import { ProjectMap } from './views/ProjectMap';
import { Library } from './views/Library';
import { DatasetViewer } from './views/DatasetViewer';
import { AppActionsProvider, useAppActions } from './components/AppActions';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function Header() {
  const { path, navigate } = useRouter();
  const { openPalette, openUpload, theme, toggleTheme } = useAppActions();

  function link(to: string, label: string, icon: React.ReactNode, also: string[] = []) {
    const active = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`) || also.some((p) => path.startsWith(p));
    return (
      <a href={`#${to}`} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}
        onClick={(e) => { e.preventDefault(); navigate(to); }}>
        {icon}{label}
      </a>
    );
  }

  const projectId = path.match(/^\/project\/([^/]+)/)?.[1];

  return (
    <header className="app-header">
      <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate('/'); }} aria-label="GeoDash home">
        <img className="brand-logo" src="./ntcpwc-logo.svg" alt="NTCPWC" />
        <span className="brand-divider" aria-hidden="true" />
        <span className="brand-text">
          <span className="brand-name">Geo<span>Dash</span></span>
          <span className="brand-sub">Geospatial Data Platform</span>
        </span>
      </a>
      <nav className="app-nav" aria-label="Main navigation">
        {link('/', 'Dashboard', <LayoutDashboard size={17} aria-hidden="true" />)}
        {link('/projects', 'Projects', <FolderKanban size={17} aria-hidden="true" />, ['/project/'])}
        {link('/library', 'Library', <LibraryIcon size={17} aria-hidden="true" />, ['/dataset/'])}
      </nav>
      <div className="header-right">
        <button className="header-search" onClick={openPalette} aria-label="Open search and commands" aria-keyshortcuts="Control+K">
          <Search size={16} aria-hidden="true" />
          <span className="label">Search…</span>
          <span className="kbd">{isMac ? '⌘' : 'Ctrl'} K</span>
        </button>
        <button className="btn btn-sm header-upload" onClick={() => openUpload(projectId)}>
          <Upload size={15} aria-hidden="true" /> Upload
        </button>
        <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
        </button>
        <a className="header-link" href="https://ntcpwc.iitm.ac.in" target="_blank" rel="noreferrer">
          NTCPWC <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="app-footer">
      <span>
        © {new Date().getFullYear()} National Technology Centre for Ports, Waterways and Coasts (NTCPWC), IIT Madras
      </span>
      <span>GeoDash: manage, georeference and convert geospatial data</span>
    </footer>
  );
}

function Frame({ children, bleed = false }: { children: React.ReactNode; bleed?: boolean }) {
  return (
    <AppActionsProvider>
      <div className="app">
        <Header />
        <main className={`app-main${bleed ? ' bleed' : ''}`}>
          {children}
          {!bleed && <Footer />}
        </main>
      </div>
    </AppActionsProvider>
  );
}

const ROUTES = [
  { path: '/', element: <Frame><Dashboard /></Frame> },
  { path: '/projects', element: <Frame><Projects /></Frame> },
  { path: '/project/:id', element: <Frame><ProjectDetail /></Frame> },
  { path: '/project/:id/map', element: <Frame bleed><ProjectMap /></Frame> },
  { path: '/library', element: <Frame><Library /></Frame> },
  { path: '/dataset/:id', element: <Frame bleed><DatasetViewer /></Frame> },
];

export function App() {
  return (
    <HashRouter
      routes={ROUTES}
      fallback={<Frame><div className="page"><p>Page not found.</p></div></Frame>}
    />
  );
}
