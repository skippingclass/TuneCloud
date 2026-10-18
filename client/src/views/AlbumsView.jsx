import { useState, useEffect, useMemo } from 'react';
import {
  Search,
  ArrowUpDown,
  Disc,
  Loader2,
  LayoutGrid,
  Grid3X3,
  X,
  Shuffle,
  Filter,
} from 'lucide-react';
import { api } from '../api.js';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function AlbumsView({ onAlbumClick, onArtistClick }) {
  const [albums, setAlbums] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedGenre, setSelectedGenre] = useState('all');
  const [selectedYear, setSelectedYear] = useState('all');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' | 'title_asc' | 'title_desc' | 'year_desc' | 'year_asc' | 'duration' | 'random'
  const [randomSeed, setRandomSeed] = useState(0);
  const [density, setDensity] = useState(() => {
    return localStorage.getItem('tunecloud_albums_density') || 'standard';
  });

  const { playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    api
      .albums()
      .then(setAlbums)
      .finally(() => setLoading(false));
  }, []);

  const handleDensityChange = (newDensity) => {
    setDensity(newDensity);
    localStorage.setItem('tunecloud_albums_density', newDensity);
  };

  const handlePlayAlbum = async (album) => {
    try {
      const tracks = await api.album(album.id);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
      }
    } catch {}
  };

  // Extract unique genres
  const availableGenres = useMemo(() => {
    const set = new Set();
    albums.forEach((a) => {
      if (a.genre && typeof a.genre === 'string') {
        a.genre
          .split(/[,/]/)
          .map((g) => g.trim())
          .filter(Boolean)
          .forEach((g) => set.add(g));
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [albums]);

  // Extract unique years
  const availableYears = useMemo(() => {
    const set = new Set();
    albums.forEach((a) => {
      if (a.year && Number.isInteger(a.year) && a.year > 1900) {
        set.add(a.year);
      }
    });
    return Array.from(set).sort((a, b) => b - a);
  }, [albums]);

  // Filter & Sort
  const filteredAndSorted = useMemo(() => {
    let result = albums;

    // Search query filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (a) =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.artist || '').toLowerCase().includes(q) ||
          (a.genre || '').toLowerCase().includes(q)
      );
    }

    // Genre filter
    if (selectedGenre !== 'all') {
      const gQuery = selectedGenre.toLowerCase();
      result = result.filter((a) =>
        (a.genre || '').toLowerCase().includes(gQuery)
      );
    }

    // Year filter
    if (selectedYear !== 'all') {
      const yVal = parseInt(selectedYear, 10);
      result = result.filter((a) => a.year === yVal);
    }

    // Sorting
    const sorted = [...result];
    if (sortBy === 'recent') {
      sorted.sort((a, b) => {
        if (b.created_at && a.created_at) {
          return new Date(b.created_at) - new Date(a.created_at);
        }
        return (b.id || 0) - (a.id || 0);
      });
    } else if (sortBy === 'title_asc') {
      sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (sortBy === 'title_desc') {
      sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    } else if (sortBy === 'year_desc') {
      sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
    } else if (sortBy === 'year_asc') {
      sorted.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    } else if (sortBy === 'duration') {
      sorted.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    } else if (sortBy === 'random') {
      // Deterministic shuffle with randomSeed
      sorted.sort((a, b) => {
        const hashA = ((a.id * 9301 + 49297 + randomSeed) % 233280) / 233280;
        const hashB = ((b.id * 9301 + 49297 + randomSeed) % 233280) / 233280;
        return hashA - hashB;
      });
    }

    return sorted;
  }, [albums, search, selectedGenre, selectedYear, sortBy, randomSeed]);

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading albums...</span>
      </div>
    );
  }

  const isFiltered =
    search.trim() !== '' || selectedGenre !== 'all' || selectedYear !== 'all';

  const resetFilters = () => {
    setSearch('');
    setSelectedGenre('all');
    setSelectedYear('all');
  };

  return (
    <div className="animate-fade-in space-y-6">
      {/* Sticky & Sleek Toolbar */}
      <div className="sticky top-0 z-20 -mx-4 sm:-mx-7 px-4 sm:px-7 py-3 -mt-4 sm:-mt-7 bg-surface-950/85 backdrop-blur-xl border-b border-white/[0.08] transition-all">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3.5">
          {/* Left: Heading & Total Counter */}
          <div className="flex items-center gap-3 shrink-0">
            <h1 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">
              Albums
            </h1>
            <span className="px-2.5 py-0.5 rounded-full bg-accent/15 border border-accent/30 text-accent font-mono text-xs font-semibold">
              {filteredAndSorted.length}
            </span>
            {isFiltered && (
              <button
                onClick={resetFilters}
                className="text-[11px] text-surface-400 hover:text-rose-400 flex items-center gap-1 transition-colors"
                title="Reset all filters"
              >
                <X className="w-3 h-3" />
                <span>Reset</span>
              </button>
            )}
          </div>

          {/* Right: Controls & Filters */}
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {/* Search Input */}
            <div className="relative min-w-[160px] sm:min-w-[200px] flex-1 sm:flex-initial">
              <Search className="w-3.5 h-3.5 text-surface-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Filter albums..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="glass-input w-full pl-8 pr-7 py-1.5 text-xs rounded-xl"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-surface-400 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Genre Filter */}
            {availableGenres.length > 0 && (
              <div className="flex items-center">
                <select
                  value={selectedGenre}
                  onChange={(e) => setSelectedGenre(e.target.value)}
                  className="glass-pill bg-white/[0.04] text-surface-200 outline-none cursor-pointer py-1.5 px-3 rounded-xl border border-white/[0.08] hover:border-white/[0.15]"
                >
                  <option value="all" className="bg-surface-900 text-white">
                    All Genres
                  </option>
                  {availableGenres.map((g) => (
                    <option key={g} value={g} className="bg-surface-900 text-white">
                      {g}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Year Filter */}
            {availableYears.length > 0 && (
              <div className="flex items-center">
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(e.target.value)}
                  className="glass-pill bg-white/[0.04] text-surface-200 outline-none cursor-pointer py-1.5 px-3 rounded-xl border border-white/[0.08] hover:border-white/[0.15]"
                >
                  <option value="all" className="bg-surface-900 text-white">
                    All Years
                  </option>
                  {availableYears.map((y) => (
                    <option key={y} value={y} className="bg-surface-900 text-white">
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Sort Select */}
            <div className="flex items-center gap-1.5">
              <select
                value={sortBy}
                onChange={(e) => {
                  setSortBy(e.target.value);
                  if (e.target.value === 'random') {
                    setRandomSeed((s) => s + 1);
                  }
                }}
                className="glass-pill bg-white/[0.04] text-surface-200 outline-none cursor-pointer py-1.5 px-3 rounded-xl border border-white/[0.08] hover:border-white/[0.15]"
              >
                <option value="recent" className="bg-surface-900 text-white">
                  Recently Added
                </option>
                <option value="title_asc" className="bg-surface-900 text-white">
                  Alphabetical (A-Z)
                </option>
                <option value="title_desc" className="bg-surface-900 text-white">
                  Alphabetical (Z-A)
                </option>
                <option value="year_desc" className="bg-surface-900 text-white">
                  Release Year (Newest)
                </option>
                <option value="year_asc" className="bg-surface-900 text-white">
                  Release Year (Oldest)
                </option>
                <option value="duration" className="bg-surface-900 text-white">
                  Duration
                </option>
                <option value="random" className="bg-surface-900 text-white">
                  Random
                </option>
              </select>

              {sortBy === 'random' && (
                <button
                  onClick={() => setRandomSeed((s) => s + 1)}
                  className="btn-glass p-1.5 rounded-xl text-surface-400 hover:text-accent"
                  title="Re-shuffle"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Density Switch */}
            <div className="flex items-center rounded-xl bg-white/[0.04] border border-white/[0.08] p-0.5">
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
      {filteredAndSorted.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-3 text-surface-500">
          <Disc className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No albums match your filter</p>
          <button
            onClick={resetFilters}
            className="btn-glass text-xs py-1.5 px-3 rounded-xl mt-1 text-accent"
          >
            Clear Filters
          </button>
        </div>
      ) : (
        <div
          className={
            density === 'compact'
              ? 'grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-2.5 sm:gap-3'
              : 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4'
          }
        >
          {filteredAndSorted.map((album) => (
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
      )}
    </div>
  );
}
