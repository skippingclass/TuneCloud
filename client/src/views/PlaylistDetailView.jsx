import { useState, useEffect } from 'react';
import {
  Play,
  Pause,
  Shuffle,
  ArrowLeft,
  ListMusic,
  Clock,
  Loader2,
  Globe,
  Lock,
  Edit3,
  Trash2,
  ChevronUp,
  ChevronDown,
  Music2,
  User,
} from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { CreatePlaylistModal } from '../components/modals/CreatePlaylistModal.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';
import { toast } from '../components/layout/Toast.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0 min';
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    const remM = m % 60;
    return `${h} hr ${remM} min`;
  }
  return `${m} min`;
}

function PlaylistHeroCover({ playlist, tracks }) {
  const covers = (playlist?.sample_covers || [])
    .concat(tracks?.map((t) => t.cover_path).filter(Boolean) || [])
    .filter(Boolean);

  const uniqueCovers = Array.from(new Set(covers));

  if (uniqueCovers.length >= 4) {
    return (
      <div className="w-full h-full grid grid-cols-2 grid-rows-2">
        {uniqueCovers.slice(0, 4).map((c, i) => (
          <img
            key={i}
            src={api.coverUrl(c)}
            alt=""
            className="w-full h-full object-cover"
          />
        ))}
      </div>
    );
  }

  const singleCover = uniqueCovers[0] || playlist?.cover_path;
  if (singleCover) {
    return (
      <img
        src={api.coverUrl(singleCover)}
        alt=""
        className="w-full h-full object-cover"
      />
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-br from-surface-800 to-surface-900 flex items-center justify-center text-accent">
      <ListMusic className="w-16 h-16 stroke-[1.5]" />
    </div>
  );
}

export function PlaylistDetailView({
  playlist,
  onBack,
  user,
  onGoToAlbum,
  onGoToArtist,
  onEditTags,
  onAddToPlaylist,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingModal, setEditingModal] = useState(false);
  const { currentTrack, isPlaying, playTrack, togglePlay } = usePlayer();

  const loadPlaylist = async () => {
    try {
      const res = await api.playlist(playlist.id);
      setData(res);
    } catch (err) {
      toast(`Failed to load playlist: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaylist();
  }, [playlist.id]);

  const tracks = data?.tracks || [];
  const canManage = data?.is_owner || user?.is_admin;

  const isThisPlaylist =
    currentTrack && tracks.some((t) => t.id === currentTrack.id);
  const isThisPlaylistPlaying = isThisPlaylist && isPlaying;

  const handlePlayAll = () => {
    if (isThisPlaylist) {
      togglePlay();
      return;
    }
    if (tracks.length > 0) {
      playTrack(tracks[0], tracks);
      toast(`Playing "${data.name}"`, 'success');
    }
  };

  const handleShufflePlay = () => {
    if (tracks.length === 0) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    playTrack(shuffled[0], shuffled);
    toast(`Playing "${data.name}" in shuffle`, 'success');
  };

  const handleRemoveTrack = async (track) => {
    if (!canManage) return;
    try {
      await api.removeTrackFromPlaylist(data.id, track.playlist_track_id);
      setData((prev) => ({
        ...prev,
        tracks: prev.tracks.filter((t) => t.playlist_track_id !== track.playlist_track_id),
        track_count: Math.max(0, (prev.track_count || 1) - 1),
        duration: Math.max(0, (prev.duration || 0) - (track.duration || 0)),
      }));
      toast(`Removed "${track.title || track.file_name}" from playlist`, 'info');
    } catch (err) {
      toast(`Failed to remove track: ${err.message}`, 'error');
    }
  };

  const handleMoveTrack = async (index, direction) => {
    if (!canManage) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= tracks.length) return;

    const newTracks = [...tracks];
    const [moved] = newTracks.splice(index, 1);
    newTracks.splice(targetIndex, 0, moved);

    setData((prev) => ({ ...prev, tracks: newTracks }));

    try {
      const playlistTrackIds = newTracks.map((t) => t.playlist_track_id);
      await api.reorderPlaylist(data.id, playlistTrackIds);
    } catch (err) {
      toast(`Failed to update order: ${err.message}`, 'error');
      loadPlaylist();
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete "${data.name}"?`)) return;
    try {
      await api.deletePlaylist(data.id);
      toast('Playlist deleted', 'success');
      onBack?.();
    } catch (err) {
      toast(`Failed to delete: ${err.message}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-sm font-medium">Loading playlist...</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4 py-8 text-center text-surface-400">
        <p>Playlist not found or access denied.</p>
        <button onClick={onBack} className="btn-accent text-xs px-4 py-2 rounded-xl">
          Back to Playlists
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-in select-none">
      {/* Top back button */}
      <button
        onClick={onBack}
        className="btn-glass text-xs py-1.5 px-3 rounded-xl gap-1.5 group"
      >
        <ArrowLeft className="w-3.5 h-3.5 text-surface-400 group-hover:text-accent group-hover:-translate-x-0.5 transition-all" />
        <span>Back to Playlists</span>
      </button>

      {/* Hero Showcase Header */}
      <div className="glass-panel p-5 sm:p-8 rounded-3xl border border-white/[0.08] relative overflow-hidden flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-end">
        {/* Ambient Blur */}
        {data.cover_path && (
          <div
            className="absolute -inset-10 bg-cover bg-center opacity-20 filter blur-3xl pointer-events-none"
            style={{ backgroundImage: `url(${api.coverUrl(data.cover_path)})` }}
          />
        )}

        {/* Large Cover */}
        <div className="w-40 h-40 sm:w-56 sm:h-56 rounded-2xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.12] shadow-glass-lg relative z-10 flex items-center justify-center">
          <PlaylistHeroCover playlist={data} tracks={tracks} />
        </div>

        {/* Info & Meta */}
        <div className="flex-1 min-w-0 space-y-3 z-10 text-center sm:text-left">
          <div className="flex items-center justify-center sm:justify-start gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
            <ListMusic className="w-4 h-4" />
            <span>Playlist</span>
            <span>•</span>
            <span className="flex items-center gap-1 text-surface-400 lowercase">
              {data.is_public ? (
                <>
                  <Globe className="w-3 h-3 text-emerald-400" />
                  <span>public</span>
                </>
              ) : (
                <>
                  <Lock className="w-3 h-3" />
                  <span>private</span>
                </>
              )}
            </span>
          </div>

          <h1 className="text-2xl sm:text-4xl font-extrabold text-white tracking-tight leading-tight">
            {data.name}
          </h1>

          {data.comment && (
            <p className="text-sm text-surface-300 max-w-2xl line-clamp-2">
              {data.comment}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2.5 text-xs text-surface-400 pt-1">
            <span className="text-surface-200 font-medium">
              {data.is_owner ? 'Created by you' : `Created by ${data.owner_username}`}
            </span>
            <span>•</span>
            <span>{tracks.length} {tracks.length === 1 ? 'song' : 'songs'}</span>
            <span>•</span>
            <span className="flex items-center gap-1">
              <Clock className="w-3.5 h-3.5 text-surface-500" />
              <span>{formatDuration(data.duration)}</span>
            </span>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3 pt-3">
            <button
              onClick={handlePlayAll}
              disabled={tracks.length === 0}
              className="btn-accent px-6 py-2.5 rounded-2xl text-sm font-semibold shadow-glow flex items-center gap-2 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isThisPlaylistPlaying ? (
                <>
                  <Pause className="w-4 h-4 fill-current" />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" />
                  <span>Play</span>
                </>
              )}
            </button>

            <button
              onClick={handleShufflePlay}
              disabled={tracks.length === 0}
              className="btn-glass px-4 py-2.5 rounded-2xl text-sm font-semibold gap-2 hover:text-accent hover:border-accent/30 disabled:opacity-50"
              title="Shuffle Play"
            >
              <Shuffle className="w-4 h-4" />
              <span className="hidden sm:inline">Shuffle</span>
            </button>

            {canManage && (
              <>
                <button
                  onClick={() => setEditingModal(true)}
                  className="btn-glass px-4 py-2.5 rounded-2xl text-sm font-semibold gap-2 hover:text-accent hover:border-accent/30"
                  title="Edit details"
                >
                  <Edit3 className="w-4 h-4" />
                  <span className="hidden sm:inline">Edit Details</span>
                </button>

                <button
                  onClick={handleDelete}
                  className="btn-glass px-3.5 py-2.5 rounded-2xl text-sm font-semibold gap-1.5 hover:text-rose-400 hover:border-rose-500/30 text-surface-400"
                  title="Delete playlist"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tracks Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-bold text-surface-300 uppercase tracking-wider">
            Songs in Playlist ({tracks.length})
          </h2>
        </div>

        {tracks.length === 0 ? (
          <div className="glass-panel p-10 rounded-2xl border border-white/[0.06] text-center space-y-3">
            <Music2 className="w-10 h-10 mx-auto text-surface-600" />
            <h3 className="text-base font-semibold text-surface-200">This playlist is empty</h3>
            <p className="text-xs text-surface-400 max-w-md mx-auto">
              Browse tracks in your library or search for songs, then click the context menu on any track and select "Add to Playlist".
            </p>
          </div>
        ) : (
          <div className="glass-panel rounded-2xl border border-white/[0.06] overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/[0.06] text-surface-500 text-xs uppercase tracking-wider font-semibold">
                  <th className="px-3 sm:px-4 py-3 w-12 text-center">#</th>
                  <th className="w-8 px-1 py-3 text-center"></th>
                  <th className="px-3 sm:px-4 py-3">Title</th>
                  <th className="px-3 sm:px-4 py-3 hidden sm:table-cell">Artist</th>
                  <th className="px-3 sm:px-4 py-3 hidden md:table-cell">Album</th>
                  <th className="px-3 sm:px-4 py-3 text-right hidden sm:table-cell">Duration</th>
                  {canManage && <th className="px-2 py-3 w-16 text-center">Order</th>}
                  <th className="px-2 py-3 w-9"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {tracks.map((track, index) => {
                  const isCurrent = currentTrack?.id === track.id;
                  return (
                    <TrackRow
                      key={track.playlist_track_id || track.id}
                      track={track}
                      index={index}
                      displayIndex={index + 1}
                      isPlaying={isCurrent && isPlaying}
                      onPlay={() => playTrack(track, tracks)}
                      user={user}
                      onGoToAlbum={onGoToAlbum}
                      onGoToArtist={onGoToArtist}
                      onEditTags={onEditTags}
                      onAddToPlaylist={onAddToPlaylist}
                      onRemoveFromPlaylist={canManage ? () => handleRemoveTrack(track) : null}
                      reorderControls={
                        canManage ? (
                          <div
                            className="flex items-center justify-center gap-0.5 text-surface-500 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              disabled={index === 0}
                              onClick={() => handleMoveTrack(index, -1)}
                              className="p-1 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed rounded"
                              title="Move up"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              disabled={index === tracks.length - 1}
                              onClick={() => handleMoveTrack(index, 1)}
                              className="p-1 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed rounded"
                              title="Move down"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : null
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editingModal && (
        <CreatePlaylistModal
          playlist={data}
          onClose={() => setEditingModal(false)}
          onSaved={(updated) => {
            setData((prev) => ({
              ...prev,
              name: updated.name,
              comment: updated.comment,
              is_public: updated.is_public,
            }));
          }}
        />
      )}
    </div>
  );
}
