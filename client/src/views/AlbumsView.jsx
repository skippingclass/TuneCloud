import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Search,
  ArrowUpDown,
  Disc,
  Loader2,
  LayoutGrid,
  Grid3X3,
  X,
  Filter,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { api } from '../api.js';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export const DEFAULT_ALBUMS_PAGE_SIZE = 48;

export function AlbumsView({ onAlbumClick, onArtistClick }) {
  const [albums, setAlbums] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedGenre, setSelectedGenre] = useState('all');
  const [selectedYear, setSelectedYear] = useState('all');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' | 'title_asc' | 'title_desc' | 'year_desc' | 'year_asc' | 'duration'
  const [genresList, setGenresList] = useState([]);

  const [density, setDensity] = useState(() => {
    return localStorage.getItem('tunecloud_albums_density') || 'standard';
  });

  const { playTrack } = usePlayer();
  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  // Load genres list once for filter dropdown
  useEffect(() => {
    api
      .genres()
      .then((res) => {
        const list = Array.isArray(res) ? res : [];
        setGenresList(list);
      })
      .catch(() => {});
  }, []);

  // Debounce search
  useEffect(() => {
    const trimmed = search.trim();
    const timer = setTimeout(() => {
      setDebouncedSearch(trimmed);
      setPage(1);
    }, 150);
    return () => clearTimeout(timer);
  }, [search]);

  // Load paginated albums from server
  useEffect(() => {
    const reqId = ++reqIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const offset = (page - 1) * DEFAULT_ALBUMS_PAGE_SIZE;
    const params = {
      limit: DEFAULT_ALBUMS_PAGE_SIZE,
      offset,
      sort: sortBy,
    };
    if (debouncedSearch) params.q = debouncedSearch;
    if (selectedGenre !== 'all') params.genre = selectedGenre;
    if (selectedYear !== 'all') params.year = selectedYear;

    api
      .albums(params, { signal: controller.signal })
      .then((res) => {
        if (reqId !== reqIdRef.current || controller.signal.aborted) return;
        const list = Array.isArray(res) ? res : (res?.albums || []);
        const totalCount = typeof res?.total === 'number' ? res.total : list.length;
        setAlbums(list);
        setTotal(totalCount);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setAlbums([]);
        setTotal(0);
      })
      .finally(() => {
        if (reqId === reqIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [page, debouncedSearch, selectedGenre, selectedYear, sortBy]);

  const handleDensityChange = (newDensity) => {
    setDensity(newDensity);
    localStorage.setItem('tunecloud_albums_density', newDensity);
  };

  const handlePlayAlbum = async (album) => {
    try {
      const res = await api.album(album.id);
      const rawTracks = res?.tracks || (Array.isArray(res) ? res : []);
      const tracks = rawTracks.filter((t) => t.available !== false);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
      }
    } catch {}
  };

  const resetFilters = () => {
    setSearch('');
    setDebouncedSearch('');
    setSelectedGenre('all');
    setSelectedYear('all');
    setSortBy('recent');
    setPage(1);
  };

  const hasActiveFilters =
    search.trim() !== '' ||
    selectedGenre !== 'all' ||
    selectedYear !== 'all' ||
    sortBy !== 'recent';

  const totalPages = Math.ceil(total / DEFAULT_ALBUMS_PAGE_SIZE) || 1;

  // Generate a list of recent years for dropdown filter
  const recentYears = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const list = [];
    for (let y = currentYear; y >= 1960; y -= 1) {
      list.push(y);
    }
    return list;
  }, []);

  return (
    <div className="space-y-6 animate-fade-in pb-12">
      {/* Top Filter and Search Bar */}
      <div className="glass-panel p-4 sm:p-5 rounded-3xl border border-white/[0.08] space-y-4">
        <div className="flex flex-col lg:flex-row gap-3 items-stretch lg:items-center justify-between">
          {/* Search box */}
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Search albums by title or artist..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="glass-input w-full pl-9 pr-8 text-xs sm:text-sm py-2"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-500 hover:text-white p-0.5"
                title="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filters & Sorting controls */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Genre selector */}
            <div className="flex items-center gap-1.5 text-xs">
              <Filter className="w-3.5 h-3.5 text-surface-500 hidden sm:inline" />
              <select
                value={selectedGenre}
                onChange={(e) => {
                  setSelectedGenre(e.target.value);
                  setPage(1);
                }}
                className="glass-input text-xs py-2 px-2.5 rounded-xl border-white/[0.1] bg-surface-900/90"
              >
                <option value="all">All Genres</option>
                {genresList.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>

            {/* Year selector */}
            <div className="flex items-center gap-1.5 text-xs">
              <select
                value={selectedYear}
                onChange={(e) => {
                  setSelectedYear(e.target.value);
                  setPage(1);
                }}
                className="glass-input text-xs py-2 px-2.5 rounded-xl border-white/[0.1] bg-surface-900/90"
              >
                <option value="all">All Years</option>
                {recentYears.slice(0, 40).map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>

            {/* Sort selector */}
            <div className="flex items-center gap-1.5 text-xs">
              <ArrowUpDown className="w-3.5 h-3.5 text-surface-500 hidden sm:inline" />
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  setPage(1);
                }}
                className="glass-input text-xs py-2 px-2.5 rounded-xl border-white/[0.1] bg-surface-900/90"
              >
                <option value="recent">Recently Added</option>
                <option value="title_asc">Title (A to Z)</option>
                <option value="title_desc">Title (Z to A)</option>
                <option value="year_desc">Year (Newest)</option>
                <option value="year_asc">Year (Oldest)</option>
                <option value="duration">Longest Duration</option>
                <option value="play_count">Most Played</option>
              </select>
            </div>

            {/* Reset button */}
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="btn-glass text-xs py-2 px-3 rounded-xl text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors"
                title="Reset all filters"
              >
                Reset
              </button>
            )}

            {/* Density switcher */}
            <div className="flex items-center gap-1 p-1 rounded-xl glass-panel border border-white/[0.08] ml-auto">
              <button
                onClick={() => handleDensityChange('standard')}
                className={`p-1.5 rounded-lg transition-all ${
                  density === 'standard'
                    ? 'bg-accent/20 text-accent shadow-glow'
                    : 'text-surface-400 hover:text-white'
                }`}
                title="Standard Grid"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDensityChange('compact')}
                className={`p-1.5 rounded-lg transition-all ${
                  density === 'compact'
                    ? 'bg-accent/20 text-accent shadow-glow'
                    : 'text-surface-400 hover:text-white'
                }`}
                title="Compact Grid"
              >
                <Grid3X3 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Grid Content */}
      {loading ? (
        <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs font-medium">Loading albums...</span>
        </div>
      ) : albums.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-3 text-surface-500">
          <Disc className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No albums match your filter</p>
          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="btn-glass text-xs py-1.5 px-3 rounded-xl mt-1 text-accent"
            >
              Clear Filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={
              density === 'compact'
                ? 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-2.5 sm:gap-3'
                : 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
            }
          >
            {albums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                compact={density === 'compact'}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-2 py-3 text-xs text-surface-400">
              <span>
                Showing {(page - 1) * DEFAULT_ALBUMS_PAGE_SIZE + 1}–
                {Math.min(page * DEFAULT_ALBUMS_PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                  title="Previous Page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-mono px-2 font-medium text-surface-200">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
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
