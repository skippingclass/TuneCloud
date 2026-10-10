import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api.js';

const VOL_KEY = 'tunecloud-volume';
const PlayerContext = createContext(null);

export function PlayerProvider({ children }) {
  const audioRef = useRef(null);
  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeat] = useState('none'); // 'none' | 'all' | 'one'
  const [shuffle, setShuffle] = useState(false);
  const [isLyricsOpen, setIsLyricsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [volume, setVolumeState] = useState(() => {
    try {
      const saved = localStorage.getItem(VOL_KEY);
      if (saved !== null) {
        const val = parseFloat(saved);
        if (!isNaN(val)) return Math.max(0, Math.min(1, val));
      }
      return 0.7;
    } catch {
      return 0.7;
    }
  });
  const [muted, setMuted] = useState(false);
  const scrobbledRef = useRef(false);

  const currentTrack = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;

  // Sync volume with audio element immediately whenever volume, muted, or track changes
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = muted ? 0 : volume;
  }, [volume, muted, currentTrack]);

  const setVolume = useCallback((v) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    setMuted(false);
    try {
      localStorage.setItem(VOL_KEY, clamped);
    } catch {}
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  const toggleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'none' ? 'all' : r === 'all' ? 'one' : 'none'));
  }, []);

  const toggleShuffle = useCallback(() => {
    setShuffle((s) => !s);
  }, []);

  // Window title update
  useEffect(() => {
    if (currentTrack) {
      document.title = `${currentTrack.artist || 'Unknown'} — ${currentTrack.title || currentTrack.fileName || currentTrack.file_name}`;
    } else {
      document.title = 'TuneCloud';
    }
  }, [currentTrack]);

  // MediaSession API integration
  useEffect(() => {
    if (!currentTrack || !('mediaSession' in navigator)) return;
    const artwork = currentTrack.cover_path
      ? [{ src: api.coverUrl(currentTrack.cover_path), sizes: '512x512', type: 'image/jpeg' }]
      : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title || currentTrack.file_name || currentTrack.fileName || 'Unknown Track',
      artist: currentTrack.artist || 'Unknown Artist',
      album: currentTrack.album || '',
      artwork,
    });
  }, [currentTrack]);

  const pickNext = useCallback(() => {
    if (queue.length === 0) return -1;
    if (shuffle) {
      if (queue.length === 1) return 0;
      let nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * queue.length);
      } while (nextIdx === queueIndex && queue.length > 1);
      return nextIdx;
    }
    const nextIdx = queueIndex + 1;
    if (nextIdx >= queue.length) return repeat === 'all' ? 0 : -1;
    return nextIdx;
  }, [queue.length, queueIndex, shuffle, repeat]);

  const pickPrev = useCallback(() => {
    if (queue.length === 0) return -1;
    if (shuffle) {
      if (queue.length === 1) return 0;
      let prevIdx;
      do {
        prevIdx = Math.floor(Math.random() * queue.length);
      } while (prevIdx === queueIndex && queue.length > 1);
      return prevIdx;
    }
    const prevIdx = queueIndex - 1;
    if (prevIdx < 0) return repeat === 'all' ? queue.length - 1 : -1;
    return prevIdx;
  }, [queue.length, queueIndex, shuffle, repeat]);

  const next = useCallback(() => {
    const idx = pickNext();
    if (idx >= 0) setQueueIndex(idx);
  }, [pickNext]);

  const prev = useCallback(() => {
    const idx = pickPrev();
    if (idx >= 0) setQueueIndex(idx);
  }, [pickPrev]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler('pause', () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prev);
    navigator.mediaSession.setActionHandler('nexttrack', next);
    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
    };
  }, [next, prev]);

  const playTrack = useCallback((track, trackList = null) => {
    const list = trackList || queue;
    const idx = list.findIndex((t) => t.id === track.id);
    setQueue(list);
    setQueueIndex(idx >= 0 ? idx : 0);
    setIsPlaying(true);
    scrobbledRef.current = false;
  }, [queue]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  }, []);

  const seek = useCallback((time) => {
    const el = audioRef.current;
    if (el) el.currentTime = time;
  }, []);

  const addToQueue = useCallback((track) => {
    setQueue((prev) => [...prev, track]);
    if (queueIndex === -1) {
      setQueueIndex(0);
      setIsPlaying(true);
    }
  }, [queueIndex]);

  const removeFromQueue = useCallback((index) => {
    setQueue((prev) => prev.filter((_, i) => i !== index));
    if (index === queueIndex) {
      if (queue.length <= 1) {
        setQueueIndex(-1);
        setIsPlaying(false);
      } else if (index >= queue.length - 1) {
        setQueueIndex(queue.length - 2);
      }
    } else if (index < queueIndex) {
      setQueueIndex((i) => i - 1);
    }
  }, [queue.length, queueIndex]);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setQueueIndex(-1);
    setIsPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  // Audio listeners
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const onTime = () => {
      setCurrentTime(el.currentTime);
      // Scrobble after 50% or 30s
      if (!scrobbledRef.current && currentTrack?.id && el.duration > 0) {
        if (el.currentTime >= Math.min(el.duration * 0.5, 30)) {
          scrobbledRef.current = true;
          api.scrobble(currentTrack.id).catch(() => {});
        }
      }
    };
    const onMeta = () => setDuration(el.duration);
    const onEnd = () => {
      if (repeat === 'one') {
        el.currentTime = 0;
        el.play();
        return;
      }
      next();
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);

    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [currentTrack, repeat, next]);

  return (
    <PlayerContext.Provider
      value={{
        audioRef,
        currentTrack,
        queue,
        queueIndex,
        setQueueIndex,
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
        playTrack,
        togglePlay,
        seek,
        next,
        prev,
        setVolume,
        toggleMute,
        toggleRepeat,
        toggleShuffle,
        addToQueue,
        removeFromQueue,
        clearQueue,
        hasNext: pickNext() >= 0,
        hasPrev: pickPrev() >= 0,
      }}
    >
      {children}
      {currentTrack && (
        <audio
          ref={(el) => {
            audioRef.current = el;
            if (el) el.volume = muted ? 0 : volume;
          }}
          key={currentTrack.id}
          autoPlay
          onLoadedMetadata={(e) => {
            e.currentTarget.volume = muted ? 0 : volume;
          }}
          onPlay={(e) => {
            e.currentTarget.volume = muted ? 0 : volume;
          }}
          className="hidden"
          src={api.streamUrl(currentTrack.id)}
        />
      )}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
