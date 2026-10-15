import { useState, useEffect, useMemo } from 'react';
import {
  ListMusic,
  Plus,
  Play,
  Search,
  Globe,
  Lock,
  MoreVertical,
  Trash2,
  Edit3,
  Loader2,
  Clock,
  Music2,
} from 'lucide-react';
import { api } from '../api.js';
import { usePlayer } from '../context/PlayerContext.jsx';
import { CreatePlaylistModal } from '../components/modals/CreatePlaylistModal.jsx';
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

function PlaylistCover({ playlist }) {
  const covers = (playlist.sample_covers || []).filter(Boolean);

  if (covers.length >= 4) {
    return (
      <div className="w-full h-full grid grid-cols-2 grid-rows-2">
        {covers.slice(0, 4).map((c, i) => (
          <img
            key={i}
            src={api.coverUrl(c)}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ))}
      </div>
    );
  }

  const singleCover = covers[0] || playlist.cover_path;
  if (singleCover) {
    return (
      <img
        src={api.coverUrl(singleCover)}
        alt=""
        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        loading="lazy"
      />
    );
  }

  return (
    <div className="w-full h-full bg-gradient-to-br from-surface-800 to-surface-900 flex items-center justify-center text-surface-600 group-hover:text-accent transition-colors">
      <ListMusic className="w-12 h-12 stroke-[1.5]" />
    </div>
  );
}

export function PlaylistsView({ onPlaylistClick, user }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all' | 'my' | 'public'
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);

  const { playTrack } = usePlayer();

  const loadPlaylists = async () => {
    try {
      const res = await api.playlists();
      setPlaylists(res.playlists || []);
    } catch (err) {
      toast(`Failed to load playlists: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaylists();
  }, []);

  const handlePlayPlaylist = async (e, playlist) => {
    e.stopPropagation();
    try {
      const data = await api.playlist(playlist.id);
      if (data.tracks && data.tracks.length > 0) {
        playTrack(data.tracks[0], data.tracks);
        toast(`Playing "${playlist.name}"`, 'success');
      } else {
        toast('This playlist is empty', 'info');
      }
    } catch (err) {
      toast(`Failed to play: ${err.message}`, 'error');
    }
  };

  const handleDeletePlaylist = async (e, playlist) => {
    e.stopPropagation();
    setMenuOpenId(null);
    if (!window.confirm(`Delete playlist "${playlist.name}"?`)) return;

    try {
      await api.deletePlaylist(playlist.id);
      setPlaylists((prev) => prev.filter((p) => p.id !== playlist.id));
      toast('Playlist deleted', 'success');
    } catch (err) {
      toast(`Failed to delete: ${err.message}`, 'error');
    }
  };

  const filteredPlaylists = useMemo(() => {
    return playlists.filter((p) => {
      if (activeTab === 'my' && !p.is_owner) return false;
      if (activeTab === 'public' && !p.is_public) return false;

      if (filter.trim()) {
        const q = filter.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          (p.comment || '').toLowerCase().includes(q) ||
          (p.owner_username || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [playlists, activeTab, filter]);

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-sm font-medium">Loading your playlists...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in select-none">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Playlists</h1>
          <p className="text-xs text-surface-400 mt-1">
            {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'} available
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex-1 sm:w-64">
            <Search className="w-4 h-4 text-surface-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter playlists..."
              className="w-full bg-white/[0.04] border border-white/[0.08] focus:border-accent/60 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-surface-500 outline-none transition-colors"
            />
          </div>

          <button
            onClick={() => {
              setEditingPlaylist(null);
              setModalOpen(true);
            }}
            className="btn-accent text-xs font-semibold px-4 py-2 rounded-xl shadow-glow flex items-center gap-2 shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>New Playlist</span>
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 pb-1 overflow-x-auto">
        {[
          { id: 'all', label: 'All Playlists' },
          { id: 'my', label: 'Created by Me' },
          { id: 'public', label: 'Public' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'text-surface-400 hover:text-white hover:bg-white/[0.04]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Playlists Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
        {/* Create Card (when filter is empty) */}
        {!filter && activeTab !== 'public' && (
          <button
            onClick={() => {
              setEditingPlaylist(null);
              setModalOpen(true);
            }}
            className="group glass-card p-4 rounded-2xl flex flex-col items-center justify-center text-center border border-dashed border-white/[0.12] hover:border-accent/50 hover:bg-white/[0.04] transition-all min-h-[220px]"
          >
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/[0.08] group-hover:scale-110 group-hover:bg-accent/20 group-hover:border-accent/30 transition-all flex items-center justify-center text-surface-400 group-hover:text-accent mb-3">
              <Plus className="w-6 h-6" />
            </div>
            <span className="text-sm font-semibold text-surface-200 group-hover:text-white">
              Create Playlist
            </span>
            <span className="text-[11px] text-surface-500 mt-1">
              Custom collection
            </span>
          </button>
        )}

        {filteredPlaylists.map((pl) => {
          const isMenuOpen = menuOpenId === pl.id;
          const canManage = pl.is_owner || user?.is_admin;

          return (
            <div
              key={pl.id}
              onClick={() => onPlaylistClick?.(pl)}
              className="group glass-card p-3 rounded-2xl hover:bg-white/[0.06] transition-all duration-200 cursor-pointer flex flex-col justify-between relative"
            >
              {/* Cover Container */}
              <div className="relative aspect-square rounded-xl overflow-hidden mb-3 bg-surface-900 border border-white/[0.06] shadow-md">
                <PlaylistCover playlist={pl} />

                {/* Quick Play overlay button */}
                <button
                  onClick={(e) => handlePlayPlaylist(e, pl)}
                  className="absolute bottom-2.5 right-2.5 w-10 h-10 rounded-full btn-accent flex items-center justify-center shadow-lg opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 hover:scale-105"
                  title="Play playlist"
                >
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                </button>

                {/* Privacy badge */}
                <div className="absolute top-2 left-2 p-1 rounded-lg bg-black/60 backdrop-blur-md text-surface-300 text-[10px] flex items-center gap-1">
                  {pl.is_public ? (
                    <Globe className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Lock className="w-3 h-3 text-surface-400" />
                  )}
                </div>

                {/* Options menu button */}
                {canManage && (
                  <div
                    className="absolute top-2 right-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => setMenuOpenId(isMenuOpen ? null : pl.id)}
                      className="p-1 rounded-lg bg-black/60 backdrop-blur-md text-surface-300 hover:text-white transition-colors"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>

                    {isMenuOpen && (
                      <div className="absolute right-0 mt-1 w-36 glass-panel rounded-xl py-1 shadow-2xl border border-white/[0.1] z-20 text-xs animate-fade-in">
                        <button
                          onClick={() => {
                            setMenuOpenId(null);
                            setEditingPlaylist(pl);
                            setModalOpen(true);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-surface-200 hover:bg-white/[0.08] hover:text-white"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-accent" />
                          <span>Edit</span>
                        </button>
                        <button
                          onClick={(e) => handleDeletePlaylist(e, pl)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Info */}
              <div className="space-y-1 min-w-0">
                <h3 className="font-semibold text-sm text-white truncate group-hover:text-accent transition-colors">
                  {pl.name}
                </h3>
                <p className="text-[11px] text-surface-400 truncate">
                  {pl.is_owner ? 'By you' : `By ${pl.owner_username}`}
                </p>
                <div className="flex items-center gap-2 text-[10px] text-surface-500 pt-0.5">
                  <span>{pl.track_count} songs</span>
                  <span>•</span>
                  <span>{formatDuration(pl.duration)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {filteredPlaylists.length === 0 && filter && (
        <div className="text-center py-16 text-surface-400 space-y-2">
          <ListMusic className="w-10 h-10 mx-auto text-surface-600" />
          <p className="text-sm">No playlists found for "{filter}"</p>
        </div>
      )}

      {/* Modal for creating / editing */}
      {modalOpen && (
        <CreatePlaylistModal
          playlist={editingPlaylist}
          onClose={() => {
            setModalOpen(false);
            setEditingPlaylist(null);
          }}
          onSaved={() => {
            loadPlaylists();
          }}
        />
      )}
    </div>
  );
}
