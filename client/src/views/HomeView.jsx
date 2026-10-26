import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles,
  Disc,
  Play,
  Shuffle,
  Heart,
  ArrowRight,
  Loader2,
  Dices,
  RotateCw,
} from 'lucide-react';
import { api } from '../api.js';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { GenrePill } from '../components/cards/GenrePill.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { toast } from '../components/layout/Toast.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getSeededIndex(length, salt = '') {
  if (length <= 0) return 0;
  const d = new Date();
  const str = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${salt}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % length;
}

export function HomeView({ onAlbumClick, onArtistClick, onNavigate }) {
  const [albums, setAlbums] = useState([]);
  const [genres, setGenres] = useState([]);
  const [topTracks, setTopTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [spotlightOffset, setSpotlightOffset] = useState(0);
  const [rediscoverOffset, setRediscoverOffset] = useState(0);

  const { playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.albums({ limit: 100 }).catch(() => []),
      api.genres().catch(() => []),
      api.tracks({ sort: 'play_count', order: 'desc', limit: 8 }).catch(() => ({ tracks: [] })),
    ])
      .then(([allAlbums, allGenres, tracksRes]) => {
        setAlbums(Array.isArray(allAlbums) ? allAlbums : (allAlbums?.albums || []));
        setGenres(allGenres);
        const tracks = tracksRes?.tracks || [];
        setTopTracks(tracks);
      })
      .finally(() => setLoading(false));
  }, []);

  const handlePlayAlbum = useCallback(
    async (album, shouldShuffle = false) => {
      try {
        const rawTracks = await api.album(album.id);
        const tracks = (rawTracks || []).filter((t) => t.available !== false);
        if (tracks.length > 0) {
          const list = shouldShuffle ? [...tracks].sort(() => Math.random() - 0.5) : tracks;
          playTrack(list[0], list);
        }
      } catch (err) {
        toast(`Failed to play album: ${err.message}`, 'error');
      }
    },
    [playTrack]
  );

  const handlePlayTrack = useCallback(
    (track, queue = []) => {
      const q = queue.length > 0 ? queue : [track];
      playTrack(track, q);
    },
    [playTrack]
  );

  const handlePlayLikedSongs = async () => {
    try {
      const data = await api.favorites({ type: 'tracks', all: true });
      const rawTracks = data?.tracks || (Array.isArray(data) ? data : []);
      const tracks = rawTracks.filter((t) => t.available !== false);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
        toast(`Playing Liked Songs (${tracks.length} tracks)`, 'success');
      } else {
        toast('No liked tracks yet — click heart to like tracks', 'info');
      }
    } catch (err) {
      toast(`Failed to play liked songs: ${err.message}`, 'error');
    }
  };

  // 1. Top Spotify 2x4 "On Repeat" Quick Grid
  const onRepeatItems = useMemo(() => {
    // Sort albums by last_played_at or play_count
    const sortedAlbums = [...albums].sort((a, b) => {
      const aPlayed = a.last_played_at ? new Date(a.last_played_at).getTime() : 0;
      const bPlayed = b.last_played_at ? new Date(b.last_played_at).getTime() : 0;
      if (bPlayed !== aPlayed) return bPlayed - aPlayed;
      return (b.play_count || 0) - (a.play_count || 0);
    });

    const items = [];
    for (let i = 0; i < Math.min(7, sortedAlbums.length); i++) {
      const al = sortedAlbums[i];
      items.push({
        id: `album-${al.id}`,
        title: al.title,
        cover_path: al.cover_path,
        type: 'album',
        data: al,
      });
    }

    // Fallback: fill up to 7 with top tracks if albums count is low
    if (items.length < 7 && topTracks.length > 0) {
      for (const tr of topTracks) {
        if (items.length >= 7) break;
        if (!items.some((it) => it.title === tr.title)) {
          items.push({
            id: `track-${tr.id}`,
            title: tr.title || tr.file_name,
            cover_path: tr.cover_path,
            type: 'track',
            data: tr,
          });
        }
      }
    }

    return items;
  }, [albums, topTracks]);

  const handleItemClick = (item) => {
    if (item.type === 'album') {
      onAlbumClick?.(item.data);
    } else if (item.type === 'track') {
      handlePlayTrack(item.data, [item.data]);
    }
  };

  const handleItemPlay = async (item) => {
    if (item.type === 'album') {
      await handlePlayAlbum(item.data);
    } else if (item.type === 'track') {
      handlePlayTrack(item.data, [item.data]);
    }
  };

  // 2. Spotlight Album ("Album of the Moment")
  const spotlightPool = useMemo(() => {
    if (albums.length === 0) return [];
    return [...albums].sort((a, b) => {
      const aVal = (a.play_count || 0) * 2 + (a.track_count || 0);
      const bVal = (b.play_count || 0) * 2 + (b.track_count || 0);
      return bVal - aVal;
    });
  }, [albums]);

  const spotlightAlbum = useMemo(() => {
    if (spotlightPool.length === 0) return null;
    const baseIndex = getSeededIndex(spotlightPool.length, 'spotlight');
    const actualIndex = (baseIndex + spotlightOffset) % spotlightPool.length;
    return spotlightPool[actualIndex];
  }, [spotlightPool, spotlightOffset]);

  const handleRefreshSpotlight = () => {
    setSpotlightOffset((prev) => prev + 1);
  };

  // 3. Jump back in (Strictly by last_played_at DESC, fallback to remaining)
  const jumpBackIn = useMemo(() => {
    const played = albums.filter((a) => a.last_played_at != null);
    if (played.length >= 4) {
      return [...played]
        .sort((a, b) => new Date(b.last_played_at) - new Date(a.last_played_at))
        .slice(0, 6);
    }
    const remaining = albums.filter((a) => !played.includes(a));
    return [...played, ...remaining].slice(0, 6);
  }, [albums]);

  // 4. Rediscover (Forgotten Gems)
  const rediscoverPool = useMemo(() => {
    return albums.filter((a) => !a.last_played_at || (a.play_count || 0) === 0);
  }, [albums]);

  const rediscoverAlbums = useMemo(() => {
    const pool = rediscoverPool.length >= 6 ? rediscoverPool : albums;
    if (pool.length === 0) return [];
    const base = getSeededIndex(pool.length, `rediscover-${rediscoverOffset}`);
    const results = [];
    for (let i = 0; i < Math.min(6, pool.length); i++) {
      results.push(pool[(base + i * 3) % pool.length]);
    }
    return results;
  }, [rediscoverPool, albums, rediscoverOffset]);

  const handleShuffleRediscover = () => {
    setRediscoverOffset((prev) => prev + 1);
  };

  // 5. Recently Added
  const recentlyAdded = useMemo(() => {
    return [...albums]
      .sort((a, b) => {
        if (b.created_at && a.created_at) {
          return new Date(b.created_at) - new Date(a.created_at);
        }
        return (b.id || 0) - (a.id || 0);
      })
      .slice(0, 12);
  }, [albums]);

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading your music hub...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-in">
      {/* 1. On Repeat: The iconic Spotify 2x4 Quick Grid at the very top */}
      <section className="space-y-3.5">
        <div className="flex items-center justify-between">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            On Repeat
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
          {/* Slot 1: Liked Songs card with purple gradient & heart */}
          <div
            onClick={() => onNavigate?.('favorites')}
            className="group relative flex items-center bg-white/[0.07] hover:bg-white/[0.14] active:bg-white/[0.18] rounded-md sm:rounded-lg overflow-hidden transition-all duration-200 cursor-pointer border border-white/[0.04] shadow-sm h-14 sm:h-16 select-none"
          >
            <div className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 bg-gradient-to-br from-[#450af5] to-[#8e8ee5] flex items-center justify-center shadow-inner">
              <Heart className="w-5 h-5 sm:w-6 sm:h-6 fill-white text-white drop-shadow" />
            </div>
            <span className="font-bold text-xs sm:text-sm text-white truncate px-3 flex-1 leading-snug">
              Liked Songs
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handlePlayLikedSongs();
              }}
              className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-accent text-surface-950 flex items-center justify-center opacity-0 group-hover:opacity-100 shadow-[0_8px_16px_rgba(0,0,0,0.5)] transition-all duration-200 hover:scale-105 active:scale-95 shrink-0 mr-3 drop-shadow-md"
              title="Play Liked Songs"
            >
              <Play className="w-4 h-4 fill-surface-950 ml-0.5" />
            </button>
          </div>

          {/* Slots 2-8: Top heavy rotation releases */}
          {onRepeatItems.map((item) => (
            <div
              key={item.id}
              onClick={() => handleItemClick(item)}
              className="group relative flex items-center bg-white/[0.07] hover:bg-white/[0.14] active:bg-white/[0.18] rounded-md sm:rounded-lg overflow-hidden transition-all duration-200 cursor-pointer border border-white/[0.04] shadow-sm h-14 sm:h-16 select-none"
            >
              <div className="w-14 h-14 sm:w-16 sm:h-16 shrink-0 bg-surface-900 relative shadow-sm">
                {item.cover_path ? (
                  <img
                    src={api.coverUrl(item.cover_path)}
                    alt=""
                    className="w-full h-full object-cover"
                    draggable="false"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-white/[0.04]">
                    <Disc className="w-6 h-6 text-surface-500" />
                  </div>
                )}
              </div>
              <span className="font-bold text-xs sm:text-sm text-white truncate px-3 flex-1 leading-snug">
                {item.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleItemPlay(item);
                }}
                className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-accent text-surface-950 flex items-center justify-center opacity-0 group-hover:opacity-100 shadow-[0_8px_16px_rgba(0,0,0,0.5)] transition-all duration-200 hover:scale-105 active:scale-95 shrink-0 mr-3 drop-shadow-md"
                title={`Play ${item.title}`}
              >
                <Play className="w-4 h-4 fill-surface-950 ml-0.5" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* 2. Spotlight: Album of the Moment */}
      {spotlightAlbum && (
        <section className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-surface-900/90 via-surface-900/70 to-surface-950/85 border border-white/[0.08] p-5 sm:p-7 shadow-glass flex flex-col sm:flex-row items-center justify-between gap-6">
          {/* Ambient Glow */}
          {spotlightAlbum.cover_path && (
            <div
              className="absolute -inset-10 bg-cover bg-center opacity-25 filter blur-3xl pointer-events-none transition-all duration-700"
              style={{ backgroundImage: `url(${api.coverUrl(spotlightAlbum.cover_path)})` }}
            />
          )}

          {/* Info side */}
          <div className="flex-1 min-w-0 z-10 w-full text-center sm:text-left">
            <div className="flex items-center justify-center sm:justify-start gap-2.5 mb-2.5">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/15 border border-accent/25 text-accent text-[11px] font-bold tracking-wider uppercase">
                <Sparkles className="w-3.5 h-3.5" />
                Album of the Moment
              </span>
              <button
                onClick={handleRefreshSpotlight}
                className="p-1 rounded-lg text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                title="Switch spotlight album"
              >
                <Dices className="w-4 h-4 text-accent" />
              </button>
            </div>

            <h2
              onClick={() => onAlbumClick?.(spotlightAlbum)}
              className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight hover:underline cursor-pointer transition-all line-clamp-2"
            >
              {spotlightAlbum.title}
            </h2>

            <p className="text-sm sm:text-base text-surface-300 font-medium mt-1">
              <button
                onClick={() =>
                  onArtistClick?.({ id: spotlightAlbum.artist_id, name: spotlightAlbum.artist })
                }
                className="hover:underline hover:text-accent transition-colors"
              >
                {spotlightAlbum.artist}
              </button>
              {spotlightAlbum.year && (
                <span className="text-surface-500 font-normal"> · {spotlightAlbum.year}</span>
              )}
              {spotlightAlbum.track_count > 0 && (
                <span className="text-surface-500 font-normal"> · {spotlightAlbum.track_count} tracks</span>
              )}
              {spotlightAlbum.duration > 0 && (
                <span className="text-surface-500 font-normal"> · {formatDuration(spotlightAlbum.duration)}</span>
              )}
            </p>

            {/* Buttons */}
            <div className="flex items-center justify-center sm:justify-start gap-3 mt-5">
              <button
                onClick={() => handlePlayAlbum(spotlightAlbum, false)}
                className="btn-primary px-5 py-2.5 rounded-full shadow-glow"
              >
                <Play className="w-4 h-4 fill-surface-950" />
                <span>Play Album</span>
              </button>
              <button
                onClick={() => handlePlayAlbum(spotlightAlbum, true)}
                className="btn-glass px-4 py-2.5 rounded-full"
              >
                <Shuffle className="w-4 h-4 text-accent" />
                <span>Shuffle</span>
              </button>
              <button
                onClick={() => onAlbumClick?.(spotlightAlbum)}
                className="btn-glass px-4 py-2.5 rounded-full"
              >
                <span>Go to Album</span>
                <ArrowRight className="w-3.5 h-3.5 text-surface-400" />
              </button>
            </div>
          </div>

          {/* Cover side */}
          <div
            onClick={() => onAlbumClick?.(spotlightAlbum)}
            className="w-36 h-36 sm:w-48 sm:h-48 rounded-xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.12] shadow-2xl relative z-10 group cursor-pointer hover:scale-[1.02] transition-transform"
            title="Open album"
          >
            {spotlightAlbum.cover_path ? (
              <img
                src={api.coverUrl(spotlightAlbum.cover_path)}
                alt={spotlightAlbum.title}
                className="w-full h-full object-cover"
                draggable="false"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white/[0.02]">
                <Disc className="w-16 h-16 text-surface-600 stroke-1" />
              </div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
              <Play className="w-8 h-8 text-white fill-white drop-shadow-md" />
            </div>
          </div>
        </section>
      )}

      {/* 3. Jump back in */}
      {jumpBackIn.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2
              onClick={() => onNavigate?.('albums')}
              className="text-xl sm:text-2xl font-bold tracking-tight text-white hover:underline cursor-pointer"
            >
              Jump back in
            </h2>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-bold text-surface-400 hover:text-white uppercase tracking-wider transition-colors"
            >
              Show all
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {jumpBackIn.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>
        </section>
      )}

      {/* 4. Rediscover */}
      {rediscoverAlbums.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                Rediscover
              </h2>
              <p className="text-xs text-surface-400 mt-0.5">
                Forgotten gems from your collection
              </p>
            </div>
            <button
              onClick={handleShuffleRediscover}
              className="text-xs font-bold text-surface-400 hover:text-accent flex items-center gap-1.5 transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Shuffle Row</span>
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {rediscoverAlbums.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>
        </section>
      )}

      {/* 5. Recently added */}
      {recentlyAdded.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2
              onClick={() => onNavigate?.('albums')}
              className="text-xl sm:text-2xl font-bold tracking-tight text-white hover:underline cursor-pointer"
            >
              Recently added
            </h2>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-bold text-surface-400 hover:text-white uppercase tracking-wider transition-colors"
            >
              Show all
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {recentlyAdded.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>
        </section>
      )}

      {/* 6. Explore Genres */}
      {genres.length > 0 && (
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              Explore Genres
            </h2>
          </div>

          <div className="flex items-center gap-2.5 overflow-x-auto pb-2 scrollbar-none flex-wrap">
            {genres.slice(0, 14).map((g) => (
              <GenrePill
                key={g.name}
                genre={g.name}
                count={g.track_count}
                onClick={() => onNavigate?.('search', g.name)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
