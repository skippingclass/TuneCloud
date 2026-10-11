import { Play, Pause, Heart, Disc } from 'lucide-react';
import { api } from '../../api.js';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { usePlayer } from '../../context/PlayerContext.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AlbumCard({ album, onClick, onPlay, onArtistClick }) {
  const { isAlbumStarred, toggleFavoriteAlbum } = useFavorites();
  const { currentTrack, isPlaying, togglePlay } = usePlayer();
  const starred = isAlbumStarred(album.id);

  const isCurrentAlbum =
    currentTrack &&
    (currentTrack.album_id === album.id ||
      (album.title && currentTrack.album === album.title));
  const isCurrentAlbumPlaying = isCurrentAlbum && isPlaying;

  const handleFavoriteClick = (e) => {
    e.stopPropagation();
    toggleFavoriteAlbum(album.id);
  };

  const handlePlayClick = (e) => {
    e.stopPropagation();
    if (isCurrentAlbum) {
      togglePlay();
    } else {
      onPlay?.(album);
    }
  };

  return (
    <div
      onClick={() => onClick?.(album)}
      className="glass-card group p-3 text-left cursor-pointer select-none flex flex-col justify-between"
    >
      {/* Artwork container */}
      <div className="aspect-square w-full rounded-xl overflow-hidden bg-surface-900 relative mb-3 ring-1 ring-white/[0.08] shadow-md">
        {album.cover_path ? (
          <img
            src={api.coverUrl(album.cover_path)}
            alt={album.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            draggable="false"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/[0.02]">
            <Disc className="w-12 h-12 text-surface-600 stroke-1" />
          </div>
        )}

        {/* Favorite heart overlay (top right) */}
        <button
          onClick={handleFavoriteClick}
          className={`absolute top-2 right-2 p-2 rounded-full glass-panel transition-all duration-200 z-10 ${
            starred
              ? 'opacity-100 text-accent scale-100'
              : 'opacity-0 group-hover:opacity-100 text-white/80 hover:text-accent hover:scale-110'
          }`}
          title={starred ? 'Unlike' : 'Like'}
        >
          <Heart className={`w-3.5 h-3.5 ${starred ? 'fill-accent' : ''}`} />
        </button>

        {/* Play / Pause button overlay (bottom right) */}
        {onPlay && (
          <button
            onClick={handlePlayClick}
            className={`absolute bottom-2.5 right-2.5 w-10 h-10 rounded-full bg-gradient-to-r from-accent to-accent-hover text-surface-950 flex items-center justify-center shadow-glow transition-all duration-300 hover:scale-110 z-10 ${
              isCurrentAlbum
                ? 'opacity-100 translate-y-0 scale-100'
                : 'opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0'
            }`}
            title={
              isCurrentAlbumPlaying
                ? 'Pause Album'
                : isCurrentAlbum
                ? 'Resume Album'
                : 'Play Album'
            }
          >
            {isCurrentAlbumPlaying ? (
              <Pause className="w-4 h-4 fill-surface-950" />
            ) : (
              <Play className="w-4 h-4 fill-surface-950 ml-0.5" />
            )}
          </button>
        )}
      </div>

      {/* Album info */}
      <div className="px-0.5">
        <h3 className="text-sm font-semibold truncate text-surface-100 group-hover:text-accent transition-colors">
          {album.title}
        </h3>
        <p
          onClick={(e) => {
            if (album.artist && onArtistClick) {
              e.stopPropagation();
              onArtistClick({ id: album.artist_id, name: album.artist });
            }
          }}
          className={`text-xs text-surface-400 truncate mt-0.5 ${
            album.artist && onArtistClick ? 'hover:underline hover:text-white cursor-pointer' : ''
          }`}
          title={album.artist ? `Go to artist: ${album.artist}` : ''}
        >
          {album.artist || 'Unknown Artist'}
        </p>
        <div className="flex items-center justify-between text-[11px] text-surface-500 mt-2 font-medium">
          <span>{album.year || (album.track_count ? `${album.track_count} tracks` : '')}</span>
          {album.duration > 0 && <span>{formatDuration(album.duration)}</span>}
        </div>
      </div>
    </div>
  );
}
