import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Disc,
  Play,
  Shuffle,
  Heart,
  ArrowRight,
  Loader2,
  Dices,
  RotateCw,
} from "lucide-react";
import { api } from "../api.js";
import { AlbumCard } from "../components/cards/AlbumCard.jsx";
import { GenrePill } from "../components/cards/GenrePill.jsx";
import { usePlayer } from "../context/PlayerContext.jsx";
import { toast } from "../components/layout/Toast.jsx";

function formatDuration(sec) {
  if (!sec || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getSeededIndex(length, salt = "") {
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
      api
        .tracks({ sort: "play_count", order: "desc", limit: 8 })
        .catch(() => ({ tracks: [] })),
    ])
      .then(([allAlbums, allGenres, tracksRes]) => {
        setAlbums(
          Array.isArray(allAlbums) ? allAlbums : allAlbums?.albums || [],
        );
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
          const list = shouldShuffle
            ? [...tracks].sort(() => Math.random() - 0.5)
            : tracks;
          playTrack(list[0], list);
        }
      } catch (err) {
        toast(`Failed to play album: ${err.message}`, "error");
      }
    },
    [playTrack],
  );

  const handlePlayTrack = useCallback(
    (track, queue = []) => {
      const q = queue.length > 0 ? queue : [track];
      playTrack(track, q);
    },
    [playTrack],
  );

  const handlePlayLikedSongs = async () => {
    try {
      const data = await api.favorites({ type: "tracks", all: true });
      const rawTracks = data?.tracks || (Array.isArray(data) ? data : []);
      const tracks = rawTracks.filter((t) => t.available !== false);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
        toast(`Playing Liked Songs (${tracks.length} tracks)`, "success");
      } else {
        toast("No liked tracks yet — click heart to like tracks", "info");
      }
    } catch (err) {
      toast(`Failed to play liked songs: ${err.message}`, "error");
    }
  };

  // 1. Top Spotify 2x4 "On Repeat" Quick Grid
  const onRepeatItems = useMemo(() => {
    // Sort albums by last_played_at or play_count
    const sortedAlbums = [...albums].sort((a, b) => {
      const aPlayed = a.last_played_at
        ? new Date(a.last_played_at).getTime()
        : 0;
      const bPlayed = b.last_played_at
        ? new Date(b.last_played_at).getTime()
        : 0;
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
        type: "album",
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
            type: "track",
            data: tr,
          });
        }
      }
    }

    return items;
  }, [albums, topTracks]);

  const handleItemClick = (item) => {
    if (item.type === "album") {
      onAlbumClick?.(item.data);
    } else if (item.type === "track") {
      handlePlayTrack(item.data, [item.data]);
    }
  };

  const handleItemPlay = async (item) => {
    if (item.type === "album") {
      await handlePlayAlbum(item.data);
    } else if (item.type === "track") {
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
    const baseIndex = getSeededIndex(spotlightPool.length, "spotlight");
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

  if (loading)
    return (
      <div className="h-96 flex items-center justify-center text-surface-400">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );

  const albumRow = (list) => (
    <div className="album-shelf">
      {list.map((album, index) => (
        <AlbumCard
          key={`${album.id}-${index}`}
          album={album}
          onClick={onAlbumClick}
          onArtistClick={onArtistClick}
          onPlay={handlePlayAlbum}
        />
      ))}
    </div>
  );

  return (
    <div className="home-content">
      <section className="repeat-section">
        <div className="section-heading">
          <h2>On repeat</h2>
        </div>
        <div className="repeat-grid">
          <div className="repeat-item">
            <button
              className="repeat-open"
              onClick={() => onNavigate?.("favorites")}
            >
              <span className="liked-art">
                <Heart size={20} strokeWidth={1.5} />
              </span>
              <span>Liked songs</span>
            </button>
            <button
              className="repeat-play"
              aria-label="Play liked songs"
              onClick={(e) => {
                e.stopPropagation();
                handlePlayLikedSongs();
              }}
            >
              <Play size={14} fill="currentColor" />
            </button>
          </div>
          {onRepeatItems.map((item) => (
            <div className="repeat-item" key={item.id}>
              <button
                className="repeat-open"
                onClick={() => handleItemClick(item)}
              >
                <span className="repeat-art">
                  {item.cover_path ? (
                    <img src={api.coverUrl(item.cover_path)} alt="" />
                  ) : (
                    <Disc size={20} />
                  )}
                </span>
                <span title={item.title}>{item.title}</span>
              </button>
              <button
                className="repeat-play"
                aria-label={`Play ${item.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleItemPlay(item);
                }}
              >
                <Play size={14} fill="currentColor" />
              </button>
            </div>
          ))}
        </div>
      </section>

      {spotlightAlbum && (
        <section className="album-spotlight">
          {spotlightAlbum.cover_path && (
            <div
              className="spotlight-atmosphere"
              style={{
                backgroundImage: `url(${api.coverUrl(spotlightAlbum.cover_path)})`,
              }}
            />
          )}
          <div className="spotlight-copy">
            <div className="spotlight-kicker">
              <span>Album of the moment</span>
              <button
                onClick={handleRefreshSpotlight}
                aria-label="Switch spotlight album"
              >
                <Dices size={16} strokeWidth={1.5} />
              </button>
            </div>
            <h1>
              <button
                className="text-left"
                onClick={() => onAlbumClick?.(spotlightAlbum)}
              >
                {spotlightAlbum.title}
              </button>
            </h1>
            <p className="spotlight-meta">
              <button
                onClick={() =>
                  onArtistClick?.({
                    id: spotlightAlbum.artist_id,
                    name: spotlightAlbum.artist,
                  })
                }
              >
                {spotlightAlbum.artist}
              </button>
              {spotlightAlbum.year && (
                <>
                  <span>·</span>
                  <span>{spotlightAlbum.year}</span>
                </>
              )}
              {spotlightAlbum.track_count > 0 && (
                <>
                  <span>·</span>
                  <span>{spotlightAlbum.track_count} tracks</span>
                </>
              )}
              {spotlightAlbum.duration > 0 && (
                <>
                  <span>·</span>
                  <span>{formatDuration(spotlightAlbum.duration)}</span>
                </>
              )}
            </p>
            <div className="spotlight-actions">
              <button
                className="btn-primary"
                onClick={() => handlePlayAlbum(spotlightAlbum)}
              >
                <Play size={16} fill="currentColor" />
                Play album
              </button>
              <button
                className="btn-glass"
                onClick={() => handlePlayAlbum(spotlightAlbum, true)}
              >
                <Shuffle size={16} strokeWidth={1.5} />
                Shuffle
              </button>
              <button
                className="spotlight-link"
                onClick={() => onAlbumClick?.(spotlightAlbum)}
              >
                View album
                <ArrowRight size={16} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <button
            className="spotlight-art"
            onClick={() => onAlbumClick?.(spotlightAlbum)}
            aria-label={`Open ${spotlightAlbum.title}`}
          >
            {spotlightAlbum.cover_path ? (
              <img
                src={api.coverUrl(spotlightAlbum.cover_path)}
                alt={spotlightAlbum.title}
              />
            ) : (
              <Disc size={80} />
            )}
          </button>
        </section>
      )}

      {jumpBackIn.length > 0 && (
        <section>
          <div className="section-heading">
            <h2 onClick={() => onNavigate?.("albums")}>Jump back in</h2>
            <button onClick={() => onNavigate?.("albums")}>
              View library
              <ArrowRight size={14} />
            </button>
          </div>
          {albumRow(jumpBackIn)}
        </section>
      )}
      {rediscoverAlbums.length > 0 && (
        <section>
          <div className="section-heading">
            <div>
              <h2>Rediscover</h2>
              <p>Something you haven't played in a while</p>
            </div>
            <button onClick={handleShuffleRediscover}>
              <RotateCw size={14} />
              Shuffle row
            </button>
          </div>
          {albumRow(rediscoverAlbums)}
        </section>
      )}
      {recentlyAdded.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Recently added</h2>
            <button onClick={() => onNavigate?.("albums")}>
              View all
              <ArrowRight size={14} />
            </button>
          </div>
          {albumRow(recentlyAdded)}
        </section>
      )}
      {genres.length > 0 && (
        <section>
          <div className="section-heading">
            <h2>Explore genres</h2>
          </div>
          <div className="genre-list">
            {genres.slice(0, 14).map((g) => (
              <GenrePill
                key={g.name}
                genre={g.name}
                count={g.track_count}
                onClick={() => onNavigate?.("search", g.name)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
