import { Play, Pause, Heart, Disc } from 'lucide-react';
import { api } from '../../api.js';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { ArtistLinks } from '../common/ArtistLinks.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AlbumCard({ album, onClick, onPlay, onArtistClick, compact = false }) {
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
      className={`shelf-album glass-card group text-left cursor-pointer select-none flex flex-col justify-between ${
        compact ? 'p-2 rounded-xl' : 'p-3 rounded-2xl'
      }`}
    >
      {/* Artwork container */}
      <div
        className={`aspect-square w-full rounded-xl overflow-hidden bg-surface-900 relative ring-1 ring-white/[0.08] shadow-md ${
          compact ? 'mb-2' : 'mb-3'
        }`}
      >
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
            <Disc className={`${compact ? 'w-8 h-8' : 'w-12 h-12'} text-surface-600 stroke-1`} />
          </div>
        )}

        {/* Favorite heart overlay (top right) */}
        <button
          onClick={handleFavoriteClick}
          className={`absolute top-2 right-2 rounded-full glass-panel transition-all duration-200 z-10 ${
            compact ? 'p-1.5' : 'p-2'
          } ${
            starred
              ? 'opacity-100 text-accent scale-100'
              : 'opacity-0 group-hover:opacity-100 text-white/80 hover:text-accent hover:scale-110'
          }`}
          title={starred ? 'Unlike' : 'Like'}
        >
          <Heart className={`${compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} ${starred ? 'fill-accent' : ''}`} />
        </button>

        {/* Play / Pause button overlay (bottom right) */}
        {onPlay && (
          <button
            onClick={handlePlayClick}
            className={`absolute bottom-2.5 right-2.5 rounded-full bg-gradient-to-r from-accent to-accent-hover text-surface-950 flex items-center justify-center shadow-glow transition-all duration-300 hover:scale-110 z-10 ${
              compact ? 'w-8 h-8' : 'w-10 h-10'
            } ${
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
              <Pause className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} fill-surface-950`} />
            ) : (
              <Play className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} fill-surface-950 ml-0.5`} />
            )}
          </button>
        )}
      </div>

      {/* Album info */}
      <div className="px-0.5 min-w-0">
        <h3
          className={`font-semibold truncate text-surface-100 group-hover:text-accent transition-colors ${
            compact ? 'text-xs' : 'text-sm'
          }`}
        >
          {album.title}
        </h3>
        <p className={`text-surface-400 truncate mt-0.5 ${compact ? 'text-[11px]' : 'text-xs'}`}>
          <ArtistLinks
            artist={album.artist}
            primaryArtistId={album.artist_id}
            onGoToArtist={onArtistClick}
          />
        </p>
        <div className="flex items-center justify-between text-[11px] text-surface-500 mt-2 font-medium">
          <span className="truncate">{album.year || (album.track_count ? `${album.track_count} tracks` : '')}</span>
          {album.duration > 0 && <span className="shrink-0 ml-1">{formatDuration(album.duration)}</span>}
        </div>
      </div>
    </div>
  );
}
