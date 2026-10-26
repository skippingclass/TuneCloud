import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, getAuthToken } from '../api.js';

const FavoritesContext = createContext(null);

export function FavoritesProvider({ children }) {
  const [starredTrackIds, setStarredTrackIds] = useState(new Set());
  const [starredAlbumIds, setStarredAlbumIds] = useState(new Set());
  const [starredArtistIds, setStarredArtistIds] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const loadFavorites = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      setLoading(true);
      const data = await (api.favoriteIds ? api.favoriteIds() : api.favorites({ ids_only: true }));
      const trackIds = new Set(
        data.track_ids || (data.tracks || []).map((t) => (typeof t === 'number' ? t : t.id))
      );
      const albumIds = new Set(
        data.album_ids || (data.albums || []).map((a) => (typeof a === 'number' ? a : a.id))
      );
      const artistIds = new Set(
        data.artist_ids || (data.artists || []).map((a) => (typeof a === 'number' ? a : a.id))
      );
      setStarredTrackIds(trackIds);
      setStarredAlbumIds(albumIds);
      setStarredArtistIds(artistIds);
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

  const toggleFavoriteArtist = useCallback(async (artistId) => {
    if (!artistId) return;
    setStarredArtistIds((prev) => {
      const next = new Set(prev);
      if (next.has(artistId)) next.delete(artistId);
      else next.add(artistId);
      return next;
    });
    try {
      const res = await api.toggleFavoriteArtist(artistId);
      setStarredArtistIds((prev) => {
        const next = new Set(prev);
        if (res.starred) next.add(artistId);
        else next.delete(artistId);
        return next;
      });
    } catch {
      setStarredArtistIds((prev) => {
        const next = new Set(prev);
        if (next.has(artistId)) next.delete(artistId);
        else next.add(artistId);
        return next;
      });
    }
  }, []);

  const isTrackStarred = useCallback((id) => starredTrackIds.has(id), [starredTrackIds]);
  const isAlbumStarred = useCallback((id) => starredAlbumIds.has(id), [starredAlbumIds]);
  const isArtistStarred = useCallback((id) => starredArtistIds.has(id), [starredArtistIds]);

  return (
    <FavoritesContext.Provider
      value={{
        starredTrackIds,
        starredAlbumIds,
        starredArtistIds,
        isTrackStarred,
        isAlbumStarred,
        isArtistStarred,
        toggleFavoriteTrack,
        toggleTrackStar: toggleFavoriteTrack,
        toggleFavoriteAlbum,
        toggleFavoriteArtist,
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
