import { useState, useEffect, useRef } from 'react';
import {
  Search,
  Play,
  Shuffle,
  Music2,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export const DEFAULT_TRACKS_PAGE_SIZE = 100;

export function TracksView({
  user,
  onGoToAlbum,
  onGoToArtist,
  onEditTags,
  onAddToPlaylist,
  pageSize = DEFAULT_TRACKS_PAGE_SIZE,
}) {
  const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || DEFAULT_TRACKS_PAGE_SIZE));
  const [tracks, setTracks] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const bulkAbortRef = useRef(null);
  const [filter, setFilter] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const requestIdRef = useRef(0);
  const abortRef = useRef(null);
  const { currentTrack, playTrack } = usePlayer();

  useEffect(() => {
    const trimmed = filter.trim();
    if (!trimmed) {
      setDebouncedQuery('');
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(trimmed);
    }, 150);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (filter.trim() !== debouncedQuery) { setLoading(true); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');

    const offset = (page - 1) * safePageSize;
    const params = {
      limit: safePageSize,
      offset,
      sort: 'title',
      order: 'asc',
    };
    if (debouncedQuery) {
      params.q = debouncedQuery;
    }

    api
      .tracks(params, { signal: controller.signal })
      .then((res) => {
        if (reqId !== requestIdRef.current || controller.signal.aborted) return;
        const list = Array.isArray(res?.tracks) ? res.tracks.slice(0, safePageSize) : [];
        const totalCount = typeof res?.total === 'number' ? res.total : list.length;
        setTracks(list);
        setTotal(totalCount);
      })
      .catch((err) => {
        if (
          err?.name === 'AbortError' ||
          reqId !== requestIdRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setTracks([]);
        setTotal(0);
        setError(err.message || 'Unable to load tracks');
      })
      .finally(() => {
        if (reqId === requestIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [page, debouncedQuery, safePageSize, filter]);

  useEffect(() => () => { bulkAbortRef.current?.abort(); }, [filter]);

  const handleFilterChange = (e) => {
    const val = e.target.value;
    requestIdRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setFilter(val);
    setPage(1);
    if (!val.trim()) {
      setDebouncedQuery('');
    }
  };

  const fetchAllMatchingTracks = async (signal) => {
    const activeQuery = filter.trim();
    if (
      page === 1 &&
      activeQuery === debouncedQuery &&
      tracks.length > 0 &&
      tracks.length >= total
    ) {
      return tracks;
    }

    const allTracks =
      page === 1 && activeQuery === debouncedQuery && tracks.length > 0
        ? [...tracks]
        : [];
    let expectedTotal =
      page === 1 && activeQuery === debouncedQuery && total > 0 ? total : Infinity;

    while (allTracks.length < expectedTotal) {
      const params = {
        limit: safePageSize,
        offset: allTracks.length,
        sort: 'title',
        order: 'asc',
      };
      if (activeQuery) {
        params.q = activeQuery;
      }
      const res = await api.tracks(params, { signal });
      const batch = Array.isArray(res?.tracks) ? res.tracks : [];
      if (typeof res?.total === 'number') {
        expectedTotal = res.total;
      } else if (expectedTotal === Infinity) {
        expectedTotal = allTracks.length + batch.length;
      }
      if (batch.length === 0) break;
      allTracks.push(...batch);
      if (batch.length < safePageSize && allTracks.length >= expectedTotal) {
        break;
      }
    }

    return allTracks;
  };

  const handlePlayAll = async () => {
    if (total === 0 && tracks.length === 0) return;
    bulkAbortRef.current?.abort();
    const controller = new AbortController();
    bulkAbortRef.current = controller;
    setActionLoading(true);
    setError('');
    try {
      const allTracks = await fetchAllMatchingTracks(controller.signal);
      if (controller.signal.aborted) return;
      const availableTracks = allTracks.filter((t) => t.available !== false);
      if (availableTracks.length > 0) {
        playTrack(availableTracks[0], availableTracks);
      }
    } catch (err) {
      if (err.name !== 'AbortError' && !controller.signal.aborted) setError(err.message || 'Unable to load playback queue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleShufflePlay = async () => {
    if (total === 0 && tracks.length === 0) return;
    bulkAbortRef.current?.abort();
    const controller = new AbortController();
    bulkAbortRef.current = controller;
    setActionLoading(true);
    setError('');
    try {
      const allTracks = await fetchAllMatchingTracks(controller.signal);
      if (controller.signal.aborted) return;
      const availableTracks = allTracks.filter((t) => t.available !== false);
      if (availableTracks.length === 0) return;
      const shuffled = [...availableTracks].sort(() => Math.random() - 0.5);
      playTrack(shuffled[0], shuffled);
    } catch (err) {
      if (err.name !== 'AbortError' && !controller.signal.aborted) setError(err.message || 'Unable to load playback queue');
    } finally {
      setActionLoading(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const boundedTracks = tracks.slice(0, safePageSize);
  const startItem = total === 0 ? 0 : (page - 1) * safePageSize + 1;
  const endItem = total === 0 ? 0 : Math.min(total, (page - 1) * safePageSize + boundedTracks.length);

  return (
    <div className="space-y-6 animate-fade-in">
      {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
      {/* Header controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter tracks..."
            value={filter}
            onChange={handleFilterChange}
            className="glass-input w-full pl-9 pr-4 text-sm"
          />
        </div>

        <div className="flex items-center gap-3 self-end sm:self-auto">
          <button
            onClick={handlePlayAll}
            disabled={(total === 0 && boundedTracks.length === 0) || actionLoading}
            className="btn-primary py-2 px-4 text-xs shadow-glow"
          >
            <Play className="w-3.5 h-3.5 fill-surface-950" />
            <span>Play All</span>
          </button>
          <button
            onClick={handleShufflePlay}
            disabled={(total === 0 && boundedTracks.length === 0) || actionLoading}
            className="btn-glass py-2 px-3 text-xs"
          >
            <Shuffle className="w-3.5 h-3.5 text-accent" />
            <span>Shuffle</span>
          </button>
          <span className="text-surface-500 font-mono text-xs pl-1">
            ({total} songs)
          </span>
        </div>
      </div>

      {/* Table / Loading / Empty State */}
      {loading ? (
        <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs font-medium">Loading tracks library...</span>
        </div>
      ) : boundedTracks.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Music2 className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No tracks match your filter</p>
        </div>
      ) : (
        <>
          <div className="glass-panel rounded-3xl overflow-hidden border border-white/[0.06]">
            <div className="overflow-x-auto">
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
                  {boundedTracks.map((track, idx) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={(page - 1) * safePageSize + idx}
                      onPlay={(t) => playTrack(t, boundedTracks)}
                      isPlaying={currentTrack?.id === track.id}
                      user={user}
                      onEditTags={onEditTags}
                      onGoToAlbum={onGoToAlbum}
                      onGoToArtist={onGoToArtist}
                      onAddToPlaylist={onAddToPlaylist}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination Controls */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 text-xs text-surface-400">
            <span className="font-mono">
              Showing {startItem}–{endItem} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                aria-label="Previous page"
                className="btn-glass py-1.5 px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Previous</span>
              </button>
              <span className="font-mono px-2 text-surface-300">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || loading}
                aria-label="Next page"
                className="btn-glass py-1.5 px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <span>Next</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
