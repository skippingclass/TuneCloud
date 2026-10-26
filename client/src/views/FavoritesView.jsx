import { useState, useEffect, useRef } from 'react';
import {
  Heart,
  Play,
  Shuffle,
  Disc,
  Music2,
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';
import { toast } from '../components/layout/Toast.jsx';

export const DEFAULT_FAVORITES_PAGE_SIZE = 50;

export function FavoritesView({
  user,
  onAlbumClick,
  onGoToArtist,
  onEditTags,
  onAddToPlaylist,
}) {
  const [tab, setTab] = useState('tracks'); // 'tracks' | 'albums'
  const [tracks, setTracks] = useState([]);
  const [totalTracks, setTotalTracks] = useState(0);
  const [trackPage, setTrackPage] = useState(1);
  const [trackFilter, setTrackFilter] = useState('');
  const [debouncedTrackQuery, setDebouncedTrackQuery] = useState('');

  const [albums, setAlbums] = useState([]);
  const [totalAlbums, setTotalAlbums] = useState(0);
  const [albumPage, setAlbumPage] = useState(1);
  const [albumFilter, setAlbumFilter] = useState('');
  const [debouncedAlbumQuery, setDebouncedAlbumQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  const { currentTrack, playTrack } = usePlayer();
  const { starredTrackIds, starredAlbumIds } = useFavorites();

  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  // Debounce track search
  useEffect(() => {
    const trimmed = trackFilter.trim();
    const timer = setTimeout(() => {
      setDebouncedTrackQuery(trimmed);
      setTrackPage(1);
    }, 150);
    return () => clearTimeout(timer);
  }, [trackFilter]);

  // Debounce album search
  useEffect(() => {
    const trimmed = albumFilter.trim();
    const timer = setTimeout(() => {
      setDebouncedAlbumQuery(trimmed);
      setAlbumPage(1);
    }, 150);
    return () => clearTimeout(timer);
  }, [albumFilter]);

  // Load Tracks when on tracks tab
  useEffect(() => {
    if (tab !== 'tracks') return;
    const reqId = ++reqIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const offset = (trackPage - 1) * DEFAULT_FAVORITES_PAGE_SIZE;
    const params = {
      type: 'tracks',
      limit: DEFAULT_FAVORITES_PAGE_SIZE,
      offset,
    };
    if (debouncedTrackQuery) params.q = debouncedTrackQuery;

    api
      .favorites(params, { signal: controller.signal })
      .then((res) => {
        if (reqId !== reqIdRef.current || controller.signal.aborted) return;
        const list = Array.isArray(res) ? res : (res?.tracks || []);
        const total = typeof res?.total === 'number' ? res.total : (res?.total_tracks ?? list.length);
        setTracks(list);
        setTotalTracks(total);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setTracks([]);
        setTotalTracks(0);
      })
      .finally(() => {
        if (reqId === reqIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [tab, trackPage, debouncedTrackQuery, starredTrackIds.size]);

  // Load Albums when on albums tab
  useEffect(() => {
    if (tab !== 'albums') return;
    const reqId = ++reqIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const offset = (albumPage - 1) * DEFAULT_FAVORITES_PAGE_SIZE;
    const params = {
      type: 'albums',
      limit: DEFAULT_FAVORITES_PAGE_SIZE,
      offset,
    };
    if (debouncedAlbumQuery) params.q = debouncedAlbumQuery;

    api
      .favorites(params, { signal: controller.signal })
      .then((res) => {
        if (reqId !== reqIdRef.current || controller.signal.aborted) return;
        const list = Array.isArray(res) ? res : (res?.albums || []);
        const total = typeof res?.total === 'number' ? res.total : (res?.total_albums ?? list.length);
        setAlbums(list);
        setTotalAlbums(total);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setAlbums([]);
        setTotalAlbums(0);
      })
      .finally(() => {
        if (reqId === reqIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [tab, albumPage, debouncedAlbumQuery, starredAlbumIds.size]);

  // Load summary counts for header
  useEffect(() => {
    api
      .favorites({ limit: 1 })
      .then((res) => {
        if (typeof res?.total_tracks === 'number') setTotalTracks(res.total_tracks);
        if (typeof res?.total_albums === 'number') setTotalAlbums(res.total_albums);
      })
      .catch(() => {});
  }, [starredTrackIds.size, starredAlbumIds.size]);

  const fetchAllMatchingFavoriteTracks = async () => {
    const params = {
      type: 'tracks',
      all: true,
    };
    if (debouncedTrackQuery) params.q = debouncedTrackQuery;
    const res = await api.favorites(params);
    const list = Array.isArray(res) ? res : (res?.tracks || []);
    return list.filter((t) => t.available !== false);
  };

  const handlePlayAll = async () => {
    setActionLoading(true);
    try {
      const allAvailable = await fetchAllMatchingFavoriteTracks();
      if (allAvailable.length > 0) {
        playTrack(allAvailable[0], allAvailable);
        toast(`Playing ${allAvailable.length} liked tracks`, 'success');
      } else {
        toast('No available liked tracks to play', 'info');
      }
    } catch (err) {
      toast(`Failed to play liked songs: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleShufflePlay = async () => {
    setActionLoading(true);
    try {
      const allAvailable = await fetchAllMatchingFavoriteTracks();
      if (allAvailable.length > 0) {
        const shuffled = [...allAvailable].sort(() => Math.random() - 0.5);
        playTrack(shuffled[0], shuffled);
        toast(`Playing ${shuffled.length} liked tracks in shuffle`, 'success');
      } else {
        toast('No available liked tracks to play', 'info');
      }
    } catch (err) {
      toast(`Failed to play liked songs: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const trackTotalPages = Math.ceil(totalTracks / DEFAULT_FAVORITES_PAGE_SIZE) || 1;
  const albumTotalPages = Math.ceil(totalAlbums / DEFAULT_FAVORITES_PAGE_SIZE) || 1;

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-in">
      {/* Header */}
      <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-white/[0.08] relative overflow-hidden flex flex-col sm:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-4 text-center sm:text-left">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-accent to-accent-hover text-surface-950 flex items-center justify-center shadow-glow shrink-0">
            <Heart className="w-7 h-7 fill-surface-950" />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              My Favorites
            </h1>
            <p className="text-xs text-surface-400 mt-1">
              {totalTracks} liked tracks · {totalAlbums} liked albums
            </p>
          </div>
        </div>

        {tab === 'tracks' && totalTracks > 0 && (
          <div className="flex items-center gap-2.5">
            <button
              onClick={handlePlayAll}
              disabled={actionLoading}
              className="btn-primary py-2.5 px-5 text-xs shadow-glow disabled:opacity-50"
            >
              {actionLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 fill-surface-950" />
              )}
              <span>Play All</span>
            </button>
            <button
              onClick={handleShufflePlay}
              disabled={actionLoading}
              className="btn-glass py-2.5 px-4 text-xs disabled:opacity-50"
            >
              <Shuffle className="w-4 h-4 text-accent" />
              <span>Shuffle</span>
            </button>
          </div>
        )}
      </div>

      {/* Tabs & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab('tracks')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              tab === 'tracks'
                ? 'bg-accent/15 text-accent border border-accent/25 shadow-glow'
                : 'text-surface-400 hover:text-white'
            }`}
          >
            <Music2 className="w-3.5 h-3.5" />
            <span>Liked Tracks ({totalTracks})</span>
          </button>

          <button
            onClick={() => setTab('albums')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              tab === 'albums'
                ? 'bg-accent/15 text-accent border border-accent/25 shadow-glow'
                : 'text-surface-400 hover:text-white'
            }`}
          >
            <Disc className="w-3.5 h-3.5" />
            <span>Liked Albums ({totalAlbums})</span>
          </button>
        </div>

        {/* Tab Search Filter */}
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-surface-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          {tab === 'tracks' ? (
            <input
              type="text"
              placeholder="Search liked tracks..."
              value={trackFilter}
              onChange={(e) => setTrackFilter(e.target.value)}
              className="glass-input w-full pl-8 pr-3 py-1.5 text-xs rounded-xl"
            />
          ) : (
            <input
              type="text"
              placeholder="Search liked albums..."
              value={albumFilter}
              onChange={(e) => setAlbumFilter(e.target.value)}
              className="glass-input w-full pl-8 pr-3 py-1.5 text-xs rounded-xl"
            />
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="h-64 flex flex-col items-center justify-center gap-3 text-surface-400">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs font-medium">Loading favorites...</span>
        </div>
      ) : tab === 'tracks' ? (
        tracks.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
            <Heart className="w-10 h-10 stroke-1 opacity-40" />
            <p className="text-sm font-semibold">
              {debouncedTrackQuery ? 'No tracks match your search' : 'No favorite tracks yet'}
            </p>
            <p className="text-xs text-surface-600">
              {debouncedTrackQuery
                ? 'Try searching with another keyword'
                : 'Click the heart icon on any song to add it here'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="glass-panel rounded-3xl overflow-hidden border border-white/[0.06]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.06] text-surface-500 text-[11px] font-semibold uppercase tracking-wider">
                    <th className="px-3 sm:px-4 py-3 text-center w-12">#</th>
                    <th className="w-8 px-1 py-3 text-center"></th>
                    <th className="px-3 sm:px-4 py-3">Title</th>
                    <th className="px-3 sm:px-4 py-3 hidden sm:table-cell">Artist</th>
                    <th className="px-3 sm:px-4 py-3 hidden md:table-cell">Album</th>
                    <th className="px-3 sm:px-4 py-3 text-right hidden sm:table-cell">Duration</th>
                    <th className="px-2 py-3 text-center hidden lg:table-cell">Format</th>
                    <th className="w-9 px-2 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.03]">
                  {tracks.map((track, idx) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={(trackPage - 1) * DEFAULT_FAVORITES_PAGE_SIZE + idx}
                      onPlay={(t) => playTrack(t, tracks)}
                      isPlaying={currentTrack?.id === track.id}
                      user={user}
                      onEditTags={onEditTags}
                      onGoToAlbum={onAlbumClick}
                      onGoToArtist={onGoToArtist}
                      onAddToPlaylist={onAddToPlaylist}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {trackTotalPages > 1 && (
              <div className="flex items-center justify-between px-2 py-3 text-xs text-surface-400">
                <span>
                  Showing {(trackPage - 1) * DEFAULT_FAVORITES_PAGE_SIZE + 1}–
                  {Math.min(trackPage * DEFAULT_FAVORITES_PAGE_SIZE, totalTracks)} of {totalTracks}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTrackPage((p) => Math.max(1, p - 1))}
                    disabled={trackPage <= 1}
                    className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                    title="Previous Page"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="font-mono px-2 font-medium text-surface-200">
                    Page {trackPage} of {trackTotalPages}
                  </span>
                  <button
                    onClick={() => setTrackPage((p) => Math.min(trackTotalPages, p + 1))}
                    disabled={trackPage >= trackTotalPages}
                    className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                    title="Next Page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      ) : albums.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Disc className="w-10 h-10 stroke-1 opacity-40" />
          <p className="text-sm font-semibold">
            {debouncedAlbumQuery ? 'No albums match your search' : 'No favorite albums yet'}
          </p>
          <p className="text-xs text-surface-600">
            {debouncedAlbumQuery
              ? 'Try searching with another keyword'
              : 'Like an album to find it here quickly'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {albums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onGoToArtist}
              />
            ))}
          </div>

          {/* Album Pagination Controls */}
          {albumTotalPages > 1 && (
            <div className="flex items-center justify-between px-2 py-3 text-xs text-surface-400">
              <span>
                Showing {(albumPage - 1) * DEFAULT_FAVORITES_PAGE_SIZE + 1}–
                {Math.min(albumPage * DEFAULT_FAVORITES_PAGE_SIZE, totalAlbums)} of {totalAlbums}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setAlbumPage((p) => Math.max(1, p - 1))}
                  disabled={albumPage <= 1}
                  className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                  title="Previous Page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-mono px-2 font-medium text-surface-200">
                  Page {albumPage} of {albumTotalPages}
                </span>
                <button
                  onClick={() => setAlbumPage((p) => Math.min(albumTotalPages, p + 1))}
                  disabled={albumPage >= albumTotalPages}
                  className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                  title="Next Page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
