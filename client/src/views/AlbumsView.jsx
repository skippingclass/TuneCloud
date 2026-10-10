import { useState, useEffect, useMemo } from 'react';
import { Search, ArrowUpDown, Disc, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function AlbumsView({ onAlbumClick, onArtistClick }) {
  const [albums, setAlbums] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('title'); // 'title' | 'artist' | 'year' | 'tracks'
  const { playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    api
      .albums()
      .then(setAlbums)
      .finally(() => setLoading(false));
  }, []);

  const handlePlayAlbum = async (album) => {
    try {
      const tracks = await api.album(album.id);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
      }
    } catch {}
  };

  const filteredAndSorted = useMemo(() => {
    let result = albums;
    if (filter.trim()) {
      const q = filter.toLowerCase();
      result = result.filter(
        (a) =>
          (a.title || '').toLowerCase().includes(q) ||
          (a.artist || '').toLowerCase().includes(q) ||
          (a.genre || '').toLowerCase().includes(q)
      );
    }

    return [...result].sort((a, b) => {
      if (sortBy === 'artist') {
        return (a.artist || '').localeCompare(b.artist || '');
      }
      if (sortBy === 'year') {
        return (b.year || 0) - (a.year || 0);
      }
      if (sortBy === 'tracks') {
        return (b.track_count || 0) - (a.track_count || 0);
      }
      return (a.title || '').localeCompare(b.title || '');
    });
  }, [albums, filter, sortBy]);

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading albums...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Controls row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter albums by title, artist, genre..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="glass-input w-full pl-9 pr-4 text-sm"
          />
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto text-xs">
          <span className="text-surface-500 hidden sm:inline flex items-center gap-1">
            <ArrowUpDown className="w-3.5 h-3.5" /> Sort:
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="glass-pill bg-white/[0.04] text-surface-200 outline-none cursor-pointer"
          >
            <option value="title" className="bg-surface-900 text-white">Title (A-Z)</option>
            <option value="artist" className="bg-surface-900 text-white">Artist (A-Z)</option>
            <option value="year" className="bg-surface-900 text-white">Year (Newest)</option>
            <option value="tracks" className="bg-surface-900 text-white">Track Count</option>
          </select>
          <span className="text-surface-500 font-mono text-[11px] ml-1">
            ({filteredAndSorted.length})
          </span>
        </div>
      </div>

      {/* Grid */}
      {filteredAndSorted.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Disc className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No albums match your filter</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filteredAndSorted.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
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
