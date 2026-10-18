import { useState, useEffect, useMemo } from 'react';
import { Play, Pause, Shuffle, Heart, ArrowLeft, Disc, Clock, Loader2, Maximize2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { CoverModal } from '../components/modals/CoverModal.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AlbumDetailView({
  album,
  onBack,
  user,
  onGoToArtist,
  onGoToAlbum,
  onEditTags,
  onAddToPlaylist,
}) {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const { currentTrack, isPlaying, playTrack, togglePlay } = usePlayer();
  const { isAlbumStarred, toggleFavoriteAlbum } = useFavorites();
  const [showCoverModal, setShowCoverModal] = useState(false);

  const starred = isAlbumStarred(album.id);

  const albumArtist =
    tracks[0]?.album_artist ||
    (album.artist && !album.artist.includes(',') ? album.artist : null) ||
    tracks[0]?.primary_artist ||
    (album.artist ? album.artist.split(',')[0].trim() : 'Unknown Artist');

  const albumArtistId =
    album.artist_id ||
    tracks[0]?.album_artist_id ||
    tracks[0]?.artist_id;

  const resolvedAlbum = {
    ...album,
    title: album.title || tracks[0]?.album || 'Album',
    artist: albumArtist,
    artist_id: albumArtistId,
    cover_path: album.cover_path || tracks[0]?.cover_path,
    year: album.year || tracks[0]?.year,
    genre: album.genre || tracks[0]?.genre,
  };

  const isThisAlbum =
    currentTrack &&
    (currentTrack.album_id === album.id ||
      tracks.some((t) => t.id === currentTrack.id));
  const isThisAlbumPlaying = isThisAlbum && isPlaying;

  const reloadTracks = () => {
    setLoading(true);
    api
      .album(album.id)
      .then(setTracks)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reloadTracks();
  }, [album.id]);

  const totalDuration = tracks.reduce((sum, t) => sum + (t.duration || 0), 0);

  const handlePlayAll = () => {
    if (isThisAlbum) {
      togglePlay();
      return;
    }
    if (tracks.length > 0) playTrack(tracks[0], tracks);
  };

  const handleShufflePlay = () => {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    playTrack(shuffled[0], shuffled);
  };

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-in">
      {/* Top back button */}
      <button
        onClick={onBack}
        className="btn-glass text-xs py-1.5 px-3 rounded-xl gap-1.5 group"
      >
        <ArrowLeft className="w-3.5 h-3.5 text-surface-400 group-hover:text-accent group-hover:-translate-x-0.5 transition-all" />
        <span>Back to Albums</span>
      </button>

      {/* Hero Showcase Card */}
      <div className="glass-panel p-5 sm:p-8 rounded-3xl border border-white/[0.08] relative overflow-hidden flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-end">
        {/* Ambient cover blur behind */}
        {resolvedAlbum.cover_path && (
          <div
            className="absolute -inset-10 bg-cover bg-center opacity-20 filter blur-3xl pointer-events-none"
            style={{ backgroundImage: `url(${api.coverUrl(resolvedAlbum.cover_path)})` }}
          />
        )}

        {/* Large Cover */}
        <div
          onClick={() => resolvedAlbum.cover_path && setShowCoverModal(true)}
          className={`w-40 h-40 sm:w-56 sm:h-56 rounded-2xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.12] shadow-glass-lg relative z-10 group ${
            resolvedAlbum.cover_path ? 'cursor-pointer' : ''
          }`}
          title={resolvedAlbum.cover_path ? 'Click to view full cover' : ''}
        >
          {resolvedAlbum.cover_path ? (
            <>
              <img
                src={api.coverUrl(resolvedAlbum.cover_path)}
                alt={resolvedAlbum.title}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                draggable="false"
              />
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                <Maximize2 className="w-6 h-6 text-white drop-shadow-md" />
              </div>
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/[0.03]">
              <Disc className="w-16 h-16 text-surface-500 stroke-1" />
            </div>
          )}
        </div>

        {/* Info & Action Buttons */}
        <div className="flex-1 flex flex-col justify-end text-center sm:text-left relative z-10 w-full">
          <span className="text-[11px] font-bold tracking-widest text-accent uppercase mb-1">
            Album
          </span>
          <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight drop-shadow-md">
            {resolvedAlbum.title}
          </h1>
          <button
            onClick={() => onGoToArtist?.({ id: resolvedAlbum.artist_id, name: resolvedAlbum.artist })}
            className="text-base sm:text-lg text-surface-300 hover:text-accent font-medium mt-1 transition-colors hover:underline text-center sm:text-left inline-block"
          >
            {resolvedAlbum.artist}
          </button>

          <div className="flex items-center justify-center sm:justify-start gap-3 mt-3 text-xs text-surface-400 flex-wrap">
            {resolvedAlbum.year && (
              <span className="glass-pill py-0.5 px-2.5 text-surface-300">
                {resolvedAlbum.year}
              </span>
            )}
            {resolvedAlbum.genre && (
              <span className="glass-pill py-0.5 px-2.5 text-surface-300">
                {resolvedAlbum.genre}
              </span>
            )}
            <span>{tracks.length} tracks</span>
            <span>·</span>
            <span>{formatDuration(totalDuration)}</span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-center sm:justify-start gap-3 mt-6">
            <button
              onClick={handlePlayAll}
              disabled={tracks.length === 0}
              className="btn-primary px-5 py-2.5 shadow-glow"
            >
              {isThisAlbumPlaying ? (
                <>
                  <Pause className="w-4 h-4 fill-surface-950" />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-surface-950" />
                  <span>{isThisAlbum ? 'Resume' : 'Play All'}</span>
                </>
              )}
            </button>
            <button
              onClick={handleShufflePlay}
              disabled={tracks.length === 0}
              className="btn-glass px-4 py-2.5"
            >
              <Shuffle className="w-4 h-4 text-accent" />
              <span>Shuffle</span>
            </button>
            <button
              onClick={() => toggleFavoriteAlbum(album.id)}
              className={`p-2.5 rounded-xl glass-panel transition-all ${
                starred
                  ? 'text-accent border-accent/40 shadow-glow'
                  : 'text-surface-400 hover:text-accent'
              }`}
              title={starred ? 'Unlike Album' : 'Like Album'}
            >
              <Heart className={`w-5 h-5 ${starred ? 'fill-accent' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Track List Table */}
      {loading ? (
        <div className="h-48 flex items-center justify-center gap-2 text-surface-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <span className="text-xs">Loading tracks...</span>
        </div>
      ) : (
        <div className="glass-panel rounded-3xl overflow-hidden border border-white/[0.06]">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.06] text-surface-500 text-[11px] font-semibold uppercase tracking-wider">
                  <th className="px-3 sm:px-4 py-3 text-center w-12">#</th>
                  <th className="w-8 px-1 py-3 text-center"></th>
                  <th className="px-3 sm:px-4 py-3">Title</th>
                  <th className="px-3 sm:px-4 py-3 hidden sm:table-cell">Artist</th>
                  <th className="px-3 sm:px-4 py-3 text-right hidden sm:table-cell">Duration</th>
                  <th className="px-2 py-3 text-center hidden lg:table-cell">Format</th>
                  <th className="w-9 px-2 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {tracks.map((track, idx) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={idx}
                    showAlbum={false}
                    showArtist={true}
                    albumArtist={resolvedAlbum.artist}
                    onPlay={(t) => playTrack(t, tracks)}
                    isPlaying={currentTrack?.id === track.id}
                    user={user}
                    onEditTags={onEditTags}
                    onGoToAlbum={onGoToAlbum}
                    onGoToArtist={onGoToArtist}
                    onAddToPlaylist={onAddToPlaylist}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Fullscreen Cover Lightbox */}
      {showCoverModal && resolvedAlbum.cover_path && (
        <CoverModal
          coverPath={resolvedAlbum.cover_path}
          title={resolvedAlbum.title}
          artist={resolvedAlbum.artist}
          year={resolvedAlbum.year}
          onClose={() => setShowCoverModal(false)}
        />
      )}
    </div>
  );
}
