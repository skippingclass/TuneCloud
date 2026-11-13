import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { api, getAuthToken } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

const FavoritesContext = createContext(null);

export function FavoritesProvider({ children }) {
  const [starredTrackIds, setStarredTrackIds] = useState(new Set());
  const [starredAlbumIds, setStarredAlbumIds] = useState(new Set());
  const [starredArtistIds, setStarredArtistIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const loadAbortRef = useRef(null);
  const loadReqIdRef = useRef(0);
  const toggleSeqRef = useRef(new Map());

  useEffect(() => () => {
    mountedRef.current = false;
    loadAbortRef.current?.abort();
  }, []);

  const loadFavorites = useCallback(async () => {
    if (!getAuthToken()) return;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const reqId = ++loadReqIdRef.current;

    try {
      setLoading(true);
      const opts = { signal: controller.signal };
      const data = await (api.favoriteIds ? api.favoriteIds(opts) : api.favorites({ ids_only: true }, opts));
      if (!mountedRef.current || controller.signal.aborted || reqId !== loadReqIdRef.current) return;
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
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
    } finally {
      if (mountedRef.current && reqId === loadReqIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  const toggleFavorite = useCallback(async (kind, id, setter, apiToggle) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    const seq = (toggleSeqRef.current.get(key) || 0) + 1;
    toggleSeqRef.current.set(key, seq);

    let prevValue = false;
    setter((prev) => {
      const next = new Set(prev);
      prevValue = next.has(id);
      if (prevValue) next.delete(id);
      else next.add(id);
      return next;
    });

    try {
      const res = await apiToggle(id);
      if (!mountedRef.current || toggleSeqRef.current.get(key) !== seq) return;
      setter((prev) => {
        const next = new Set(prev);
        if (res?.starred) next.add(id);
        else next.delete(id);
        return next;
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (toggleSeqRef.current.get(key) === seq) {
        setter((prev) => {
          const next = new Set(prev);
          if (prevValue) next.add(id);
          else next.delete(id);
          return next;
        });
      }
      toast(`Failed to update favorite: ${err?.message || 'Unknown error'}`, 'error');
    }
  }, []);

  const toggleFavoriteTrack = useCallback(
    (trackId) => toggleFavorite('track', trackId, setStarredTrackIds, api.toggleFavoriteTrack),
    [toggleFavorite]
  );

  const toggleFavoriteAlbum = useCallback(
    (albumId) => toggleFavorite('album', albumId, setStarredAlbumIds, api.toggleFavoriteAlbum),
    [toggleFavorite]
  );

  const toggleFavoriteArtist = useCallback(
    (artistId) => toggleFavorite('artist', artistId, setStarredArtistIds, api.toggleFavoriteArtist),
    [toggleFavorite]
  );

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
