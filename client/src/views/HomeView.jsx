import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Sparkles,
  Disc,
  Play,
  Shuffle,
  Clock,
  Flame,
  ArrowRight,
  Loader2,
  Dices,
  Zap,
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
  const [actionLoading, setActionLoading] = useState(false);

  const { playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.albums().catch(() => []),
      api.genres().catch(() => []),
      api.tracks({ sort: 'play_count', order: 'desc', limit: 8 }).catch(() => ({ tracks: [] })),
    ])
      .then(([allAlbums, allGenres, tracksRes]) => {
        setAlbums(allAlbums);
        setGenres(allGenres);
        const tracks = tracksRes?.tracks || [];
        setTopTracks(tracks);
      })
      .finally(() => setLoading(false));
  }, []);

  const handlePlayAlbum = useCallback(
    async (album, shouldShuffle = false) => {
      try {
        const tracks = await api.album(album.id);
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

  // Quick Action 1: Shuffle Entire Library
  const handleShuffleLibrary = async () => {
    setActionLoading(true);
    try {
      const res = await api.tracks({ sort: 'random', limit: 50 });
      const tracks = res?.tracks || [];
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
        toast(`Shuffling 50 tracks from your library`, 'success');
      } else {
        toast('No tracks found to shuffle', 'info');
      }
    } catch (err) {
      toast(`Failed to shuffle library: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Quick Action 2: Random Album
  const handlePlayRandomAlbum = async () => {
    if (albums.length === 0) return;
    const randomIndex = Math.floor(Math.random() * albums.length);
    const randomAlbum = albums[randomIndex];
    toast(`Playing random album: ${randomAlbum.title}`, 'info');
    await handlePlayAlbum(randomAlbum);
  };

  // Top Genre for Quick Mix
  const topGenre = useMemo(() => {
    if (genres.length > 0 && genres[0]?.name) {
      return genres[0].name;
    }
    return null;
  }, [genres]);

  // Quick Action 3: Quick Top Genre Mix
  const handlePlayTopGenre = async () => {
    if (!topGenre) return;
    setActionLoading(true);
    try {
      const res = await api.tracks({ genre: topGenre, sort: 'random', limit: 50 });
      const tracks = res?.tracks || [];
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
        toast(`Playing ${topGenre} mix (${tracks.length} tracks)`, 'success');
      } else {
        toast(`No tracks found for genre ${topGenre}`, 'info');
      }
    } catch (err) {
      toast(`Failed to play ${topGenre} mix: ${err.message}`, 'error');
    } finally {
      setActionLoading(false);
    }
  };

  // Quick Action 4: Scroll to Recently Added
  const scrollToRecentlyAdded = () => {
    const el = document.getElementById('recently-added-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Algorithm for Spotlight Album:
  // Prefer albums with high play count or unplayed in a while
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

  // Dynamic Section 1: Jump Back In (Strictly by last_played_at DESC, fallback to top albums)
  const jumpBackIn = useMemo(() => {
    const played = albums.filter((a) => a.last_played_at != null);
    if (played.length >= 4) {
      return [...played]
        .sort((a, b) => new Date(b.last_played_at) - new Date(a.last_played_at))
        .slice(0, 6);
    }
    // Fallback: mix played and first few albums
    const remaining = albums.filter((a) => !played.includes(a));
    return [...played, ...remaining].slice(0, 6);
  }, [albums]);

  // Dynamic Section 2: Rediscover / Forgotten Gems (Unplayed or lowest play count, shuffled)
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

  // Dynamic Section 3: Recently Added (Sort by ID desc / created_at desc)
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
      {/* 1. Quick Actions / Smart Mixes Bar */}
      <div className="flex items-center gap-2.5 overflow-x-auto pb-1 scrollbar-none flex-nowrap">
        <button
          onClick={handleShuffleLibrary}
          disabled={actionLoading}
          className="glass-pill flex items-center gap-2 hover:border-accent/40 hover:text-white shrink-0 group transition-all active:scale-95"
          title="Shuffle 50 tracks across your whole library"
        >
          <Dices className="w-3.5 h-3.5 text-accent group-hover:rotate-45 transition-transform" />
          <span className="font-medium text-xs">Shuffle Library</span>
        </button>

        <button
          onClick={handlePlayRandomAlbum}
          disabled={albums.length === 0}
          className="glass-pill flex items-center gap-2 hover:border-accent/40 hover:text-white shrink-0 group transition-all active:scale-95"
          title="Pick and start a random album"
        >
          <Disc className="w-3.5 h-3.5 text-accent group-hover:scale-110 transition-transform" />
          <span className="font-medium text-xs">Random Album</span>
        </button>

        {topGenre && (
          <button
            onClick={handlePlayTopGenre}
            disabled={actionLoading}
            className="glass-pill flex items-center gap-2 hover:border-accent/40 hover:text-white shrink-0 group transition-all active:scale-95"
            title={`Instant mix for ${topGenre}`}
          >
            <Zap className="w-3.5 h-3.5 text-accent group-hover:scale-110 transition-transform" />
            <span className="font-medium text-xs">Quick {topGenre} Mix</span>
          </button>
        )}

        <button
          onClick={scrollToRecentlyAdded}
          className="glass-pill flex items-center gap-2 hover:border-accent/40 hover:text-white shrink-0 group transition-all active:scale-95"
          title="Jump down to recently added releases"
        >
          <Clock className="w-3.5 h-3.5 text-accent group-hover:scale-110 transition-transform" />
          <span className="font-medium text-xs">Recently Added</span>
        </button>
      </div>

      {/* 2. Hero Spotlight "Album of the Moment" */}
      {spotlightAlbum && (
        <section className="glass-panel p-5 sm:p-7 rounded-3xl border border-white/[0.08] relative overflow-hidden flex flex-col sm:flex-row gap-6 sm:gap-8 items-center shadow-glass-lg">
          {/* Ambient Glow from cover */}
          {spotlightAlbum.cover_path && (
            <div
              className="absolute -inset-10 bg-cover bg-center opacity-30 filter blur-3xl pointer-events-none transition-all duration-700"
              style={{ backgroundImage: `url(${api.coverUrl(spotlightAlbum.cover_path)})` }}
            />
          )}

          {/* Album artwork */}
          <div
            onClick={() => onAlbumClick?.(spotlightAlbum)}
            className="w-40 h-40 sm:w-52 sm:h-52 rounded-2xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.12] shadow-2xl relative z-10 group cursor-pointer"
            title="Click to open album"
          >
            {spotlightAlbum.cover_path ? (
              <img
                src={api.coverUrl(spotlightAlbum.cover_path)}
                alt={spotlightAlbum.title}
                className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
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

          {/* Spotlight metadata & actions */}
          <div className="flex-1 flex flex-col justify-between text-center sm:text-left relative z-10 w-full min-w-0">
            <div>
              <div className="flex items-center justify-between gap-3 w-full mb-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/15 border border-accent/25 text-accent text-[11px] font-bold tracking-wider uppercase">
                  <Sparkles className="w-3.5 h-3.5" />
                  Album of the Moment
                </span>
                <button
                  onClick={handleRefreshSpotlight}
                  className="btn-glass text-xs py-1 px-2.5 rounded-lg gap-1.5 text-surface-300 hover:text-white"
                  title="Switch to another spotlight album"
                >
                  <Dices className="w-3.5 h-3.5 text-accent" />
                  <span className="hidden sm:inline">Refresh Spotlight</span>
                </button>
              </div>

              <h1
                onClick={() => onAlbumClick?.(spotlightAlbum)}
                className="text-2xl sm:text-3xl lg:text-4xl font-extrabold text-white tracking-tight hover:text-accent cursor-pointer transition-colors line-clamp-2"
              >
                {spotlightAlbum.title}
              </h1>

              <button
                onClick={() =>
                  onArtistClick?.({ id: spotlightAlbum.artist_id, name: spotlightAlbum.artist })
                }
                className="text-base sm:text-lg text-surface-300 hover:text-accent font-medium mt-1 transition-colors hover:underline text-center sm:text-left inline-block"
              >
                {spotlightAlbum.artist}
              </button>

              <div className="flex items-center justify-center sm:justify-start gap-2.5 mt-3 text-xs text-surface-400 flex-wrap">
                {spotlightAlbum.year && (
                  <span className="glass-pill py-0.5 px-2.5 text-surface-300">
                    {spotlightAlbum.year}
                  </span>
                )}
                {spotlightAlbum.genre && (
                  <span className="glass-pill py-0.5 px-2.5 text-surface-300">
                    {spotlightAlbum.genre}
                  </span>
                )}
                {spotlightAlbum.track_count > 0 && (
                  <span>{spotlightAlbum.track_count} tracks</span>
                )}
                {spotlightAlbum.duration > 0 && (
                  <>
                    <span>·</span>
                    <span>{formatDuration(spotlightAlbum.duration)}</span>
                  </>
                )}
              </div>
            </div>

            {/* Buttons inside Hero */}
            <div className="flex items-center justify-center sm:justify-start gap-3 mt-6">
              <button
                onClick={() => handlePlayAlbum(spotlightAlbum, false)}
                className="btn-primary px-5 py-2.5 shadow-glow"
              >
                <Play className="w-4 h-4 fill-surface-950" />
                <span>Play Album</span>
              </button>

              <button
                onClick={() => handlePlayAlbum(spotlightAlbum, true)}
                className="btn-glass px-4 py-2.5"
              >
                <Shuffle className="w-4 h-4 text-accent" />
                <span>Shuffle</span>
              </button>

              <button
                onClick={() => onAlbumClick?.(spotlightAlbum)}
                className="btn-glass px-4 py-2.5"
              >
                <span>Go to Album</span>
                <ArrowRight className="w-3.5 h-3.5 text-surface-400" />
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 3. On Repeat (Heavy Rotation) - Compact Spotify-style Mini Cards */}
      {topTracks.length > 0 && (
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Flame className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                On Repeat
              </h2>
              <span className="text-xs text-surface-500 font-medium hidden sm:inline">
                Heavy Rotation
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {topTracks.map((track) => (
              <div
                key={track.id}
                onClick={() => handlePlayTrack(track, topTracks)}
                className="glass-card p-2 rounded-xl flex items-center gap-3 group hover:bg-white/[0.07] transition-all cursor-pointer relative overflow-hidden border border-white/[0.06]"
              >
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/10 relative">
                  {track.cover_path ? (
                    <img
                      src={api.coverUrl(track.cover_path)}
                      alt=""
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                      draggable="false"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-white/[0.02]">
                      <Disc className="w-6 h-6 text-surface-600 stroke-1" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs sm:text-sm font-semibold truncate text-white group-hover:text-accent transition-colors leading-tight">
                    {track.title || track.file_name}
                  </p>
                  <p className="text-[11px] text-surface-400 truncate mt-0.5">
                    {track.artist || 'Unknown Artist'}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePlayTrack(track, topTracks);
                  }}
                  className="w-8 h-8 rounded-full bg-accent text-surface-950 flex items-center justify-center opacity-0 group-hover:opacity-100 shadow-glow transition-all hover:scale-105 active:scale-95 shrink-0 mr-1"
                  title="Play"
                >
                  <Play className="w-4 h-4 fill-surface-950 ml-0.5" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 4. Jump Back In (Real History / Recently Played) */}
      {jumpBackIn.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Clock className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                Jump Back In
              </h2>
            </div>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
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

      {/* 5. Rediscover / Forgotten Gems */}
      {rediscoverAlbums.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-5 h-5 text-accent" />
              <div>
                <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                  Rediscover
                </h2>
                <p className="text-[11px] text-surface-400">
                  Forgotten gems waiting in your library
                </p>
              </div>
            </div>
            <button
              onClick={handleShuffleRediscover}
              className="btn-glass text-xs py-1.5 px-3 rounded-xl gap-1.5 text-surface-300 hover:text-white"
              title="Shuffle row"
            >
              <RotateCw className="w-3.5 h-3.5 text-accent" />
              <span>Shuffle Row</span>
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
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

      {/* 6. Recently Added Releases */}
      {recentlyAdded.length > 0 && (
        <section id="recently-added-section" className="space-y-4 scroll-mt-20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Disc className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                Recently Added
              </h2>
            </div>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              <span>Explore All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
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

      {/* 7. Explore Genres Strip */}
      {genres.length > 0 && (
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                Explore Genres
              </h2>
            </div>
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
