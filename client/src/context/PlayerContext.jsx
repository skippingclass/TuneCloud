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
  const [playbackKey, setPlaybackKey] = useState(0);
  const scrobbledRef = useRef(false);
  const playRequestIdRef = useRef(0);

  const currentTrack = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;

  const safePlay = useCallback((el) => {
    if (!el || typeof el.play !== 'function') return;
    const reqId = ++playRequestIdRef.current;
    try {
      const playPromise = el.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise
          .then(() => {
            if (reqId === playRequestIdRef.current) {
              setIsPlaying(true);
            }
          })
          .catch(() => {
            if (reqId === playRequestIdRef.current) {
              setIsPlaying(false);
            }
          });
      } else {
        setIsPlaying(true);
      }
    } catch {
      if (reqId === playRequestIdRef.current) {
        setIsPlaying(false);
      }
    }
  }, []);

  // Sync volume with audio element immediately whenever volume, muted, or track changes
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = muted ? 0 : volume;
  }, [volume, muted, currentTrack]);

  const setVolume = useCallback((v) => {
    setVolumeState((prev) => {
      const nextVal = typeof v === 'function' ? v(prev) : v;
      const clamped = Math.max(0, Math.min(1, nextVal));
      try {
        localStorage.setItem(VOL_KEY, clamped);
      } catch {}
      return clamped;
    });
    setMuted(false);
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

  // MediaSession API metadata & playbackState integration
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!currentTrack) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }

    let artwork = [];
    if (currentTrack.cover_path) {
      try {
        const url = api.coverUrl(currentTrack.cover_path);
        const absUrl = new URL(url, window.location.origin).href;
        artwork = [
          { src: absUrl, sizes: '96x96', type: 'image/jpeg' },
          { src: absUrl, sizes: '128x128', type: 'image/jpeg' },
          { src: absUrl, sizes: '256x256', type: 'image/jpeg' },
          { src: absUrl, sizes: '512x512', type: 'image/jpeg' },
        ];
      } catch {}
    }

    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.title || currentTrack.file_name || currentTrack.fileName || 'Unknown Track',
        artist: currentTrack.artist || 'Unknown Artist',
        album: currentTrack.album || '',
        artwork,
      });
    }
  }, [currentTrack]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!currentTrack) {
      navigator.mediaSession.playbackState = 'none';
    } else {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }, [isPlaying, currentTrack]);

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

  const selectQueueIndex = useCallback((idx) => {
    scrobbledRef.current = false;
    setCurrentTime(0);
    setQueueIndex(idx);
    setPlaybackKey((k) => k + 1);
  }, []);

  const next = useCallback(() => {
    const idx = pickNext();
    if (idx >= 0) {
      scrobbledRef.current = false;
      setCurrentTime(0);
      setQueueIndex(idx);
      setPlaybackKey((k) => k + 1);
    }
  }, [pickNext]);

  const prev = useCallback(() => {
    const idx = pickPrev();
    if (idx >= 0) {
      scrobbledRef.current = false;
      setCurrentTime(0);
      setQueueIndex(idx);
      setPlaybackKey((k) => k + 1);
    }
  }, [pickPrev]);

  const seek = useCallback((time) => {
    const el = audioRef.current;
    const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (el) {
      const maxDur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
      const targetTime = maxDur !== null ? Math.min(safeTime, maxDur) : safeTime;
      el.currentTime = targetTime;
      setCurrentTime(targetTime);
      if (
        'mediaSession' in navigator &&
        'setPositionState' in navigator.mediaSession &&
        maxDur !== null
      ) {
        try {
          navigator.mediaSession.setPositionState({
            duration: maxDur,
            playbackRate: el.playbackRate || 1,
            position: targetTime,
          });
        } catch {}
      }
    } else {
      setCurrentTime(safeTime);
    }
  }, []);

  const clearQueue = useCallback(() => {
    playRequestIdRef.current += 1;
    scrobbledRef.current = false;
    setQueue([]);
    setQueueIndex(-1);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  }, []);

  // MediaSession Action Handlers
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    const setAction = (action, handler) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    };

    setAction('play', () => safePlay(audioRef.current));
    setAction('pause', () => {
      playRequestIdRef.current += 1;
      audioRef.current?.pause();
    });
    setAction('previoustrack', prev);
    setAction('nexttrack', next);
    setAction('seekto', (details) => {
      if (details?.seekTime != null) {
        seek(details.seekTime);
      }
    });
    setAction('seekbackward', (details) => {
      const offset = details?.seekOffset || 10;
      const el = audioRef.current;
      if (el) seek(Math.max(0, (el.currentTime || 0) - offset));
    });
    setAction('seekforward', (details) => {
      const offset = details?.seekOffset || 10;
      const el = audioRef.current;
      if (el) seek(Math.min(Number.isFinite(el.duration) ? el.duration : 0, (el.currentTime || 0) + offset));
    });
    setAction('stop', () => {
      clearQueue();
    });

    return () => {
      const actions = [
        'play',
        'pause',
        'previoustrack',
        'nexttrack',
        'seekto',
        'seekbackward',
        'seekforward',
        'stop',
      ];
      actions.forEach((act) => setAction(act, null));
    };
  }, [next, prev, seek, clearQueue, safePlay]);

  const playTrack = useCallback(
    (track, trackList = null) => {
      if (!track) return;
      const list = trackList || (queue.some(t => t.id === track.id) ? queue : [track]);
      const idx = list.findIndex((t) => t.id === track.id);
      const targetIdx = idx >= 0 ? idx : 0;
      const isSameTrack = currentTrack?.id != null && currentTrack.id === track.id;

      setQueue(list);
      setQueueIndex(targetIdx);

      if (isSameTrack) {
        const el = audioRef.current;
        if (el) {
          safePlay(el);
        }
        return;
      }

      scrobbledRef.current = false;
      setCurrentTime(0);
      setDuration(Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0);
      setPlaybackKey((k) => k + 1);
    },
    [queue, currentTrack?.id, safePlay]
  );

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      safePlay(el);
    } else {
      playRequestIdRef.current += 1;
      el.pause();
      setIsPlaying(false);
    }
  }, [safePlay]);

  const addToQueue = useCallback(
    (track) => {
      setQueue((prev) => [...prev, track]);
      if (queueIndex === -1) {
        scrobbledRef.current = false;
        setCurrentTime(0);
        setDuration(Number.isFinite(track?.duration) && track.duration > 0 ? track.duration : 0);
        setQueueIndex(0);
        setPlaybackKey((k) => k + 1);
      }
    },
    [queueIndex]
  );

  const removeFromQueue = useCallback(
    (index) => {
      setQueue((prev) => prev.filter((_, i) => i !== index));
      if (index === queueIndex) {
        scrobbledRef.current = false;
        setCurrentTime(0);
        if (queue.length <= 1) {
          playRequestIdRef.current += 1;
          setQueueIndex(-1);
          setIsPlaying(false);
          setDuration(0);
        } else if (index >= queue.length - 1) {
          setQueueIndex(queue.length - 2);
          setPlaybackKey((k) => k + 1);
        } else {
          setPlaybackKey((k) => k + 1);
        }
      } else if (index < queueIndex) {
        setQueueIndex((i) => i - 1);
      }
    },
    [queue.length, queueIndex]
  );

  // Start playback and reset per-play state when active track or playbackKey changes
  useEffect(() => {
    if (!currentTrack) {
      scrobbledRef.current = false;
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      return;
    }

    scrobbledRef.current = false;
    setCurrentTime(0);
    setDuration(
      Number.isFinite(currentTrack.duration) && currentTrack.duration > 0
        ? currentTrack.duration
        : 0
    );

    const el = audioRef.current;
    if (el) {
      try {
        el.currentTime = 0;
      } catch {}
      safePlay(el);
    }
  }, [currentTrack?.id, playbackKey, safePlay]);

  // Audio listeners
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const getEffectiveDuration = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
      if (Number.isFinite(currentTrack?.duration) && currentTrack.duration > 0) {
        return currentTrack.duration;
      }
      return 0;
    };

    const syncMediaSessionPosition = () => {
      const effDur = getEffectiveDuration();
      if (
        'mediaSession' in navigator &&
        'setPositionState' in navigator.mediaSession &&
        effDur > 0
      ) {
        try {
          const pos = Number.isFinite(el.currentTime) ? Math.max(0, Math.min(el.currentTime, effDur)) : 0;
          navigator.mediaSession.setPositionState({
            duration: effDur,
            playbackRate: el.playbackRate || 1,
            position: pos,
          });
        } catch {}
      }
    };

    const onTime = () => {
      const cur = Number.isFinite(el.currentTime) && el.currentTime >= 0 ? el.currentTime : 0;
      setCurrentTime(cur);
      const effDur = getEffectiveDuration();
      if (effDur > 0) {
        setDuration(effDur);
      }
      syncMediaSessionPosition();
      // Scrobble after 50% or 30s
      if (!scrobbledRef.current && currentTrack?.id && effDur > 0) {
        if (cur >= Math.min(effDur * 0.5, 30)) {
          scrobbledRef.current = true;
          api.scrobble(currentTrack.id).catch(() => {});
        }
      }
    };

    const onMeta = () => {
      const effDur = getEffectiveDuration();
      setDuration(effDur);
      syncMediaSessionPosition();
    };

    const onEnd = () => {
      scrobbledRef.current = false;
      if (repeat === 'one') {
        try {
          el.currentTime = 0;
        } catch {}
        setCurrentTime(0);
        safePlay(el);
        return;
      }
      const nextIdx = pickNext();
      if (nextIdx >= 0) {
        setCurrentTime(0);
        setQueueIndex(nextIdx);
        setPlaybackKey((k) => k + 1);
      } else {
        playRequestIdRef.current += 1;
        setIsPlaying(false);
        setCurrentTime(0);
      }
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onError = () => {
      playRequestIdRef.current += 1;
      setIsPlaying(false);
    };

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onError);

    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onError);
    };
  }, [currentTrack, repeat, pickNext, safePlay]);

  return (
    <PlayerContext.Provider
      value={{
        audioRef,
        currentTrack,
        queue,
        queueIndex,
        setQueueIndex: selectQueueIndex,
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
