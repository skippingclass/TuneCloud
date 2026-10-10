import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getAuthToken } from '../api.js';

const FavoritesContext = createContext(null);

export function FavoritesProvider({ children }) {
  const [starredTrackIds, setStarredTrackIds] = useState(new Set());
  const [starredAlbumIds, setStarredAlbumIds] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const loadFavorites = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      setLoading(true);
      const data = await api.favorites();
      const trackIds = new Set((data.tracks || []).map((t) => t.id));
      const albumIds = new Set((data.albums || []).map((a) => a.id));
      setStarredTrackIds(trackIds);
      setStarredAlbumIds(albumIds);
    } catch {
      // Ignore if unauthenticated
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  const toggleFavoriteTrack = useCallback(async (trackId) => {
    if (!trackId) return;
    setStarredTrackIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
    try {
      const res = await api.toggleFavoriteTrack(trackId);
      setStarredTrackIds((prev) => {
        const next = new Set(prev);
        if (res.starred) next.add(trackId);
        else next.delete(trackId);
        return next;
      });
    } catch {
      // Revert on error
      setStarredTrackIds((prev) => {
        const next = new Set(prev);
        if (next.has(trackId)) next.delete(trackId);
        else next.add(trackId);
        return next;
      });
    }
  }, []);

  const toggleFavoriteAlbum = useCallback(async (albumId) => {
    if (!albumId) return;
    setStarredAlbumIds((prev) => {
      const next = new Set(prev);
      if (next.has(albumId)) next.delete(albumId);
      else next.add(albumId);
      return next;
    });
    try {
      const res = await api.toggleFavoriteAlbum(albumId);
      setStarredAlbumIds((prev) => {
        const next = new Set(prev);
        if (res.starred) next.add(albumId);
        else next.delete(albumId);
        return next;
      });
    } catch {
      setStarredAlbumIds((prev) => {
        const next = new Set(prev);
        if (next.has(albumId)) next.delete(albumId);
        else next.add(albumId);
        return next;
      });
    }
  }, []);

  const isTrackStarred = useCallback((id) => starredTrackIds.has(id), [starredTrackIds]);
  const isAlbumStarred = useCallback((id) => starredAlbumIds.has(id), [starredAlbumIds]);

  return (
    <FavoritesContext.Provider
      value={{
        starredTrackIds,
        starredAlbumIds,
        isTrackStarred,
        isAlbumStarred,
        toggleFavoriteTrack,
        toggleFavoriteAlbum,
        reloadFavorites: loadFavorites,
        loading,
      }}
    >
      {children}
    </FavoritesContext.Provider>
  );
}

export function useFavorites() {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used within FavoritesProvider');
  return ctx;
}
