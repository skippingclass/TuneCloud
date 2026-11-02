import { useState } from 'react';
import { CheckSquare, ListPlus, FolderPlus, Heart, X } from 'lucide-react';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function useTrackSelection(tracks, onAddToPlaylist) {
  const [enabled, setEnabled] = useState(false);
  const [ids, setIds] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const { addManyToQueue } = usePlayer();
  const { isTrackStarred, reloadFavorites } = useFavorites();
  const selected = tracks.filter((t) => ids.has(t.id));
  const toggle = (id) =>
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const close = () => {
    setEnabled(false);
    setIds(new Set());
  };
  const addFavorites = async () => {
    setBusy(true);
    let added = 0;
    try {
      for (const id of new Set(selected.map((t) => t.id))) {
        if (!isTrackStarred(id)) {
          await api.toggleFavoriteTrack(id);
          added += 1;
        }
      }
      toast(
        added ? `Added ${added} tracks to favorites` : 'These tracks are already in favorites',
        'success',
      );
    } catch {
      toast(`Added ${added} tracks. Could not finish updating favorites.`, 'error');
    } finally {
      await reloadFavorites();
      setBusy(false);
    }
  };
  const toolbar = tracks.length > 0 && (
    <div className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs text-surface-400">
      {!enabled ? (
        <button
          onClick={() => setEnabled(true)}
          className="inline-flex items-center gap-2 py-2 hover:text-white"
        >
          <CheckSquare size={14} /> Select tracks
        </button>
      ) : (
        <>
          <button
            onClick={() => setIds(new Set(tracks.map((t) => t.id)))}
            className="py-2 px-2 hover:text-white"
          >
            Select page
          </button>
          <span className="px-2 text-surface-200">{selected.length} selected</span>
          <button
            disabled={!selected.length}
            onClick={() => {
              const available = selected.filter((t) => t.available !== false);
              addManyToQueue(available);
              toast(`Added ${available.length} tracks to queue`, 'success');
            }}
            className="inline-flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 disabled:opacity-30"
          >
            <ListPlus size={14} /> Queue
          </button>
          {onAddToPlaylist && (
            <button
              disabled={!selected.length}
              onClick={() => onAddToPlaylist(selected)}
              className="inline-flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 disabled:opacity-30"
            >
              <FolderPlus size={14} /> Playlist
            </button>
          )}
          <button
            disabled={!selected.length || busy}
            onClick={addFavorites}
            className="inline-flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 disabled:opacity-30"
          >
            <Heart size={14} /> {busy ? 'Adding…' : 'Like'}
          </button>
          <button
            onClick={close}
            disabled={busy}
            className="ml-auto p-2"
            aria-label="Cancel track selection"
          >
            <X size={16} />
          </button>
        </>
      )}
    </div>
  );
  return {
    toolbar,
    rowProps: (track) => ({
      selectionMode: enabled,
      selected: ids.has(track.id),
      onSelect: toggle,
    }),
  };
}
