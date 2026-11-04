import { useState, useEffect, useRef } from 'react';
import { Search, Disc, Users, Music2, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function SearchView({
  initialQuery = '',
  onQueryChange,
  onAlbumClick,
  onArtistClick,
  user,
  onEditTags,
  onAddToPlaylist,
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [tab, setTab] = useState('all');
  const requestIdRef = useRef(0);
  const abortRef = useRef(null);
  const { currentTrack, playTrack } = usePlayer();

  useEffect(() => {
    setQuery(initialQuery || '');
  }, [initialQuery]);

  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    setError(false);
    const q = query.trim();
    if (!q) {
      setResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      api
        .search(q, { signal: controller.signal })
        .then((data) => {
          if (reqId !== requestIdRef.current || controller.signal.aborted) return;
          setResults({
            tracks: Array.isArray(data?.tracks) ? data.tracks : [],
            albums: Array.isArray(data?.albums) ? data.albums : [],
            artists: Array.isArray(data?.artists) ? data.artists : [],
          });
        })
        .catch((err) => {
          if (
            err?.name === 'AbortError' ||
            reqId !== requestIdRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          setResults(null);
          setError(true);
        })
        .finally(() => {
          if (reqId === requestIdRef.current && !controller.signal.aborted) {
            setSearching(false);
          }
        });
    }, 280);

    return () => {
      clearTimeout(timer);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [query, retry]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
      {!onQueryChange && <div className="relative w-full max-w-xl">
        <Search className="w-5 h-5 text-surface-500 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search library"
          placeholder="Search by title, artist, album, genre..."
          className="glass-input w-full pl-11 pr-4 py-3 text-base"
          autoFocus
        />
        {searching && (
          <Loader2 className="w-4 h-4 text-accent animate-spin absolute right-4 top-1/2 -translate-y-1/2" />
        )}
      </div>}
        <div className="flex gap-1" aria-label="Search categories">
          {['all', 'tracks', 'albums', 'artists'].map((value) => (
            <button key={value} onClick={() => setTab(value)} aria-pressed={tab === value}
              className={`px-3 py-2 rounded-full text-xs capitalize transition-colors ${tab === value ? 'bg-white/10 text-white' : 'text-surface-400 hover:text-white'}`}>{value}</button>
          ))}
        </div>
        <div className="ml-auto min-h-8 flex items-center gap-2 text-[11px] text-surface-500" role="status" aria-live="polite">
          {searching ? <><Loader2 className="w-3 h-3 animate-spin" /> Searching library</> : error ? <>
            <WifiOff className="w-3 h-3" /><span>Search unavailable</span>
            <button onClick={() => setRetry((v) => v + 1)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md hover:bg-white/5 hover:text-surface-200" aria-label="Retry search"><RefreshCw className="w-3 h-3" /> Retry</button>
          </> : query.trim() && results ? 'Results from your library' : null}
        </div>
      </div>
      {!query.trim() && <p className="text-sm text-surface-500">Find a song, album or artist in your library.</p>}
      {results && !searching && !error && (
        <div className="space-y-8">
          {/* Artists */}
          {(tab === 'all' || tab === 'artists') && results.artists.length > 0 && (
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
          {(tab === 'all' || tab === 'albums') && results.albums.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Disc className="w-4 h-4 text-accent" />
                <span>Albums ({results.albums.length})</span>
              </h3>
              <div className="album-grid">
                {results.albums.map((album) => (
                  <AlbumCard
                    key={album.id}
                    album={album}
                    onClick={onAlbumClick}
                    onArtistClick={onArtistClick}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Tracks */}
          {(tab === 'all' || tab === 'tracks') && results.tracks.length > 0 && (
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
                        onAddToPlaylist={onAddToPlaylist}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {(tab === 'all' ? Object.values(results).every((list) => list.length === 0) : results[tab].length === 0) && (
              <p className="text-surface-500 text-sm">
                No matching results found for "{query}"
              </p>
            )}
        </div>
      )}
    </div>
  );
}
