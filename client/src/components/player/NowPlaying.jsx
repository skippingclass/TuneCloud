import { createPortal } from 'react-dom';
import {
  ChevronDown,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Heart,
  ListMusic,
  Mic2,
  Disc,
  Moon,
} from 'lucide-react';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { useDialog } from '../../hooks/useDialog.js';
import { api } from '../../api.js';

const time = (s) =>
  `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, '0')}`;
export function SleepTimer({ className = '' }) {
  const { sleepUntil, setSleepTimer } = usePlayer();
  return (
    <label
      className={`inline-flex items-center gap-2 text-xs ${sleepUntil ? 'text-accent' : 'text-surface-400'} ${className}`}
    >
      <Moon size={16} aria-hidden="true" />
      <select
        aria-label="Sleep timer"
        value={sleepUntil === 'track' ? 'track' : typeof sleepUntil === 'number' ? 'active' : 'off'}
        onChange={(e) => setSleepTimer(e.target.value)}
        className="bg-transparent text-inherit rounded-lg py-2 outline-none"
      >
        <option value="off">Sleep timer off</option>
        {typeof sleepUntil === 'number' && (
          <option value="active">
            Until{' '}
            {new Date(sleepUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </option>
        )}
        <option value="15">15 minutes</option>
        <option value="30">30 minutes</option>
        <option value="60">60 minutes</option>
        <option value="track">After this track</option>
      </select>
    </label>
  );
}

export function NowPlaying({ onGoToAlbum, onGoToArtist }) {
  const {
    currentTrack: track,
    isPlaying,
    togglePlay,
    next,
    prev,
    hasNext,
    hasPrev,
    currentTime,
    duration,
    seek,
    shuffle,
    toggleShuffle,
    repeat,
    toggleRepeat,
    isNowPlayingOpen,
    setIsNowPlayingOpen,
    setIsLyricsOpen,
    setIsQueueOpen,
  } = usePlayer();
  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  const ref = useDialog(isNowPlayingOpen && Boolean(track), () => setIsNowPlayingOpen(false));
  if (!isNowPlayingOpen || !track) return null;
  const starred = isTrackStarred(track.id);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      tabIndex={-1}
      className="now-playing fixed inset-0 z-[90] overflow-y-auto bg-surface-950 text-surface-100"
    >
      <div className="now-playing-content max-w-lg mx-auto p-6 flex flex-col min-h-full gap-6">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setIsNowPlayingOpen(false)}
            aria-label="Collapse player"
            className="p-3 text-surface-400"
          >
            <ChevronDown size={24} />
          </button>
          <span className="text-xs uppercase tracking-widest text-surface-500">Now playing</span>
          <button
            onClick={() => toggleFavoriteTrack(track.id)}
            aria-label={starred ? 'Unlike track' : 'Like track'}
            aria-pressed={starred}
            className="p-3"
          >
            <Heart size={22} className={starred ? 'fill-accent text-accent' : 'text-surface-400'} />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="now-playing-art w-full max-w-[360px] aspect-square rounded-3xl overflow-hidden bg-white/5 shadow-2xl">
            {track.cover_path ? (
              <img
                src={api.coverUrl(track.cover_path)}
                alt={`Cover of ${track.album || track.title}`}
                className="w-full h-full object-cover"
              />
            ) : (
              <Disc className="w-1/2 h-full mx-auto text-surface-600" />
            )}
          </div>
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold leading-tight break-words">
            {track.title || track.file_name}
          </h1>
          <button
            className="text-surface-400 text-sm hover:text-white"
            onClick={() => {
              onGoToArtist?.({ id: track.artist_id, name: track.artist });
              setIsNowPlayingOpen(false);
            }}
          >
            {track.artist || 'Unknown artist'}
          </button>
          {track.album && (
            <button
              className="block text-xs text-surface-500 hover:text-white"
              onClick={() => {
                onGoToAlbum?.({ id: track.album_id, title: track.album });
                setIsNowPlayingOpen(false);
              }}
            >
              {track.album}
            </button>
          )}
        </div>
        <div>
          <input
            aria-label="Playback position"
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            className="w-full accent-accent h-6"
          />
          <div className="flex justify-between text-xs text-surface-400 tabular-nums">
            <span>{time(currentTime)}</span>
            <span>{time(duration)}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={toggleShuffle}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            className={`p-3 ${shuffle ? 'text-accent' : 'text-surface-400'}`}
          >
            <Shuffle size={21} />
          </button>
          <button
            onClick={prev}
            disabled={!hasPrev}
            aria-label="Previous track"
            className="p-3 disabled:opacity-25"
          >
            <SkipBack size={28} />
          </button>
          <button
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="w-16 h-16 rounded-full bg-accent text-surface-950 flex items-center justify-center"
          >
            {isPlaying ? (
              <Pause size={28} fill="currentColor" />
            ) : (
              <Play size={28} fill="currentColor" />
            )}
          </button>
          <button
            onClick={next}
            disabled={!hasNext}
            aria-label="Next track"
            className="p-3 disabled:opacity-25"
          >
            <SkipForward size={28} />
          </button>
          <button
            onClick={toggleRepeat}
            aria-label={`Repeat: ${repeat}`}
            aria-pressed={repeat !== 'none'}
            className={`p-3 relative ${repeat !== 'none' ? 'text-accent' : 'text-surface-400'}`}
          >
            <Repeat size={21} />
            {repeat === 'one' && <span className="absolute top-0 right-1 text-xs">1</span>}
          </button>
        </div>
        <div className="flex justify-between items-center gap-3">
          <SleepTimer />
          <div className="flex">
            <button
              onClick={() => setIsLyricsOpen(true)}
              aria-label="Open lyrics"
              className="p-3 text-surface-400"
            >
              <Mic2 size={20} />
            </button>
            <button
              onClick={() => {
                setIsNowPlayingOpen(false);
                setIsQueueOpen(true);
              }}
              aria-label="Open queue"
              className="p-3 text-surface-400"
            >
              <ListMusic size={20} />
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
