import { useEffect, useState } from 'react';

export function useLibraryState(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(`tunecloud-view:${key}`));
      if (typeof stored !== typeof fallback) return fallback;
      if (typeof fallback === 'number' && (!Number.isFinite(stored) || stored < 1)) return fallback;
      return stored ?? fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`tunecloud-view:${key}`, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}
