import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { parseLrc } from '../utils/lyrics.js';

const cache = new Map();

// All player layouts use the same successful-result cache. Failed requests are
// retried on reopening; aborted or late responses never replace another track.
export function useTrackLyrics(track, enabled) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState({ trackId: null, loading: true, data: null });
  useEffect(() => {
    if (!enabled || !track) return;
    const id = track.id;
    if (cache.has(id)) {
      setResult({ trackId: id, loading: false, data: cache.get(id) });
      return;
    }
    const controller = new AbortController();
    setResult({ trackId: id, loading: true, data: null });
    api.lyrics({ id, title: track.title || track.file_name || track.fileName || '', artist: track.artist || '', duration: track.duration || 0 }, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const lines = response.synced ? parseLrc(response.lyrics, track.duration) : [];
        const data = { synced: lines.length > 0, lines, text: lines.length ? null : response.lyrics, source: response.source || 'lrclib' };
        if (cache.size >= 200) cache.delete(cache.keys().next().value);
        cache.set(id, data);
        setResult({ trackId: id, loading: false, data });
      })
      .catch(error => {
        if (!controller.signal.aborted && error.name !== 'AbortError') {
          setResult({ trackId: id, loading: false, data: { notFound: true } });
        }
      });
    return () => controller.abort();
  }, [enabled, track?.id, attempt]);
  return {
    loading: enabled && (result.trackId !== track?.id || result.loading),
    data: result.trackId === track?.id ? result.data : null,
    retry: () => setAttempt(value => value + 1),
  };
}
