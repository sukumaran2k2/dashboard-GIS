export type Theme = 'light' | 'dark';

const KEY = 'geodash.theme';

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch { /* storage unavailable */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function saveTheme(t: Theme) {
  applyTheme(t);
  try { localStorage.setItem(KEY, t); } catch { /* storage unavailable */ }
}
