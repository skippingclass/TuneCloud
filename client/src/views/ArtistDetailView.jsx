import { useState, useEffect, useMemo } from 'react';
import {
  ArrowLeft,
  Users,
  Disc,
  Play,
  Shuffle,
  Loader2,
  Heart,
  LayoutGrid,
  List,
  Sparkles,
  Clock,
  Music2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatFollowers(num) {
  if (!num || num <= 0) return null;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M followers`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K followers`;
  return `${num} followers`;
}

export function ArtistDetailView({
  artist,
  onBack,
  user,
  onGoToAlbum,
  onGoToArtist,
  onEditTags,
}) {
  const [resolvedArtist, setResolvedArtist] = useState(artist);
  const [albums, setAlbums] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [artistMeta, setArtistMeta] = useState(null);
  const [discographyTab, setDiscographyTab] = useState('all'); // 'all' | 'albums' | 'singles'
  const [viewMode, setViewMode] = useState('grid'); // 'grid' | 'list'
  const [showAllTopTracks, setShowAllTopTracks] = useState(false);

  const { currentTrack, playTrack } = usePlayer();
  const { isArtistStarred, toggleFavoriteArtist } = useFavorites();

  const artistDbId = resolvedArtist?.id || artist?.id;
  const isStarred = artistDbId ? isArtistStarred(artistDbId) : false;

  useEffect(() => {
    setLoading(true);
    const fetchPromise = artist.id
      ? api.artist(artist.id)
      : api.artistByName(artist.name);

    fetchPromise
      .then((res) => {
        if (res && res.artist) {
          setResolvedArtist(res.artist);
          setAlbums(res.albums || []);
          setTracks(res.tracks || []);
        } else if (Array.isArray(res)) {
          setTracks(res);
        }
      })
      .catch((err) => {
        console.error('Failed to load artist details:', err);
      })
      .finally(() => setLoading(false));

    const nameToQuery = artist.name || resolvedArtist?.name;
    if (nameToQuery) {
      api
        .spotifyArtist(nameToQuery)
        .then((data) => {
          if (data?.found && data.artist) {
            setArtistMeta(data.artist);
          }
        })
        .catch(() => {});
    }
  }, [artist.id, artist.name]);

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);
  const displayName = resolvedArtist?.name || artist.name || 'Artist';
  const heroImage = artistMeta?.image || null;

  // Compute top / popular tracks based on play_count (or top 10 order)
  const popularTracks = useMemo(() => {
    if (!tracks || tracks.length === 0) return [];
    const sorted = [...tracks].sort((a, b) => {
      const pcA = a.play_count || 0;
      const pcB = b.play_count || 0;
      if (pcB !== pcA) return pcB - pcA;
      return (b.year || 0) - (a.year || 0);
    });
    return sorted;
  }, [tracks]);

  const displayedTopTracks = showAllTopTracks
    ? popularTracks.slice(0, 10)
    : popularTracks.slice(0, 5);

  // Group tracks by album for clean discography listing
  const albumGroups = useMemo(() => {
    const list = [];
    const map = {};

    // 1. First add known albums from albums array
    for (const alb of albums) {
      const entry = {
        id: alb.id,
        title: alb.title,
        album_id: alb.id,
        cover_path: alb.cover_path,
        year: alb.year,
        genre: alb.genre,
        track_count: alb.track_count || 0,
        duration: alb.duration || 0,
        tracks: [],
      };
      map[alb.id] = entry;
      list.push(entry);
    }

    // 2. Associate tracks with albums or loose groups
    for (const t of tracks) {
      if (t.album_id && map[t.album_id]) {
        map[t.album_id].tracks.push(t);
      } else {
        const titleKey = t.album || 'Singles & Standalone';
        let found = list.find((g) => g.title === titleKey);
        if (!found) {
          found = {
            id: t.album_id || `loose-${titleKey}`,
            title: titleKey,
            album_id: t.album_id,
            cover_path: t.cover_path,
            year: t.year,
            genre: t.genre,
            tracks: [],
          };
          list.push(found);
        }
        found.tracks.push(t);
      }
    }

    // Update track_count and cover_path fallback if missing
    for (const g of list) {
      if (!g.track_count || g.track_count === 0) {
        g.track_count = g.tracks.length;
      }
      if (!g.cover_path && g.tracks.length > 0) {
        g.cover_path = g.tracks[0].cover_path;
      }
    }

    return list;
  }, [albums, tracks]);

  // Categorize releases: Full Albums vs Singles & EPs
  const { fullAlbums, singlesAndEPs } = useMemo(() => {
    const full = [];
    const singles = [];

    for (const alb of albumGroups) {
      const isSingle =
        alb.track_count <= 3 ||
        alb.title.toLowerCase().includes(' - single') ||
        alb.title.toLowerCase().includes(' - ep') ||
        alb.title.toLowerCase().endsWith(' single') ||
        alb.title.toLowerCase().endsWith(' ep') ||
        alb.title === 'Singles & Standalone';

      if (isSingle) {
        singles.push(alb);
      } else {
        full.push(alb);
      }
    }

    return { fullAlbums: full, singlesAndEPs: singles };
  }, [albumGroups]);

  const filteredReleases = useMemo(() => {
    if (discographyTab === 'albums') return fullAlbums;
    if (discographyTab === 'singles') return singlesAndEPs;
    return albumGroups;
  }, [discographyTab, fullAlbums, singlesAndEPs, albumGroups]);

  const handlePlayAll = () => {
    if (tracks.length > 0) {
      playTrack(tracks[0], tracks);
    }
  };

  const handleShuffle = () => {
    if (tracks.length > 0) {
      const shuffled = [...tracks].sort(() => Math.random() - 0.5);
      playTrack(shuffled[0], shuffled);
    }
  };

  const handleToggleStar = () => {
    if (artistDbId) {
      toggleFavoriteArtist(artistDbId);
    }
  };

  const handlePlayAlbum = (album) => {
    const albTracks = tracks.filter(
      (t) => t.album_id === album.album_id || t.album === album.title
    );
    if (albTracks.length > 0) {
      playTrack(albTracks[0], albTracks);
    } else if (album.album_id) {
      api.album(album.album_id).then((res) => {
        const list = res?.tracks || res || [];
        if (list.length > 0) playTrack(list[0], list);
      });
    }
  };

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-in pb-16">
      {/* Back Button */}
      <div>
        <button
          onClick={onBack}
          className="btn-glass text-xs py-1.5 px-3 rounded-xl gap-1.5 group inline-flex items-center"
        >
          <ArrowLeft className="w-3.5 h-3.5 text-surface-400 group-hover:text-accent group-hover:-translate-x-0.5 transition-all" />
          <span>Back</span>
        </button>
      </div>

      {/* Cinematic Hero Section */}
      <div className="glass-panel p-6 sm:p-10 rounded-3xl border border-white/[0.08] relative overflow-hidden shadow-2xl">
        {/* Ambient Blurred Backdrop */}
        {heroImage && (
          <div
            className="absolute -inset-16 bg-cover bg-center opacity-30 filter blur-3xl pointer-events-none scale-110"
            style={{ backgroundImage: `url(${heroImage})` }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-surface-950 via-surface-950/60 to-transparent pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row items-center md:items-end gap-6 sm:gap-8 text-center md:text-left">
          {/* Large Artist Portrait */}
          <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full overflow-hidden bg-surface-900 shrink-0 ring-4 ring-white/[0.12] shadow-2xl relative group">
            {heroImage ? (
              <img
                src={heroImage}
                alt={displayName}
                className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                draggable="false"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-white/[0.03]">
                <Users className="w-20 h-20 text-surface-500 stroke-1" />
              </div>
            )}
          </div>

          {/* Artist Metadata & Controls */}
          <div className="flex-1 flex flex-col justify-end space-y-3">
            <div className="flex items-center justify-center md:justify-start gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/15 border border-accent/25 text-accent text-[11px] font-bold tracking-wider uppercase">
                <Sparkles className="w-3 h-3 fill-current" />
                Artist
              </span>
              {artistMeta?.followers > 0 && (
                <span className="text-xs text-surface-400 font-medium">
                  {formatFollowers(artistMeta.followers)}
                </span>
              )}
            </div>

            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black text-white tracking-tight leading-none drop-shadow-md">
              {displayName}
            </h1>

            {/* Quick Stats Chips */}
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 text-xs text-surface-400 font-medium pt-1">
              <span className="inline-flex items-center gap-1">
                <Disc className="w-3.5 h-3.5 text-surface-400" />
                {albumGroups.length} {albumGroups.length === 1 ? 'release' : 'releases'}
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Music2 className="w-3.5 h-3.5 text-surface-400" />
                {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-surface-400" />
                {formatDuration(totalDuration)}
              </span>
            </div>

            {/* Actions: Play Discography, Shuffle, Star */}
            {tracks.length > 0 && (
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-3 pt-3">
                <button
                  onClick={handlePlayAll}
                  className="btn-primary py-2.5 px-6 rounded-2xl flex items-center gap-2.5 text-xs font-bold shadow-glow hover:scale-[1.03] active:scale-[0.98] transition-all"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>Play All</span>
                </button>

                <button
                  onClick={handleShuffle}
                  className="btn-glass py-2.5 px-5 rounded-2xl flex items-center gap-2 text-xs font-semibold hover:border-white/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                >
                  <Shuffle className="w-3.5 h-3.5 text-accent" />
                  <span>Shuffle</span>
                </button>

                {artistDbId && (
                  <button
                    onClick={handleToggleStar}
                    className={`btn-glass p-2.5 rounded-2xl transition-all ${
                      isStarred
                        ? 'text-rose-400 border-rose-500/30 bg-rose-500/10'
                        : 'text-surface-400 hover:text-white'
                    }`}
                    title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
                  >
                    <Heart
                      className={`w-4 h-4 ${isStarred ? 'fill-current' : ''}`}
                    />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="h-48 flex flex-col items-center justify-center gap-3 text-surface-400">
          <Loader2 className="w-7 h-7 animate-spin text-accent" />
          <span className="text-xs font-medium">Loading artist discography...</span>
        </div>
      ) : tracks.length === 0 ? (
        <div className="glass-panel p-12 text-center rounded-3xl border border-white/[0.06] text-surface-400">
          <Disc className="w-12 h-12 stroke-1 text-surface-500 mx-auto mb-3 opacity-60" />
          <p className="text-base font-semibold text-white">No tracks found for this artist</p>
          <p className="text-xs text-surface-500 mt-1">Their files may not be indexed or tagged yet.</p>
        </div>
      ) : (
        <div className="space-y-10">
          {/* Section 1: Popular Tracks (Top 5 / Top 10) */}
          {popularTracks.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                  <span>Popular</span>
                </h2>
                {popularTracks.length > 5 && (
                  <button
                    onClick={() => setShowAllTopTracks((prev) => !prev)}
                    className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors flex items-center gap-1"
                  >
                    <span>{showAllTopTracks ? 'Show Top 5' : 'Show Top 10'}</span>
                    {showAllTopTracks ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>

              <div className="glass-panel rounded-2xl overflow-hidden border border-white/[0.06]">
                <table className="w-full text-left border-collapse">
                  <tbody className="divide-y divide-white/[0.03]">
                    {displayedTopTracks.map((track, idx) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={idx}
                        onPlay={(t) => playTrack(t, popularTracks)}
                        isPlaying={currentTrack?.id === track.id}
                        user={user}
                        onEditTags={onEditTags}
                        onGoToAlbum={onGoToAlbum}
                        onGoToArtist={onGoToArtist}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Section 2: Discography with Tabs & View Switcher */}
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-1">
              <h2 className="text-xl font-bold text-white tracking-tight">
                Discography
              </h2>

              <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                {/* Category Filter Tabs */}
                <div className="flex items-center bg-white/[0.04] p-1 rounded-xl border border-white/[0.08] text-xs">
                  <button
                    onClick={() => setDiscographyTab('all')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      discographyTab === 'all'
                        ? 'bg-accent/20 text-accent shadow-sm'
                        : 'text-surface-400 hover:text-white'
                    }`}
                  >
                    All ({albumGroups.length})
                  </button>
                  {fullAlbums.length > 0 && (
                    <button
                      onClick={() => setDiscographyTab('albums')}
                      className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                        discographyTab === 'albums'
                          ? 'bg-accent/20 text-accent shadow-sm'
                          : 'text-surface-400 hover:text-white'
                      }`}
                    >
                      Albums ({fullAlbums.length})
                    </button>
                  )}
                  {singlesAndEPs.length > 0 && (
                    <button
                      onClick={() => setDiscographyTab('singles')}
                      className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                        discographyTab === 'singles'
                          ? 'bg-accent/20 text-accent shadow-sm'
                          : 'text-surface-400 hover:text-white'
                      }`}
                    >
                      Singles & EPs ({singlesAndEPs.length})
                    </button>
                  )}
                </div>

                {/* View Mode Toggle (Grid vs List) */}
                <div className="flex items-center bg-white/[0.04] p-1 rounded-xl border border-white/[0.08]">
                  <button
                    onClick={() => setViewMode('grid')}
                    className={`p-1.5 rounded-lg transition-all ${
                      viewMode === 'grid'
                        ? 'bg-white/[0.1] text-white shadow-sm'
                        : 'text-surface-500 hover:text-surface-300'
                    }`}
                    title="Grid view"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setViewMode('list')}
                    className={`p-1.5 rounded-lg transition-all ${
                      viewMode === 'list'
                        ? 'bg-white/[0.1] text-white shadow-sm'
                        : 'text-surface-500 hover:text-surface-300'
                    }`}
                    title="List view"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Discography Content: Grid View or List View */}
            {filteredReleases.length === 0 ? (
              <div className="glass-panel p-8 text-center rounded-2xl border border-white/[0.06] text-surface-400">
                <p className="text-sm">No releases in this category</p>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                {filteredReleases.map((alb) => (
                  <AlbumCard
                    key={alb.id}
                    album={{
                      id: alb.album_id || alb.id,
                      title: alb.title,
                      cover_path: alb.cover_path,
                      artist: displayName,
                      artist_id: artistDbId,
                      year: alb.year,
                      track_count: alb.track_count,
                    }}
                    onClick={() => {
                      if (alb.album_id) {
                        onGoToAlbum?.({
                          id: alb.album_id,
                          title: alb.title,
                          cover_path: alb.cover_path,
                        });
                      }
                    }}
                    onPlay={() => handlePlayAlbum(alb)}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-6">
                {filteredReleases.map((group) => (
                  <div key={group.id} className="space-y-2.5">
                    <div className="flex items-center justify-between px-1">
                      <div className="flex items-center gap-3">
                        <Disc className="w-4 h-4 text-accent" />
                        <h3 className="text-base font-bold text-white tracking-tight">
                          {group.title}
                        </h3>
                        {group.year && (
                          <span className="text-xs text-surface-500 font-mono">
                            ({group.year})
                          </span>
                        )}
                        <span className="text-xs text-surface-500">
                          · {group.tracks.length}{' '}
                          {group.tracks.length === 1 ? 'track' : 'tracks'}
                        </span>
                      </div>
                      {group.album_id && (
                        <button
                          onClick={() =>
                            onGoToAlbum?.({
                              id: group.album_id,
                              title: group.title,
                              cover_path: group.cover_path,
                            })
                          }
                          className="text-xs text-accent hover:text-accent-hover font-semibold transition-colors"
                        >
                          View Album
                        </button>
                      )}
                    </div>

                    <div className="glass-panel rounded-2xl overflow-hidden border border-white/[0.06]">
                      <table className="w-full text-left border-collapse">
                        <tbody className="divide-y divide-white/[0.03]">
                          {group.tracks.map((track, idx) => (
                            <TrackRow
                              key={track.id}
                              track={track}
                              index={idx}
                              onPlay={(t) => playTrack(t, tracks)}
                              isPlaying={currentTrack?.id === track.id}
                              user={user}
                              onEditTags={onEditTags}
                              onGoToAlbum={onGoToAlbum}
                              onGoToArtist={onGoToArtist}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
