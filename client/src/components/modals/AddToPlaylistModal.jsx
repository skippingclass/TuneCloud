import { useState, useEffect, useRef } from 'react';
import { X, Plus, Search, Check, ListMusic, Loader2, Music2 } from 'lucide-react';
import { api } from '../../api.js';
import { toast } from '../layout/Toast.jsx';

export function AddToPlaylistModal({ track, onClose, onPlaylistCreated }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [addingId, setAddingId] = useState(null);
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creating, setCreating] = useState(false);
  const createInputRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api
      .playlists()
      .then((res) => {
        if (mounted) {
          // Show user's own playlists
          const own = (res.playlists || []).filter((p) => p.is_owner);
          setPlaylists(own);
        }
      })
      .catch((err) => {
        toast(`Failed to load playlists: ${err.message}`, 'error');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      mounted = false;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (showCreateInput) {
      createInputRef.current?.focus();
    }
  }, [showCreateInput]);

  const handleAddToPlaylist = async (playlist) => {
    if (addingId || !track?.id) return;
    setAddingId(playlist.id);
    try {
      await api.addTracksToPlaylist(playlist.id, track.id);
      toast(`Added to "${playlist.name}"`, 'success');
      onClose();
    } catch (err) {
      toast(`Failed to add: ${err.message}`, 'error');
      setAddingId(null);
    }
  };

  const handleCreateAndAdd = async (e) => {
    e.preventDefault();
    const name = newPlaylistName.trim();
    if (!name || creating) return;

    setCreating(true);
    try {
      const created = await api.createPlaylist({
        name,
        trackIds: track?.id ? [track.id] : [],
      });
      toast(`Created "${name}" and added song`, 'success');
      onPlaylistCreated?.(created);
      onClose();
    } catch (err) {
      toast(`Failed to create playlist: ${err.message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const filteredPlaylists = playlists.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-sm rounded-3xl p-5 sm:p-6 border border-white/[0.1] shadow-2xl space-y-4 relative flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-1 border-b border-white/[0.06]">
          <div className="min-w-0 pr-3">
            <h2 className="text-base font-bold text-white tracking-tight truncate">
              Add to Playlist
            </h2>
            <p className="text-xs text-surface-400 truncate">
              {track ? `${track.title || track.file_name} — ${track.artist || 'Unknown'}` : 'Select playlist'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search & New Playlist actions */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-surface-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find playlist..."
              className="w-full bg-white/[0.04] border border-white/[0.08] focus:border-accent/60 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none transition-colors"
            />
          </div>

          {!showCreateInput ? (
            <button
              onClick={() => setShowCreateInput(true)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.06] text-accent text-xs font-semibold transition-colors"
            >
              <Plus className="w-4 h-4 text-accent" />
              <span>Create New Playlist</span>
            </button>
          ) : (
            <form onSubmit={handleCreateAndAdd} className="flex gap-2 animate-fade-in">
              <input
                ref={createInputRef}
                type="text"
                value={newPlaylistName}
                onChange={(e) => setNewPlaylistName(e.target.value)}
                placeholder="Playlist name..."
                maxLength={100}
                className="flex-1 bg-white/[0.06] border border-accent/40 rounded-xl px-3 py-1.5 text-xs text-white placeholder-surface-500 outline-none"
              />
              <button
                type="submit"
                disabled={creating || !newPlaylistName.trim()}
                className="btn-accent px-3 py-1.5 text-xs font-semibold rounded-xl shrink-0 flex items-center gap-1.5 disabled:opacity-50"
              >
                {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateInput(false);
                  setNewPlaylistName('');
                }}
                className="px-2 py-1.5 text-xs text-surface-400 hover:text-white rounded-xl"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          )}
        </div>

        {/* Playlist List */}
        <div className="flex-1 overflow-y-auto space-y-1 pr-1 min-h-[140px] max-h-[320px]">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-surface-400 text-xs gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-accent" />
              <span>Loading playlists...</span>
            </div>
          ) : filteredPlaylists.length === 0 ? (
            <div className="text-center py-8 text-surface-400 text-xs space-y-2">
              <ListMusic className="w-7 h-7 mx-auto text-surface-600" />
              <p>{search ? 'No playlists found' : 'No playlists yet'}</p>
            </div>
          ) : (
            filteredPlaylists.map((pl) => {
              const isAdding = addingId === pl.id;
              const coverUrl = api.coverUrl(pl.cover_path);
              return (
                <button
                  key={pl.id}
                  disabled={isAdding}
                  onClick={() => handleAddToPlaylist(pl)}
                  className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-white/[0.06] transition-colors text-left group"
                >
                  <div className="flex items-center gap-3 min-w-0 pr-2">
                    <div className="w-10 h-10 rounded-lg bg-surface-800 border border-white/[0.06] overflow-hidden shrink-0 flex items-center justify-center">
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt=""
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <Music2 className="w-4 h-4 text-surface-500" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-surface-100 group-hover:text-white truncate">
                        {pl.name}
                      </p>
                      <p className="text-[11px] text-surface-400">
                        {pl.track_count} {pl.track_count === 1 ? 'song' : 'songs'}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 text-surface-500 group-hover:text-accent transition-colors">
                    {isAdding ? (
                      <Loader2 className="w-4 h-4 animate-spin text-accent" />
                    ) : (
                      <Plus className="w-4 h-4" />
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
