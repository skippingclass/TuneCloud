import { useState } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Volume2,
  VolumeX,
  Heart,
  ListMusic,
  Mic2,
  X,
  Disc,
  Maximize2,
} from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { CoverModal } from '../modals/CoverModal.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Player() {
  const {
    currentTrack,
    isPlaying,
    currentTime,
    duration,
    volume,
    muted,
    repeat,
    shuffle,
    isLyricsOpen,
    setIsLyricsOpen,
    isQueueOpen,
    setIsQueueOpen,
    togglePlay,
    seek,
    next,
    prev,
    setVolume,
    toggleMute,
    toggleRepeat,
    toggleShuffle,
    clearQueue,
    hasNext,
    hasPrev,
  } = usePlayer();

  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  const [showFullCover, setShowFullCover] = useState(false);

  if (!currentTrack) return null;

  const starred = isTrackStarred(currentTrack.id);
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleSeekClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    seek(pct * duration);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#0a0b12]/85 backdrop-blur-3xl border-t border-white/[0.08] shadow-glass px-4 sm:px-6 select-none pb-safe animate-slide-up">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3 sm:gap-6 h-20">
        {/* Left: Track artwork & metadata */}
        <div className="flex items-center gap-3 sm:gap-4 min-w-0 w-52 sm:w-72 shrink-0">
          <div
            onClick={() => currentTrack.cover_path && setShowFullCover(true)}
            className={`w-12 h-12 sm:w-14 sm:h-14 rounded-xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.1] shadow-md relative group ${
              currentTrack.cover_path ? 'cursor-pointer' : ''
            }`}
            title={currentTrack.cover_path ? 'Click to view full cover' : ''}
          >
            {currentTrack.cover_path ? (
              <>
                <img
                  src={api.coverUrl(currentTrack.cover_path)}
                  alt=""
                  className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                  draggable="false"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                  <Maximize2 className="w-4 h-4 text-white drop-shadow-md" />
                </div>
              </>
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white/[0.03]">
                <Disc className="w-6 h-6 text-surface-500" />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm font-semibold truncate text-white leading-tight">
              {currentTrack.title || currentTrack.fileName || currentTrack.file_name}
            </p>
            <p className="text-[11px] sm:text-xs text-surface-400 truncate mt-0.5">
              {currentTrack.artist || 'Unknown Artist'}
            </p>
          </div>

          <button
            onClick={() => toggleFavoriteTrack(currentTrack.id)}
            className={`p-2 rounded-full transition-all shrink-0 ${
              starred
                ? 'text-accent scale-110'
                : 'text-surface-500 hover:text-accent hover:scale-110'
            }`}
            title={starred ? 'Unlike' : 'Like'}
          >
            <Heart className={`w-4 h-4 ${starred ? 'fill-accent' : ''}`} />
          </button>
        </div>

        {/* Center: Playback controls & Seekbar */}
        <div className="flex-1 max-w-xl flex flex-col items-center justify-center">
          {/* Buttons row */}
          <div className="flex items-center gap-3 sm:gap-4 mb-1.5">
            <button
              onClick={toggleShuffle}
              className={`p-2 rounded-lg transition-all ${
                shuffle
                  ? 'text-accent bg-accent/15 shadow-glow'
                  : 'text-surface-400 hover:text-white'
              }`}
              title="Shuffle"
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={prev}
              disabled={!hasPrev}
              className={`p-2 rounded-lg transition-colors ${
                hasPrev
                  ? 'text-surface-200 hover:text-white'
                  : 'text-surface-600 cursor-default'
              }`}
              title="Previous Track"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              onClick={togglePlay}
              className="w-10 h-10 sm:w-11 sm:h-11 rounded-full bg-gradient-to-tr from-accent to-accent-hover text-surface-950 flex items-center justify-center shadow-glow hover:scale-105 active:scale-95 transition-all"
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-surface-950" />
              ) : (
                <Play className="w-5 h-5 fill-surface-950 ml-0.5" />
              )}
            </button>

            <button
              onClick={next}
              disabled={!hasNext}
              className={`p-2 rounded-lg transition-colors ${
                hasNext
                  ? 'text-surface-200 hover:text-white'
                  : 'text-surface-600 cursor-default'
              }`}
              title="Next Track"
            >
              <SkipForward className="w-4 h-4" />
            </button>

            <button
              onClick={toggleRepeat}
              className={`p-2 rounded-lg transition-all relative ${
                repeat !== 'none'
                  ? 'text-accent bg-accent/15 shadow-glow'
                  : 'text-surface-400 hover:text-white'
              }`}
              title={`Repeat: ${repeat}`}
            >
              <Repeat className="w-4 h-4" />
              {repeat === 'one' && (
                <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-accent text-[9px] font-bold text-surface-950 flex items-center justify-center">
                  1
                </span>
              )}
            </button>
          </div>

          {/* Timeline progress slider */}
          <div className="w-full flex items-center gap-3 text-[11px] text-surface-400 font-mono">
            <span className="w-10 text-right">{formatDuration(currentTime)}</span>
            <div
              onClick={handleSeekClick}
              className="flex-1 h-2 bg-white/[0.08] hover:h-2.5 rounded-full cursor-pointer relative group transition-all"
            >
              <div
                className="h-full bg-gradient-to-r from-accent to-accent-hover rounded-full shadow-glow"
                style={{ width: `${progressPct}%` }}
              />
              <div
                className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full bg-white shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `calc(${progressPct}% - 7px)` }}
              />
            </div>
            <span className="w-10">{formatDuration(duration)}</span>
          </div>
        </div>

        {/* Right: Lyrics, Queue, Volume & Close */}
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0 justify-end w-52 sm:w-72">
          {/* Lyrics toggle */}
          <button
            onClick={() => setIsLyricsOpen((v) => !v)}
            className={`p-2 rounded-xl transition-all ${
              isLyricsOpen
                ? 'text-accent bg-accent/15 border border-accent/25 shadow-glow'
                : 'text-surface-400 hover:text-white hover:bg-white/[0.05]'
            }`}
            title="Lyrics"
          >
            <Mic2 className="w-4 h-4" />
          </button>

          {/* Queue toggle */}
          <button
            onClick={() => setIsQueueOpen((v) => !v)}
            className={`p-2 rounded-xl transition-all ${
              isQueueOpen
                ? 'text-accent bg-accent/15 border border-accent/25 shadow-glow'
                : 'text-surface-400 hover:text-white hover:bg-white/[0.05]'
            }`}
            title="Queue"
          >
            <ListMusic className="w-4 h-4" />
          </button>

          {/* Volume slider with mousewheel adjustment */}
          <div
            onWheel={(e) => {
              e.preventDefault();
              const delta = e.deltaY > 0 ? -0.05 : 0.05;
              setVolume(volume + delta);
            }}
            className="hidden sm:flex items-center gap-2 text-surface-400 pl-2 cursor-pointer select-none"
            title="Scroll mouse wheel to change volume"
          >
            <button
              onClick={toggleMute}
              className="hover:text-white transition-colors"
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-surface-500" />
              ) : (
                <Volume2 className="w-4 h-4 text-surface-300" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={muted ? 0 : volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.05 : 0.05;
                setVolume(volume + delta);
              }}
              className="w-20 h-1 appearance-none bg-surface-700 rounded-full cursor-pointer accent-accent"
            />
          </div>

          {/* Close player */}
          <button
            onClick={clearQueue}
            className="p-2 text-surface-500 hover:text-rose-400 rounded-xl transition-colors ml-1"
            title="Close Player"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Lightbox Cover Modal */}
      {showFullCover && currentTrack.cover_path && (
        <CoverModal
          coverPath={currentTrack.cover_path}
          title={currentTrack.title || currentTrack.fileName || currentTrack.file_name}
          artist={currentTrack.artist}
          year={currentTrack.year}
          onClose={() => setShowFullCover(false)}
        />
      )}
    </div>
  );
}
