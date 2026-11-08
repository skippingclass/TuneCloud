import { useEffect, useRef, useState } from 'react';
import { CheckSquare, ListPlus, FolderPlus, Heart } from 'lucide-react';
import { usePlayer } from '../context/PlayerContext.jsx';
import { useFavorites } from '../context/FavoritesContext.jsx';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

const selectionKey = track => track.playlist_track_id != null ? `playlist:${track.playlist_track_id}` : track.id;

export function useTrackSelection(tracks, onAddToPlaylist) {
  const [bulkMode, setBulkMode] = useState(false);
  const [ids, setIds] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const anchor = useRef(null);
  const { addManyToQueue, playTrack } = usePlayer();
  const { isTrackStarred, reloadFavorites } = useFavorites();
  const selected = tracks.filter(t => ids.has(selectionKey(t)));
  const scope = tracks.map(selectionKey).join(',');
  useEffect(() => {
    setIds(new Set());
    setBulkMode(false);
    anchor.current = null;
  }, [scope]);

  const close = () => {
    setBulkMode(false);
    setIds(new Set());
    anchor.current = null;
  };
  const select = (id, event = {}, orderedTracks = tracks, toggle = false) => {
    const additive = event.ctrlKey || event.metaKey;
    setBulkMode(Boolean(additive || event.shiftKey));
    const end = orderedTracks.findIndex(t => selectionKey(t) === id);
    const start = orderedTracks.findIndex(t => selectionKey(t) === anchor.current);
    if (event.shiftKey && start >= 0 && end >= 0) {
      const range = orderedTracks.slice(Math.min(start, end), Math.max(start, end) + 1);
      setIds(prev => new Set([...(additive ? prev : []), ...range.map(selectionKey)]));
      return;
    }
    anchor.current = id;
    setIds(prev => {
      if (!additive && !toggle) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const keyDown = (event, track, orderedTracks) => {
    if ((event.target?.tagName === 'INPUT' && event.target?.type !== 'checkbox') || event.target?.isContentEditable) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === 'a') {
      event.preventDefault();
      setBulkMode(true);
      setIds(new Set(orderedTracks.map(selectionKey)));
    } else if (track && event.target === event.currentTarget && event.key === ' ') {
      event.preventDefault();
      select(selectionKey(track), event, orderedTracks, true);
    }
  };
  const queue = () => {
    const available = selected.filter(t => t.available !== false);
    addManyToQueue(available);
    toast(`Added ${available.length} tracks to queue`, 'success');
  };
  const play = () => {
    const available = selected.filter(t => t.available !== false);
    if (available.length) playTrack(available[0], available);
  };
  const addFavorites = async () => {
    setBusy(true);
    let added = 0;
    try {
      for (const id of new Set(selected.map(t => t.id))) {
        if (!isTrackStarred(id)) {
          await api.toggleFavoriteTrack(id);
          added += 1;
        }
      }
      toast(added ? `Added ${added} tracks to favorites` : 'These tracks are already in favorites', 'success');
    } catch {
      toast(`Added ${added} tracks. Could not finish updating favorites.`, 'error');
    } finally {
      await reloadFavorites();
      setBusy(false);
    }
  };
  const actions = {
    count: selected.length,
    busy,
    canPlay: selected.some(t => t.available !== false),
    play,
    queue,
    playlist: onAddToPlaylist ? () => onAddToPlaylist(selected) : null,
    favorite: addFavorites,
  };
  const toolbarFor = (visibleTracks = tracks) => {
    if (!visibleTracks.length || !bulkMode || !selected.length) return null;
    const allSelected = visibleTracks.every(track => ids.has(selectionKey(track)));
    return <div className={`track-selection-bar has-selection`}
      onKeyDown={event => keyDown(event, null, visibleTracks)}>
      <button className="track-selection-toggle" title="Ctrl / ⌘ click to add tracks; Shift click to select a range" aria-pressed={true} aria-label="Deselect tracks"
        onClick={close}>
        <CheckSquare size={15} /> Deselect
      </button>
      <span className="track-selection-summary" role="status">
        {`${selected.length} ${selected.length === 1 ? 'track' : 'tracks'}`}
      </span>
      <div className="track-selection-tools">
        <button className="track-selection-action" aria-label={allSelected ? 'Deselect page' : 'Select page'}
          onClick={() => { setIds(allSelected ? new Set() : new Set(visibleTracks.map(selectionKey))); anchor.current = selectionKey(visibleTracks[0]); }}>
          <CheckSquare size={15} /><span>{allSelected ? 'None' : 'All'}</span>
        </button>
        <button disabled={!actions.canPlay} onClick={queue} className="track-selection-action" aria-label="Add selection to queue"><ListPlus size={15} /><span>Queue</span></button>
        {actions.playlist && <button disabled={!selected.length} onClick={actions.playlist} className="track-selection-action" aria-label="Add selection to playlist"><FolderPlus size={15} /><span>Playlist</span></button>}
        <button disabled={!selected.length || busy} onClick={addFavorites} className="track-selection-action" aria-label="Like selection"><Heart size={15} /><span>{busy ? 'Adding…' : 'Like'}</span></button>
      </div>
    </div>;
  };
  return {
    toolbar: toolbarFor(),
    toolbarFor,
    rowProps: (track, orderedTracks = tracks) => ({
      selectionMode: false,
      selected: ids.has(selectionKey(track)),
      onSelect: (id, event) => select(selectionKey(track), event, orderedTracks, true),
      onRowSelect: event => select(selectionKey(track), event, orderedTracks),
      onSelectionKeyDown: event => keyDown(event, track, orderedTracks),
      onContextSelect: () => {
        if (!ids.has(selectionKey(track))) {
          setBulkMode(false);
          anchor.current = selectionKey(track);
          setIds(new Set([selectionKey(track)]));
        }
      },
      selectionActions: actions,
    }),
  };
}
