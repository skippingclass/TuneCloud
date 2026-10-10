import { useState, useEffect } from 'react';
import { Search, Disc, Users, Music2, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function SearchView({
  initialQuery = '',
  onAlbumClick,
  onArtistClick,
  user,
  onEditTags,
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const { currentTrack, playTrack } = usePlayer();

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .search(query)
        .then(setResults)
        .catch(console.error)
        .finally(() => setSearching(false));
    }, 280);

    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="relative max-w-xl">
        <Search className="w-5 h-5 text-surface-500 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title, artist, album, genre..."
          className="glass-input w-full pl-11 pr-4 py-3 text-base"
          autoFocus
        />
        {searching && (
          <Loader2 className="w-4 h-4 text-accent animate-spin absolute right-4 top-1/2 -translate-y-1/2" />
        )}
      </div>

      {results && (
        <div className="space-y-8">
          {/* Artists */}
          {results.artists.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-accent" />
                <span>Artists ({results.artists.length})</span>
              </h3>
              <div className="flex flex-wrap gap-2.5">
                {results.artists.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => onArtistClick?.(a)}
                    className="glass-pill px-4 py-2 hover:border-accent/40 hover:text-white flex items-center gap-2 text-xs font-semibold"
                  >
                    <span className="w-2 h-2 rounded-full bg-accent" />
                    <span>{a.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Albums */}
          {results.albums.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Disc className="w-4 h-4 text-accent" />
                <span>Albums ({results.albums.length})</span>
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {results.albums.map((album) => (
                  <AlbumCard
                    key={album.id}
                    album={album}
                    onClick={onAlbumClick}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Tracks */}
          {results.tracks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Music2 className="w-4 h-4 text-accent" />
                <span>Tracks ({results.tracks.length})</span>
              </h3>
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
                    {results.tracks.map((track, idx) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={idx}
                        onPlay={(t) => playTrack(t, results.tracks)}
                        isPlaying={currentTrack?.id === track.id}
                        user={user}
                        onEditTags={onEditTags}
                        onGoToAlbum={onAlbumClick}
                        onGoToArtist={onArtistClick}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {results.tracks.length === 0 &&
            results.albums.length === 0 &&
            results.artists.length === 0 && (
              <p className="text-surface-500 text-sm">
                No matching results found for "{query}"
              </p>
            )}
        </div>
      )}
    </div>
  );
}
