import { useState, useEffect } from 'react';
import { ArrowLeft, Users, Disc, Play, Loader2 } from 'lucide-react';
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
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [artistImage, setArtistImage] = useState(null);
  const { currentTrack, playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    api
      .tracks({ limit: 10000, sort: 'album', order: 'asc' })
      .then((res) => {
        const filtered = (res.tracks || []).filter((t) => t.artist === artist.name);
        filtered.sort((a, b) => {
          const aa = a.album || '';
          const bb = b.album || '';
          if (aa !== bb) return aa.localeCompare(bb);
          return (a.track_number || 999) - (b.track_number || 999);
        });
        setTracks(filtered);
      })
      .finally(() => setLoading(false));

    api
      .spotifyArtist(artist.name)
      .then((data) => {
        if (data?.found && data.artist?.image) {
          setArtistImage(data.artist.image);
        }
      })
      .catch(() => {});
  }, [artist.name]);

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  // Group by albums
  const albumGroups = [];
  const map = {};
  for (const t of tracks) {
    const key = t.album || 'Singles & Other';
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
              alt={artist.name}
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
            {artist.name}
          </h1>
          <div className="flex items-center justify-center sm:justify-start gap-3 mt-3 text-xs text-surface-400">
            <span>{albumGroups.length} releases</span>
            <span>·</span>
            <span>{tracks.length} tracks</span>
            <span>·</span>
            <span>{formatDuration(totalDuration)}</span>
          </div>
        </div>
      </div>

      {/* Albums with tracks */}
      {loading ? (
        <div className="h-48 flex items-center justify-center gap-2 text-surface-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <span className="text-xs">Loading discography...</span>
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
