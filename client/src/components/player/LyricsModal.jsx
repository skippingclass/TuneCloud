import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X,
  Disc,
  Loader2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  Heart,
  Maximize2,
  Minimize2,
  Mic2,
} from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { extractPalette } from '../../utils/palette.js';
import { ArtistLinks } from '../common/ArtistLinks.jsx';
import { parseLrc, activeLineIndex } from '../../utils/lyrics.js';

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const lyricsCache = new Map();

export function LyricsModal({ onGoToAlbum, onGoToArtist }) {
  const {
    currentTrack,
    currentTime,
    duration,
    isPlaying,
    togglePlay,
    seek,
    next,
    prev,
    shuffle,
    toggleShuffle,
    repeat,
    toggleRepeat,
    volume,
    setVolume,
    muted,
    toggleMute,
    isLyricsOpen,
    setIsLyricsOpen,
  } = usePlayer();

  const { isTrackStarred, toggleFavoriteTrack, toggleTrackStar } = useFavorites();
  const handleToggleFavorite = toggleFavoriteTrack || toggleTrackStar;

  const [loading, setLoading] = useState(true);
  const [loadedTrackId, setLoadedTrackId] = useState(null);
  const [lyricsData, setLyricsData] = useState(null);
  const [dominantColors, setDominantColors] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [mobileTab, setMobileTab] = useState('lyrics'); // 'lyrics' | 'art'

  const activeLineRef = useRef(null);
  const containerRef = useRef(null);
  const volumeBarRef = useRef(null);
  const activeRequestIdRef = useRef(0);

  const isStarred = currentTrack ? isTrackStarred(currentTrack.id) : false;

  // Extract color palette from cover when track changes
  useEffect(() => {
    if (!currentTrack?.cover_path) {
      setDominantColors(null);
      return;
    }
    const coverUrl = api.coverUrl(currentTrack.cover_path);
    extractPalette(coverUrl).then((colors) => {
      if (colors && colors.length > 0) setDominantColors(colors);
      else setDominantColors(null);
    });
  }, [currentTrack?.cover_path]);

  // Load lyrics with request cancellation, instant memory caching and zero flash
  const loadLyrics = useCallback(() => {
    const reqId = ++activeRequestIdRef.current;
    if (!isLyricsOpen || !currentTrack) return;
    const trackId = currentTrack.id;

    if (lyricsCache.has(trackId)) {
      setLyricsData(lyricsCache.get(trackId));
      setLoadedTrackId(trackId);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setLyricsData(null);
    setLoadedTrackId(null);

    api
      .lyrics({
        id: trackId,
        title: currentTrack.title || currentTrack.fileName || '',
        artist: currentTrack.artist || '',
        duration: currentTrack.duration || 0,
      }, { signal: controller.signal })
      .then((data) => {
        if (reqId !== activeRequestIdRef.current) return;
        let parsedData;
        if (data.synced) {
          const parsed = parseLrc(data.lyrics, currentTrack.duration);
          parsedData = {
            synced: parsed.length > 0,
            lines: parsed,
            text: parsed.length ? undefined : data.lyrics,
            source: data.source || 'lrclib',
          };
        } else {
          parsedData = {
            synced: false,
            text: data.lyrics,
            source: data.source || 'lrclib',
          };
        }
        lyricsCache.set(trackId, parsedData);
        setLyricsData(parsedData);
        setLoadedTrackId(trackId);
      })
      .catch((error) => {
        if (reqId !== activeRequestIdRef.current) return;
        if (error.name === 'AbortError') return;
        const notFoundData = { notFound: true };
        // The server may have exhausted providers during a temporary outage.
        // Retry on reopening instead of caching failed lookups as permanent misses.
        setLyricsData(notFoundData);
        setLoadedTrackId(trackId);
      })
      .finally(() => {
        if (reqId === activeRequestIdRef.current) {
          setLoading(false);
        }
      });
    return () => {
      activeRequestIdRef.current++;
      controller.abort();
    };
  }, [isLyricsOpen, currentTrack?.id]);

  useEffect(() => {
    return loadLyrics();
  }, [loadLyrics]);

  // Handle Fullscreen events and key listener (Escape, F)
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    const onKeyDown = (e) => {
      if (!isLyricsOpen) return;
      if (e.key === 'Escape' && !document.fullscreenElement) {
        setIsLyricsOpen(false);
      }
      if (e.key === 'f' || e.key === 'F') {
        if (!e.target.matches('input, textarea')) {
          toggleFullscreen();
        }
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isLyricsOpen]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Find active line index
  const activeIndex = lyricsData?.synced ? activeLineIndex(lyricsData.lines, currentTime) : -1;

  // Auto-scroll to active line
  useEffect(() => {
    if (activeLineRef.current && containerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex, loadedTrackId, isLyricsOpen, mobileTab]);

  // Volume slider click/drag handler
  const handleVolumeBarClick = (e) => {
    if (!volumeBarRef.current) return;
    const rect = volumeBarRef.current.getBoundingClientRect();
    const offsetY = rect.bottom - e.clientY;
    const height = rect.height;
    const nextVol = Math.max(0, Math.min(1, offsetY / height));
    setVolume(nextVol);
  };

  // Volume slider mouse-wheel adjustment
  useEffect(() => {
    const el = volumeBarRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = 0.05;
      const delta = e.deltaY < 0 ? step : -step;
      setVolume((prev) => Math.min(1, Math.max(0, Math.round((prev + delta) * 100) / 100)));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, [setVolume, isLyricsOpen]);

  if (!isLyricsOpen || !currentTrack) return null;

  const isCurrentlyLoading = loading || (currentTrack && loadedTrackId !== currentTrack.id);

  const bgOrb1 = dominantColors?.[0] || 'var(--theme-primary, #c084fc)';
  const bgOrb2 = dominantColors?.[1] || 'var(--theme-secondary, #38bdf8)';
  const bgOrb3 = dominantColors?.[2] || bgOrb1;

  const renderArtworkAndControls = (isCentered = false) => (
    <div
      className={`flex flex-col items-center justify-center w-full space-y-6 ${
        isCentered
          ? 'max-w-[460px] sm:max-w-[490px] xl:max-w-[510px] mx-auto'
          : `max-w-[480px] xl:max-w-[520px] mx-auto ${
              mobileTab === 'lyrics' ? 'hidden lg:flex' : 'flex'
            }`
      }`}
    >
      {/* Artwork container with hover controls */}
      <div className="relative group w-full aspect-square rounded-[28px] sm:rounded-[36px] overflow-hidden shadow-[0_28px_70px_rgba(0,0,0,0.7)] ring-1 ring-white/20 bg-surface-900 select-none transition-transform duration-500">
        {currentTrack.cover_path ? (
          <img
            src={api.coverUrl(currentTrack.cover_path)}
            alt=""
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface-900">
            <Disc className="w-24 h-24 text-surface-600 animate-spin-slow" />
          </div>
        )}

        {/* Smooth hover overlay: appears smoothly ONLY when cursor is over the cover */}
        <div className="absolute inset-0 bg-black/55 backdrop-blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-between p-5 pointer-events-none group-hover:pointer-events-auto">
          {/* Top row of overlay */}
          <div className="flex items-center justify-end">
            <button
              onClick={toggleFullscreen}
              title="Fullscreen"
              className="p-2.5 rounded-full bg-white/[0.08] hover:bg-white/[0.18] text-white/80 hover:text-white border border-white/10 transition-colors"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>

          {/* Center Heart + Right Volume bar */}
          <div className="flex items-center justify-between px-2">
            <div className="w-8" />
            {/* Big Heart button */}
            <button
              onClick={() => handleToggleFavorite?.(currentTrack.id)}
              title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
              className="p-4 rounded-full bg-white/[0.1] hover:bg-white/[0.2] border border-white/15 text-white transition-all transform active:scale-90 hover:scale-110"
            >
              <Heart
                className={`w-14 h-14 transition-colors ${
                  isStarred ? 'fill-rose-500 text-rose-500 drop-shadow-[0_0_15px_rgba(244,63,94,0.6)]' : 'text-white'
                }`}
              />
            </button>

            {/* Right: Vertical volume slider bar */}
            <div className="flex flex-col items-center gap-2">
              <div
                ref={volumeBarRef}
                onClick={handleVolumeBarClick}
                title="Click or scroll mouse wheel to change volume"
                className="w-2.5 h-24 bg-white/20 hover:bg-white/30 rounded-full relative cursor-pointer overflow-hidden"
              >
                <div
                  className="absolute bottom-0 left-0 right-0 bg-white rounded-full transition-all duration-75"
                  style={{ height: `${(muted ? 0 : volume) * 100}%` }}
                />
              </div>
              <button
                onClick={toggleMute}
                className="text-white/70 hover:text-white transition-colors"
              >
                {muted || volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Bottom playback controls row */}
          <div className="flex items-center justify-center gap-4 pt-2">
            <button
              onClick={toggleShuffle}
              title="Shuffle"
              className={`p-2 rounded-full transition-colors ${
                shuffle ? 'text-accent bg-accent/20' : 'text-white/70 hover:text-white'
              }`}
            >
              <Shuffle className="w-4 h-4" />
            </button>

            <button
              onClick={prev}
              title="Previous track"
              className="p-2 rounded-full text-white/80 hover:text-white transition-transform active:scale-95"
            >
              <SkipBack className="w-6 h-6 fill-current" />
            </button>

            <button
              onClick={togglePlay}
              title={isPlaying ? 'Pause' : 'Play'}
              className="p-3.5 rounded-full bg-white text-surface-950 hover:scale-105 active:scale-95 transition-all shadow-lg"
            >
              {isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current translate-x-0.5" />
              )}
            </button>

            <button
              onClick={next}
              title="Next track"
              className="p-2 rounded-full text-white/80 hover:text-white transition-transform active:scale-95"
            >
              <SkipForward className="w-6 h-6 fill-current" />
            </button>

            <button
              onClick={toggleRepeat}
              title={`Repeat: ${repeat}`}
              className={`p-2 rounded-full transition-colors ${
                repeat !== 'none' ? 'text-accent bg-accent/20' : 'text-white/70 hover:text-white'
              }`}
            >
              {repeat === 'one' ? <Repeat1 className="w-4 h-4" /> : <Repeat className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>

      {/* Under artwork: Scrubber & Track Title / Artist */}
      <div className="w-full space-y-4 text-center select-none font-lyrics">
        {/* Scrubber */}
        <div className="space-y-1.5 px-2">
          <div className="relative group/bar flex items-center py-1">
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={currentTime || 0}
              onChange={(e) => seek(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-white/20 group-hover/bar:h-2 rounded-lg appearance-none cursor-pointer accent-white transition-all"
            />
          </div>
          <div className="flex justify-between text-[11px] font-mono text-white/50 px-0.5">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Title & Artist */}
        <div className="space-y-1">
          <h2
            onClick={() => {
              if (currentTrack.album_id || currentTrack.album) {
                onGoToAlbum?.({
                  id: currentTrack.album_id,
                  title: currentTrack.album,
                  artist: currentTrack.artist,
                  cover_path: currentTrack.cover_path,
                });
                setIsLyricsOpen(false);
              }
            }}
            className={`text-2xl sm:text-3xl font-[850] text-white tracking-tight truncate leading-tight ${
              currentTrack.album_id || currentTrack.album
                ? 'hover:text-accent cursor-pointer transition-colors'
                : ''
            }`}
            title={currentTrack.title || currentTrack.fileName}
          >
            {currentTrack.title || currentTrack.fileName || currentTrack.file_name}
          </h2>
          <p className="text-sm sm:text-base text-white/60 font-medium truncate tracking-tight">
            <ArtistLinks
              artist={currentTrack.artist}
              primaryArtistId={currentTrack.artist_id}
              onGoToArtist={onGoToArtist}
              onBeforeNavigate={() => setIsLyricsOpen(false)}
              linkClassName="hover:text-white hover:underline cursor-pointer transition-colors"
              delimiterClassName="text-white/40"
            />
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 w-screen h-screen bg-[#040508] text-white flex flex-col select-none overflow-hidden animate-fade-in font-lyrics">
      {/* Dynamic blurred mesh gradient backdrop */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
        <div
          className="absolute -top-[15%] -left-[10%] w-[65vw] h-[65vw] rounded-full filter blur-[120px] opacity-35 mix-blend-screen transition-all duration-1000"
          style={{ background: bgOrb1 }}
        />
        <div
          className="absolute top-[25%] -right-[15%] w-[60vw] h-[60vw] rounded-full filter blur-[140px] opacity-25 mix-blend-screen transition-all duration-1000"
          style={{ background: bgOrb2 }}
        />
        <div
          className="absolute -bottom-[20%] left-[25%] w-[55vw] h-[55vw] rounded-full filter blur-[130px] opacity-25 mix-blend-screen transition-all duration-1000"
          style={{ background: bgOrb3 }}
        />
        {/* Soft vignette darkening layer */}
        <div className="absolute inset-0 bg-black/45" />
      </div>

      {/* Top action header */}
      <header className="relative z-20 flex items-center justify-between px-6 py-4 shrink-0">
        {/* Source badge / synced via */}
        <div className="flex items-center gap-2">
          {!isCurrentlyLoading && lyricsData?.source === 'lrc.red' ? (
            <a href="https://lrc.red" target="_blank" rel="noopener noreferrer"
              className="text-xs text-white/60 hover:text-white underline underline-offset-4">
              Lyrics via lrc.red
            </a>
          ) : !isCurrentlyLoading && lyricsData?.synced ? (
            <span className="text-xs font-lyrics text-white/35 font-normal tracking-wide select-none">
              synced via {lyricsData.source?.toLowerCase() === 'lrclib' ? 'lrclib' : lyricsData.source || 'lrc'}
            </span>
          ) : null}
        </div>

        {/* Mobile tab switchers (only when lyrics exist) */}
        {!lyricsData?.notFound && (
          <div className="flex lg:hidden items-center p-1 bg-white/[0.06] rounded-xl border border-white/[0.08]">
            <button
              onClick={() => setMobileTab('lyrics')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                mobileTab === 'lyrics' ? 'bg-white/15 text-white' : 'text-surface-400 hover:text-white'
              }`}
            >
              Lyrics
            </button>
            <button
              onClick={() => setMobileTab('art')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-all ${
                mobileTab === 'art' ? 'bg-white/15 text-white' : 'text-surface-400 hover:text-white'
              }`}
            >
              Artwork
            </button>
          </div>
        )}

        {/* Right buttons: Fullscreen & Close */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
            className="p-2.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-surface-300 hover:text-white transition-all duration-200"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          <button
            onClick={() => setIsLyricsOpen(false)}
            title="Close (Esc)"
            className="p-2.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-surface-300 hover:text-white transition-all duration-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main view: Centered artwork if no lyrics, or 2-column layout */}
      {lyricsData?.notFound ? (
        <main className="relative z-10 flex-1 min-h-0 max-w-[560px] w-full mx-auto px-6 pb-8 pt-2 flex flex-col items-center justify-center animate-fade-in">
          {renderArtworkAndControls(true)}
        </main>
      ) : (
        <main className="relative z-10 flex-1 min-h-0 max-w-[1500px] w-full mx-auto px-6 sm:px-10 pb-8 pt-2 grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-center">
          {/* Left Column: Artwork, hover controls, scrubber, track info */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center w-full">
            {renderArtworkAndControls(false)}
          </div>

          {/* Right Column: Scrolling Lyrics (Google Sans Flex with Inter fallback) */}
          <div
            ref={containerRef}
            className={`lg:col-span-7 h-full overflow-y-auto px-4 sm:px-10 py-12 scroll-smooth text-left relative font-lyrics ${
              mobileTab === 'art' ? 'hidden lg:block' : 'block'
            }`}
            style={{ scrollbarWidth: 'thin' }}
          >
            {isCurrentlyLoading ? (
              <div className="h-full min-h-[300px] flex flex-col items-center justify-center gap-3 text-white/50">
                <Loader2 className="w-8 h-8 animate-spin text-accent" />
                <span className="text-sm font-medium tracking-tight">Loading lyrics...</span>
              </div>
            ) : lyricsData?.synced ? (
              <div className="space-y-5 sm:space-y-7 py-20 pb-44">
                {lyricsData.lines.map((line, idx) => {
                  const isActive = idx === activeIndex;
                  const isPast = idx < activeIndex;

                  return (
                    <div
                      key={idx}
                      role="button"
                      tabIndex={0}
                      aria-current={isActive ? 'true' : undefined}
                      ref={isActive ? activeLineRef : null}
                      onClick={() => seek(line.startMs / 1000)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          seek(line.startMs / 1000);
                        }
                      }}
                      className={`cursor-pointer transition-all duration-300 rounded-xl py-2 sm:py-2.5 px-3 sm:px-4 ${
                        isActive
                          ? 'scale-[1.02] origin-left text-white'
                          : isPast
                          ? 'text-white/30 hover:text-white/75'
                          : 'text-white/40 hover:text-white/80'
                      }`}
                    >
                      <p
                        className={`whitespace-pre-line tracking-tight leading-snug transition-all duration-300 ${
                          isActive
                            ? 'text-2xl sm:text-3xl lg:text-[36px] font-[650] text-white'
                            : 'text-xl sm:text-2xl lg:text-[28px] font-medium'
                        }`}
                      >
                        {line.text || '♪'}
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="whitespace-pre-line text-xl sm:text-2xl lg:text-3xl font-medium leading-relaxed text-white/85 py-16 max-w-2xl tracking-tight">
                {lyricsData?.text}
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
