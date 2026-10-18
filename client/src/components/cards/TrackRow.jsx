import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, Heart, MoreVertical, Disc, User, Edit3, ListPlus, FolderPlus, Trash2 } from 'lucide-react';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { ArtistLinks } from '../common/ArtistLinks.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TrackRow({
  track,
  onPlay,
  isPlaying,
  index,
  displayIndex,
  user,
  onEditTags,
  onGoToAlbum,
  onGoToArtist,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  reorderControls,
  showAlbum = true,
  albumArtist = null,
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  const { addToQueue } = usePlayer();
  const starred = isTrackStarred(track.id);
  const canPlay = track.id != null;
  const isAdmin = user?.is_admin;
  const canEditTags = track.format?.toLowerCase() === 'mp3';

  const trackArtist = (track.artist || '').trim();
  const baseArtist = (albumArtist || '').trim();
  const isDifferentArtist = !albumArtist || (trackArtist.toLowerCase() !== baseArtist.toLowerCase());

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openMenu = (e) => {
    e.stopPropagation();
    const rect = btnRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setMenuOpen(!menuOpen);
  };

  const handleFavorite = (e) => {
    e.stopPropagation();
    toggleFavoriteTrack(track.id);
  };

  return (
    <tr
      className={`group transition-all duration-150 select-none ${
        canPlay ? 'hover:bg-white/[0.04] cursor-pointer' : ''
      } ${
        isPlaying
          ? 'bg-accent/10 text-accent font-medium shadow-[inset_0_0_20px_var(--theme-glow)]'
          : 'text-surface-200'
      }`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => canPlay && onPlay?.(track)}
    >
      {/* Track number / Play button */}
      <td className="px-3 sm:px-4 py-2.5 text-xs sm:text-sm w-12 text-center relative">
        <span
          className={`inline-flex items-center justify-center w-5 h-5 font-medium ${
            isPlaying ? 'text-accent' : 'text-surface-500'
          } ${hover && canPlay ? 'invisible' : ''}`}
        >
          {displayIndex != null ? displayIndex : (track.track_number || (index != null ? index + 1 : ''))}
        </span>
        {canPlay && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay?.(track);
            }}
            className={`absolute inset-0 flex items-center justify-center text-white hover:text-accent transition-colors ${
              hover ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current text-accent" />
            ) : (
              <Play className="w-4 h-4 fill-current text-white" />
            )}
          </button>
        )}
      </td>

      {/* Favorite Heart */}
      <td className="w-8 px-1 py-2 text-center">
        <button
          onClick={handleFavorite}
          className={`p-1 rounded transition-colors ${
            starred
              ? 'text-accent opacity-100'
              : 'text-surface-500 opacity-0 group-hover:opacity-100 hover:text-accent'
          }`}
          title={starred ? 'Unlike' : 'Like'}
        >
          <Heart className={`w-3.5 h-3.5 ${starred ? 'fill-accent' : ''}`} />
        </button>
      </td>

      {/* Title */}
      <td className="px-3 sm:px-4 py-2.5 text-xs sm:text-sm truncate max-w-xs font-medium">
        <span className={isPlaying ? 'text-accent font-semibold' : 'text-surface-100'}>
          {track.title || track.file_name}
        </span>
        {track.artist && isDifferentArtist && (
          <div className="sm:hidden text-[11px] text-surface-400 truncate mt-0.5">
            <ArtistLinks
              artist={track.artist}
              primaryArtistId={track.artist_id}
              onGoToArtist={onGoToArtist}
            />
          </div>
        )}
      </td>

      {/* Artist - only display if different from album artist or if albumArtist is not specified */}
      <td className="px-3 sm:px-4 py-2.5 text-xs sm:text-sm text-surface-400 truncate hidden sm:table-cell">
        {isDifferentArtist && track.artist ? (
          <ArtistLinks
            artist={track.artist}
            primaryArtistId={track.artist_id}
            onGoToArtist={onGoToArtist}
          />
        ) : albumArtist ? (
          <span className="text-surface-600">—</span>
        ) : (
          '—'
        )}
      </td>

      {/* Album (optional, hidden on album view) */}
      {showAlbum && (
        <td className="px-3 sm:px-4 py-2.5 text-xs sm:text-sm text-surface-400 truncate hidden md:table-cell">
          {track.album ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onGoToAlbum?.({
                  id: track.album_id,
                  title: track.album,
                  artist: track.artist,
                  cover_path: track.cover_path,
                });
              }}
              className="hover:underline hover:text-white cursor-pointer transition-colors"
              title={`Go to album: ${track.album}`}
            >
              {track.album}
            </span>
          ) : (
            '—'
          )}
        </td>
      )}

      {/* Duration */}
      <td className="px-3 sm:px-4 py-2.5 text-xs sm:text-sm text-surface-500 text-right font-mono hidden sm:table-cell">
        {formatDuration(track.duration)}
      </td>

      {/* Format */}
      <td className="px-2 py-2.5 text-[10px] text-surface-500 font-bold uppercase hidden lg:table-cell text-center">
        {track.format || ''}
      </td>

      {/* Optional reorder controls (used in playlist details) */}
      {reorderControls && (
        <td className="px-1 py-2 text-center w-14">
          {reorderControls}
        </td>
      )}

      {/* Context menu */}
      <td className="px-2 py-2.5 text-sm w-9 text-right">
        <button
          ref={btnRef}
          onClick={openMenu}
          className={`p-1.5 rounded-lg transition-colors text-surface-500 hover:text-white hover:bg-white/[0.06] ${
            menuOpen ? 'text-white bg-white/[0.08]' : ''
          }`}
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </td>

      {/* Context dropdown menu */}
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed glass-panel rounded-2xl py-1.5 min-w-[190px] z-[200] shadow-glass border border-white/[0.1] animate-fade-in"
            style={{ top: menuPos.top, right: menuPos.right }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                addToQueue(track);
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-200 hover:bg-white/[0.08] hover:text-white transition-colors"
            >
              <ListPlus className="w-3.5 h-3.5 text-accent" />
              <span>Add to Queue</span>
            </button>

            {onAddToPlaylist && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onAddToPlaylist(track);
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-200 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5 text-accent" />
                <span>Add to Playlist</span>
              </button>
            )}

            {onRemoveFromPlaylist && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onRemoveFromPlaylist(track);
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                <span>Remove from Playlist</span>
              </button>
            )}

            {track.album_id && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onGoToAlbum?.({
                    id: track.album_id,
                    title: track.album,
                    cover_path: track.cover_path,
                  });
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-200 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <Disc className="w-3.5 h-3.5 text-accent" />
                <span>Go to Album</span>
              </button>
            )}

            {track.artist && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onGoToArtist?.({ id: track.artist_id, name: track.artist });
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-200 hover:bg-white/[0.08] hover:text-white transition-colors"
              >
                <User className="w-3.5 h-3.5 text-accent" />
                <span>Go to Artist</span>
              </button>
            )}

            {isAdmin && canEditTags && (
              <>
                <div className="h-px bg-white/[0.06] my-1" />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onEditTags?.(track);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-surface-200 hover:bg-white/[0.08] hover:text-white transition-colors"
                >
                  <Edit3 className="w-3.5 h-3.5 text-accent" />
                  <span>Edit ID3 Tags</span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
    </tr>
  );
}
