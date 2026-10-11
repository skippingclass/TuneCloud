import { useState, useEffect } from 'react';
import { ArrowLeft, Users, Disc, Play, Shuffle, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const [artistImage, setArtistImage] = useState(null);
  const { currentTrack, playTrack } = usePlayer();

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
          if (data?.found && data.artist?.image) {
            setArtistImage(data.artist.image);
          }
        })
        .catch(() => {});
    }
  }, [artist.id, artist.name]);

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  // Group tracks by album for clean discography listing
  const albumGroups = [];
  const map = {};
  for (const t of tracks) {
    const key = t.album || 'Singles & Standalone';
    if (!map[key]) {
      map[key] = {
        title: key,
        album_id: t.album_id,
        cover_path: t.cover_path,
        year: t.year,
        tracks: [],
      };
      albumGroups.push(map[key]);
    }
    map[key].tracks.push(t);
  }

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

  const displayName = resolvedArtist?.name || artist.name || 'Artist';

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-in">
      <button
        onClick={onBack}
        className="btn-glass text-xs py-1.5 px-3 rounded-xl gap-1.5 group"
      >
        <ArrowLeft className="w-3.5 h-3.5 text-surface-400 group-hover:text-accent group-hover:-translate-x-0.5 transition-all" />
        <span>Back to Artists</span>
      </button>

      {/* Hero Header */}
      <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-white/[0.08] relative overflow-hidden flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-end">
        {artistImage && (
          <div
            className="absolute -inset-10 bg-cover bg-center opacity-20 filter blur-3xl pointer-events-none"
            style={{ backgroundImage: `url(${artistImage})` }}
          />
        )}

        <div className="w-36 h-36 sm:w-44 sm:h-44 rounded-full overflow-hidden bg-surface-900 shrink-0 ring-2 ring-white/[0.12] shadow-glass-lg relative z-10">
          {artistImage ? (
            <img
              src={artistImage}
              alt={displayName}
              className="w-full h-full object-cover"
              draggable="false"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/[0.03]">
              <Users className="w-16 h-16 text-surface-500 stroke-1" />
            </div>
          )}
        </div>

        <div className="flex-1 flex flex-col justify-end text-center sm:text-left relative z-10">
          <span className="text-[11px] font-bold tracking-widest text-accent uppercase mb-1">
            Artist Profile
          </span>
          <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight">
            {displayName}
          </h1>
          <div className="flex items-center justify-center sm:justify-start gap-3 mt-3 text-xs text-surface-400">
            <span>{albumGroups.length} {albumGroups.length === 1 ? 'release' : 'releases'}</span>
            <span>·</span>
            <span>{tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}</span>
            <span>·</span>
            <span>{formatDuration(totalDuration)}</span>
          </div>

          {/* Quick Play Controls */}
          {tracks.length > 0 && (
            <div className="flex items-center justify-center sm:justify-start gap-3 mt-5">
              <button
                onClick={handlePlayAll}
                className="btn-primary py-2 px-5 rounded-2xl flex items-center gap-2 text-xs font-bold shadow-glow hover:scale-[1.02] active:scale-[0.98] transition-all"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Play Discography</span>
              </button>
              <button
                onClick={handleShuffle}
                className="btn-glass py-2 px-4 rounded-2xl flex items-center gap-2 text-xs font-semibold hover:border-white/20 transition-all"
              >
                <Shuffle className="w-3.5 h-3.5 text-accent" />
                <span>Shuffle</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Albums with tracks */}
      {loading ? (
        <div className="h-48 flex items-center justify-center gap-2 text-surface-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <span className="text-xs">Loading discography...</span>
        </div>
      ) : albumGroups.length === 0 ? (
        <div className="glass-panel p-12 text-center rounded-3xl border border-white/[0.06] text-surface-400">
          <Disc className="w-12 h-12 stroke-1 text-surface-500 mx-auto mb-3 opacity-60" />
          <p className="text-base font-semibold text-white">No tracks found for this artist</p>
          <p className="text-xs text-surface-500 mt-1">Their files may not be indexed or tagged yet.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {albumGroups.map((group) => (
            <div key={group.title} className="space-y-3">
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
                    · {group.tracks.length} {group.tracks.length === 1 ? 'track' : 'tracks'}
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
  );
}
