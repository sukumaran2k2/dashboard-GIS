/** Simple hash router – no library needed. */

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

interface RouterContextValue {
  path: string;
  params: Record<string, string>;
  navigate: (to: string) => void;
}

const RouterCtx = createContext<RouterContextValue>({
  path: '/',
  params: {},
  navigate: () => undefined,
});

export function useRouter() {
  return useContext(RouterCtx);
}

export function useNavigate() {
  return useContext(RouterCtx).navigate;
}

export function useParams() {
  return useContext(RouterCtx).params;
}

function parseHash(): string {
  const h = window.location.hash;
  return h.startsWith('#') ? h.slice(1) || '/' : '/';
}

interface RoutePattern {
  pattern: string;
  regex: RegExp;
  keys: string[];
}

function compilePattern(pattern: string): RoutePattern {
  const keys: string[] = [];
  // '*' is a catch-all
  if (pattern === '*') {
    return { pattern, regex: /^.*$/, keys };
  }
  const src = pattern
    .replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');
  return { pattern, regex: new RegExp(`^${src}$`), keys };
}

function matchRoute(
  patterns: RoutePattern[],
  path: string
): { matched: RoutePattern; params: Record<string, string> } | null {
  for (const p of patterns) {
    const m = path.match(p.regex);
    if (m) {
      const params: Record<string, string> = {};
      p.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { matched: p, params };
    }
  }
  return null;
}

export interface Route {
  path: string;
  element: React.ReactNode;
}

interface RouterProps {
  routes: Route[];
  fallback?: React.ReactNode;
}

export function HashRouter({ routes, fallback }: RouterProps) {
  const [path, setPath] = useState(parseHash);

  const navigate = useCallback((to: string) => {
    window.location.hash = to;
  }, []);

  useEffect(() => {
    const handler = () => setPath(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const compiled = routes.map((r) => ({ ...r, ...compilePattern(r.path) }));
  const match = matchRoute(compiled, path);

  const element = match
    ? compiled.find((r) => r.pattern === match.matched.pattern)?.element
    : fallback ?? <div style={{ padding: 24 }}>404 – Page not found</div>;

  return (
    <RouterCtx.Provider value={{ path, params: match?.params ?? {}, navigate }}>
      {element}
    </RouterCtx.Provider>
  );
}
