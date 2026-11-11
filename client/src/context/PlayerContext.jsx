import { createContext, useContext, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, onTrackUpdated } from '../api.js';
import { shuffleOrder, readPlaybackSession, isPlayableTrack, playbackEventId } from '../utils/playback.js';
import { createLastfmTracker } from '../utils/lastfm.js';
import { toast } from '../components/layout/Toast.jsx';

const VOL_KEY = 'tunecloud-volume';
const PlayerContext = createContext(null);

export function PlayerProvider({ children, userId = 'local' }) {
  const sessionKey = `tunecloud-playback:${userId}`;
  const [saved] = useState(() => readPlaybackSession(sessionKey));
  const restoringRef = useRef(Boolean(saved));
  const pendingSeekRef = useRef(saved?.currentTime ?? null);
  const audioRef = useRef(null);
  const [queue, setQueue] = useState(saved?.queue || []);
  const [queueIndex, setQueueIndex] = useState(saved?.queueIndex ?? -1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(saved?.currentTime || 0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeat] = useState(saved?.repeat || 'none'); // 'none' | 'all' | 'one'
  const [shuffle, setShuffle] = useState(saved?.shuffle || false);
  const [order, setOrder] = useState(saved?.order || []);
  const [sleepUntil, setSleepUntil] = useState(null); // timestamp or 'track'
  const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
  const [isLyricsOpen, setIsLyricsOpen] = useState(false);
  const [playerView, setPlayerView] = useState('lyrics');
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
  const scrobbledRef = useRef(saved?.scrobbled || false);
  const lastfmRef = useRef(null);
  useEffect(() => {
    const tracker = createLastfmTracker(userId);
    lastfmRef.current = tracker;
    return () => { tracker.stop(); lastfmRef.current = null; };
  }, [userId]);
  const listeningRef = useRef(null);
  if (!listeningRef.current) listeningRef.current = { startedAt: saved?.startedAt || null, lastfmConnection: saved?.lastfmConnection, lastfmQueued: saved?.lastfmQueued || false, nowPlayingSent: saved?.nowPlayingSent || false, seconds: saved?.listenedSeconds || 0, eventId: saved?.eventId || playbackEventId(), pending: false, retryAfter: 0, sample: null };
  const resetListening = useCallback(() => {
    scrobbledRef.current = false;
    listeningRef.current = { startedAt: null, nowPlayingSent: false, seconds: 0, eventId: playbackEventId(), pending: false, retryAfter: 0, sample: null };
  }, []);
  const playRequestIdRef = useRef(0);

  useEffect(() => onTrackUpdated(id => {
    api.track(id).then(updated => setQueue(previous => previous.map(track => String(track.id) === String(id) ? { ...track, ...updated } : track))).catch(() => {});
  }), []);

  const currentTrack = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;

  const queueOrder = useMemo(() => shuffle ? order : queue.map((_, index) => index), [shuffle, order, queue]);

  const safePlay = useCallback((el) => {
    if (!el || typeof el.play !== 'function') return;
    restoringRef.current = false;
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
    if (!shuffle) setOrder(shuffleOrder(queue.length, queueIndex));
    setShuffle((s) => !s);
  }, [shuffle, queue.length, queueIndex]);

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
    if (!queue.length) return -1;
    const sequence = queueOrder;
    const position = sequence.indexOf(queueIndex);
    return sequence[position + 1] ?? (repeat === 'all' ? sequence[0] ?? -1 : -1);
  }, [queue, queueIndex, repeat, queueOrder]);

  const pickPrev = useCallback(() => {
    if (!queue.length) return -1;
    const sequence = queueOrder;
    const position = sequence.indexOf(queueIndex);
    return sequence[position - 1] ?? (repeat === 'all' ? sequence[sequence.length - 1] ?? -1 : -1);
  }, [queue, queueIndex, repeat, queueOrder]);

  const selectQueueIndex = useCallback((idx) => {
    if (!Number.isInteger(idx) || idx < 0 || idx >= queue.length || queue[idx].available === false) return;
    restoringRef.current = false;
    pendingSeekRef.current = null;
    resetListening();
    setCurrentTime(0);
    setQueueIndex(idx);
    setPlaybackKey((k) => k + 1);
  }, [queue]);

  const next = useCallback(() => {
    const idx = pickNext();
    if (idx >= 0) {
      restoringRef.current = false;
      pendingSeekRef.current = null;
      resetListening();
      setCurrentTime(0);
      setQueueIndex(idx);
      setPlaybackKey((k) => k + 1);
    }
  }, [pickNext]);

  const prev = useCallback(() => {
    const idx = pickPrev();
    if (idx >= 0) {
      restoringRef.current = false;
      pendingSeekRef.current = null;
      resetListening();
      setCurrentTime(0);
      setQueueIndex(idx);
      setPlaybackKey((k) => k + 1);
    }
  }, [pickPrev]);

  const seek = useCallback((time) => {
    const el = audioRef.current;
    listeningRef.current.sample = null;
    const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (el?.readyState === 0) {
      pendingSeekRef.current = safeTime;
      setCurrentTime(safeTime);
      return;
    }
    pendingSeekRef.current = null;
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
    restoringRef.current = false;
    pendingSeekRef.current = null;
    setOrder([]);
    setSleepUntil(null);
    setIsNowPlayingOpen(false);
    setIsLyricsOpen(false);
    playRequestIdRef.current += 1;
    resetListening();
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
      if (!isPlayableTrack(track)) {
        toast('This track is unavailable (file missing on disk)', 'warning');
        return;
      }
      const matchesEntry = (t) => t.id === track.id && (track.history_id == null || t.history_id === track.history_id) && (track.playlist_track_id == null || t.playlist_track_id === track.playlist_track_id);
      const rawList = trackList || (queue.some(matchesEntry) ? queue : [track]);
      const list = rawList.filter(isPlayableTrack);
      if (list.length === 0) return;
      const idx = list.findIndex(matchesEntry);
      const targetIdx = idx >= 0 ? idx : 0;
      const activeTrack = list[targetIdx];
      const isSameTrack = currentTrack?.id != null && currentTrack.id === activeTrack.id && matchesEntry(currentTrack);

      restoringRef.current = false;
      pendingSeekRef.current = null;
      setOrder(shuffleOrder(list.length, targetIdx));
      setQueue(list);
      setQueueIndex(targetIdx);

      if (isSameTrack) {
        const el = audioRef.current;
        if (el) {
          safePlay(el);
        }
        return;
      }

      resetListening();
      setCurrentTime(0);
      setDuration(Number.isFinite(activeTrack.duration) && activeTrack.duration > 0 ? activeTrack.duration : 0);
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
    (track, nextUp = false) => {
      if (!isPlayableTrack(track)) return;
      const insertAt = nextUp && queueIndex >= 0 ? queueIndex + 1 : queue.length;
      setQueue((prev) => [...prev.slice(0, insertAt), track, ...prev.slice(insertAt)]);
      setOrder((prev) => {
        const mapped = prev.map((i) => i >= insertAt ? i + 1 : i);
        const position = nextUp ? mapped.indexOf(queueIndex) + 1 : mapped.length;
        return [...mapped.slice(0, position), insertAt, ...mapped.slice(position)];
      });
      if (queueIndex === -1) {
        resetListening();
        setCurrentTime(0);
        setDuration(Number.isFinite(track?.duration) && track.duration > 0 ? track.duration : 0);
        setQueueIndex(0);
        setPlaybackKey((k) => k + 1);
      }
    },
    [queueIndex, queue.length]
  );

  const addManyToQueue = useCallback((tracks) => {
    const available = tracks.filter(isPlayableTrack);
    if (!available.length) return;
    setQueue((prev) => [...prev, ...available]);
    setOrder((prev) => [...prev, ...available.map((_, i) => queue.length + i)]);
    if (queueIndex < 0) {
      restoringRef.current = false;
      pendingSeekRef.current = null;
      setQueueIndex(0);
      setPlaybackKey((key) => key + 1);
    }
  }, [queue.length, queueIndex]);

  const removeFromQueue = useCallback((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) return;
    if (queue.length === 1) { clearQueue(); return; }
    setOrder((previous) => previous.filter((i) => i !== index).map((i) => i > index ? i - 1 : i));
    setQueue((previous) => previous.filter((_, i) => i !== index));
    if (index === queueIndex) {
      restoringRef.current = false;
      pendingSeekRef.current = null;
      resetListening();
      setCurrentTime(0);
      const nextIndex = pickNext();
      const previousIndex = pickPrev();
      const target = nextIndex >= 0 && nextIndex !== index ? nextIndex
        : previousIndex >= 0 && previousIndex !== index ? previousIndex : (index === 0 ? 1 : index - 1);
      setQueueIndex(target > index ? target - 1 : target);
      setPlaybackKey((key) => key + 1);
    } else if (index < queueIndex) {
      setQueueIndex((i) => i - 1);
    }
  }, [queue.length, queueIndex, pickNext, pickPrev, clearQueue]);

  const moveInQueue = useCallback((from, to) => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return;
    if (shuffle) {
      // Reordering the shuffled view must not scramble the source album order.
      setOrder(previous => {
        const result = [...previous];
        const fromPosition = result.indexOf(from);
        const toPosition = result.indexOf(to);
        if (fromPosition < 0 || toPosition < 0) return previous;
        result.splice(toPosition, 0, result.splice(fromPosition, 1)[0]);
        return result;
      });
      return;
    }
    const indices = queue.map((_, index) => index);
    indices.splice(to, 0, indices.splice(from, 1)[0]);
    setQueue(indices.map(index => queue[index]));
    setQueueIndex(indices.indexOf(queueIndex));
    setOrder(previous => previous.map(index => indices.indexOf(index)));
  }, [queue, queueIndex, shuffle]);

  const clearUpcoming = useCallback(() => {
    const position = queueOrder.indexOf(queueIndex);
    if (position < 0) return;
    const keep = queueOrder.slice(0, position + 1);
    const kept = new Set(keep);
    const indices = queue.map((_, index) => index).filter(index => kept.has(index));
    setQueue(indices.map(index => queue[index]));
    setQueueIndex(indices.indexOf(queueIndex));
    setOrder(keep.map(index => indices.indexOf(index)));
  }, [queue, queueIndex, queueOrder]);

  // Keep writes bounded during playback, and flush the exact position on pause/exit.
  const sessionRef = useRef(null);
  sessionRef.current = { queue, queueIndex, currentTime, repeat, shuffle, order, scrobbled: scrobbledRef.current, listenedSeconds: listeningRef.current.seconds, eventId: listeningRef.current.eventId, startedAt: listeningRef.current.startedAt, lastfmConnection: listeningRef.current.lastfmConnection, lastfmQueued: listeningRef.current.lastfmQueued, nowPlayingSent: Boolean(listeningRef.current.nowPlayingSent) };
  const persist = useCallback(() => {
    try {
      const state = sessionRef.current;
      if (!state.queue.length) localStorage.removeItem(sessionKey);
      else localStorage.setItem(sessionKey, JSON.stringify({ ...state, scrobbled: scrobbledRef.current, listenedSeconds: listeningRef.current.seconds, eventId: listeningRef.current.eventId, startedAt: listeningRef.current.startedAt, lastfmConnection: listeningRef.current.lastfmConnection, lastfmQueued: listeningRef.current.lastfmQueued, nowPlayingSent: Boolean(listeningRef.current.nowPlayingSent) }));
    } catch { /* Full or unavailable browser storage must not interrupt playback. */ }
  }, [sessionKey]);
  const timeBucket = Math.floor(currentTime / 5);
  useEffect(persist, [persist, queue, queueIndex, repeat, shuffle, order, isPlaying, timeBucket]);
  useEffect(() => {
    window.addEventListener('pagehide', persist);
    return () => { persist(); window.removeEventListener('pagehide', persist); };
  }, [persist]);

  useEffect(() => {
    if (typeof sleepUntil !== 'number') return;
    const timer = setTimeout(() => {
      playRequestIdRef.current += 1;
      audioRef.current?.pause();
      setIsPlaying(false);
      setSleepUntil(null);
    }, Math.max(0, sleepUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [sleepUntil]);

  // Start playback and reset per-play state when active track or playbackKey changes
  useEffect(() => {
    if (!currentTrack) {
      resetListening();
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      return;
    }

    if (restoringRef.current) {
      setDuration(currentTrack.duration || 0);
      return;
    }
    resetListening();
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
      if (pendingSeekRef.current !== null && el.readyState === 0) return;
      const cur = Number.isFinite(el.currentTime) && el.currentTime >= 0 ? el.currentTime : 0;
      setCurrentTime(cur);
      const effDur = getEffectiveDuration();
      if (effDur > 0) {
        setDuration(effDur);
      }
      syncMediaSessionPosition();
      // Count only media progress backed by elapsed playback time, excluding seeks.
      const listening = listeningRef.current;
      const now = performance.now();
      if ((!el.paused || el.ended) && !el.seeking) {
        if (!listening.startedAt) listening.startedAt = Math.floor(Date.now() / 1000);
        if (listening.sample) {
          const delta = cur - listening.sample.position;
          const elapsed = (now - listening.sample.wall) / 1000 * (el.playbackRate || 1);
          if (delta > 0) listening.seconds += Math.min(delta, Math.max(0, elapsed));
        }
      }
      const trackDur = Number.isFinite(currentTrack?.duration) && currentTrack.duration > 0 ? currentTrack.duration : 0;
      const scrobbleDur = Math.max(effDur, trackDur);
      // Browser clocks differ by a few milliseconds; allow a completed, fully
      // listened track to reach a user-selected 100% threshold.
      if (el.ended && effDur > 0 && listening.seconds >= effDur - 0.25) listening.seconds = Math.max(listening.seconds, scrobbleDur);
      listening.sample = { position: cur, wall: now };
      if ((!el.paused || el.ended) && !el.seeking) lastfmRef.current?.sample(listening, currentTrack?.id, scrobbleDur);
      if (!scrobbledRef.current && !listening.pending && currentTrack?.id && effDur > 0 &&
          listening.seconds >= Math.min(effDur * 0.5, 30) && Date.now() >= listening.retryAfter) {
        listening.pending = true;
        api.scrobble(currentTrack.id, listening.eventId).then(() => {
          if (listeningRef.current !== listening) return;
          scrobbledRef.current = true;
          listening.pending = false;
          persist();
        }).catch(() => {
          listening.pending = false;
          listening.retryAfter = Date.now() + 5000;
        });
      }
    };

    const onMeta = () => {
      const effDur = getEffectiveDuration();
      if (pendingSeekRef.current !== null && el.readyState !== 0 && effDur > 0) {
        el.currentTime = Math.min(pendingSeekRef.current, effDur);
        setCurrentTime(el.currentTime);
        pendingSeekRef.current = null;
      }
      setDuration(effDur);
      syncMediaSessionPosition();
    };

    const onEnd = () => {
      onTime();
      resetListening();
      if (sleepUntil === 'track') {
        setSleepUntil(null);
        setIsPlaying(false);
        el.pause();
        return;
      }
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

    const onPlay = () => { listeningRef.current.sample = { position: el.currentTime || 0, wall: performance.now() }; setIsPlaying(true); };
    const onPlaying = () => {
      const listening = listeningRef.current;
      if (!listening.startedAt) listening.startedAt = Math.floor(Date.now() / 1000);
      const trackDur = Number.isFinite(currentTrack?.duration) && currentTrack.duration > 0 ? currentTrack.duration : 0;
      lastfmRef.current?.sample(listening, currentTrack?.id, Math.max(getEffectiveDuration(), trackDur));
    };
    const onPause = () => { onTime(); listeningRef.current.sample = null; setIsPlaying(false); };
    const onSeeking = () => { listeningRef.current.sample = null; };
    const onSeeked = () => { listeningRef.current.sample = { position: el.currentTime || 0, wall: performance.now() }; };
    const onError = () => {
      playRequestIdRef.current += 1;
      setIsPlaying(false);
      const title = currentTrack?.title || currentTrack?.file_name || 'track';
      toast(`Playback error: unable to play "${title}"`, 'error');
    };

    el.addEventListener('seeking', onSeeking);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('play', onPlay);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onError);
    if (el.readyState >= 1) onMeta();
    if (!el.paused && !listeningRef.current.sample) onSeeked();

    return () => {
      el.removeEventListener('seeking', onSeeking);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onError);
    };
  }, [currentTrack, repeat, pickNext, safePlay, sleepUntil]);

  return (
    <PlayerContext.Provider
      value={{
        audioRef,
        currentTrack,
        queue,
        queueIndex,
        queueOrder,
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
        playerView,
        setPlayerView,
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
        addManyToQueue,
        playNext: (track) => addToQueue(track, true),
        moveInQueue,
        clearUpcoming,
        sleepUntil,
        setSleepTimer: (value) => {
          const minutes = Number(value);
          setSleepUntil(value === 'track' ? 'track' : Number.isFinite(minutes) && minutes > 0 && minutes <= 480 ? Date.now() + minutes * 60000 : null);
        },
        isNowPlayingOpen,
        setIsNowPlayingOpen,
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
