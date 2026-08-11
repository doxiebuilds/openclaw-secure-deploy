export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ocp:theme';

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return mode;
}

/**
 * Writes theme attributes as one unit. Splitting them (e.g. setting
 * data-theme now and arco-theme on a later tick) produces a half-themed
 * paint, since Arco's own components read arco-theme independently.
 */
export function applyThemeAttributes(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  const writeBody = () => {
    document.body?.setAttribute('arco-theme', resolved);
  };
  if (document.body) {
    writeBody();
  } else {
    document.addEventListener('DOMContentLoaded', writeBody, { once: true });
  }
  return resolved;
}

export function getStoredThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // ignore
  }
  return 'system';
}

export function storeThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

/** Inline script source injected into index.html to prevent a flash of the wrong theme. */
export const FOUC_PREVENTION_SCRIPT = `
(function () {
  try {
    var mode = localStorage.getItem('${STORAGE_KEY}') || 'system';
    var resolved = mode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : mode;
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (e) {}
})();
`;
