import { useState, useEffect } from 'react';
import { Heart, Play, Shuffle, Disc, Music2, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';

export function FavoritesView({
  user,
  onAlbumClick,
  onGoToArtist,
  onEditTags,
  onAddToPlaylist,
}) {
  const [tab, setTab] = useState('tracks'); // 'tracks' | 'albums'
  const [favorites, setFavorites] = useState({ tracks: [], albums: [] });
  const [loading, setLoading] = useState(true);
  const { currentTrack, playTrack } = usePlayer();
  const { starredTrackIds, starredAlbumIds } = useFavorites();

  const reloadFavorites = () => {
    setLoading(true);
    api
      .favorites()
      .then(setFavorites)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reloadFavorites();
  }, [starredTrackIds.size, starredAlbumIds.size]);

  const handlePlayAll = () => {
    if (favorites.tracks.length > 0) {
      playTrack(favorites.tracks[0], favorites.tracks);
    }
  };

  const handleShufflePlay = () => {
    if (favorites.tracks.length === 0) return;
    const shuffled = [...favorites.tracks].sort(() => Math.random() - 0.5);
    playTrack(shuffled[0], shuffled);
  };

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading your favorites...</span>
      </div>
    );
  }

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
              {favorites.tracks.length} liked tracks · {favorites.albums.length} liked albums
            </p>
          </div>
        </div>

        {tab === 'tracks' && favorites.tracks.length > 0 && (
          <div className="flex items-center gap-2.5">
            <button
              onClick={handlePlayAll}
              className="btn-primary py-2.5 px-5 text-xs shadow-glow"
            >
              <Play className="w-4 h-4 fill-surface-950" />
              <span>Play All</span>
            </button>
            <button
              onClick={handleShufflePlay}
              className="btn-glass py-2.5 px-4 text-xs"
            >
              <Shuffle className="w-4 h-4 text-accent" />
              <span>Shuffle</span>
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] pb-2">
        <button
          onClick={() => setTab('tracks')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
            tab === 'tracks'
              ? 'bg-accent/15 text-accent border border-accent/25 shadow-glow'
              : 'text-surface-400 hover:text-white'
          }`}
        >
          <Music2 className="w-3.5 h-3.5" />
          <span>Liked Tracks ({favorites.tracks.length})</span>
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
          <span>Liked Albums ({favorites.albums.length})</span>
        </button>
      </div>

      {/* Content */}
      {tab === 'tracks' ? (
        favorites.tracks.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
            <Heart className="w-10 h-10 stroke-1 opacity-40" />
            <p className="text-sm font-semibold">No favorite tracks yet</p>
            <p className="text-xs text-surface-600">Click the heart icon on any song to add it here</p>
          </div>
        ) : (
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
                {favorites.tracks.map((track, idx) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={idx}
                    onPlay={(t) => playTrack(t, favorites.tracks)}
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
        )
      ) : favorites.albums.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Disc className="w-10 h-10 stroke-1 opacity-40" />
          <p className="text-sm font-semibold">No favorite albums yet</p>
          <p className="text-xs text-surface-600">Like an album to find it here quickly</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {favorites.albums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              onClick={onAlbumClick}
              onArtistClick={onGoToArtist}
            />
          ))}
        </div>
      )}
    </div>
  );
}
