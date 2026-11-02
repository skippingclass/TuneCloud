import { useState } from 'react';
import {
  X,
  Trash2,
  Music,
  Volume2,
  ArrowUp,
  ArrowDown,
  ListPlus,
  GripVertical,
} from 'lucide-react';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useDialog } from '../../hooks/useDialog.js';
import { CreatePlaylistModal } from '../modals/CreatePlaylistModal.jsx';

function duration(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function QueueDrawer({ onGoToAlbum, onGoToArtist }) {
  const {
    queue,
    queueOrder,
    queueIndex,
    setQueueIndex,
    isPlaying,
    isQueueOpen,
    setIsQueueOpen,
    removeFromQueue,
    clearQueue,
    moveInQueue,
  } = usePlayer();
  const [saveTracks, setSaveTracks] = useState(null);
  const [dragIndex, setDragIndex] = useState(null);
  const ref = useDialog(isQueueOpen, () => setIsQueueOpen(false));
  if (!isQueueOpen) return null;
  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40"
        onClick={() => setIsQueueOpen(false)}
      />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Play queue"
        tabIndex={-1}
        className="queue-drawer fixed inset-y-0 right-0 z-50 w-full sm:w-[440px] glass-panel border-l border-white/10 shadow-glass flex flex-col h-full animate-slide-left"
      >
        <div className="p-5 border-b border-white/10 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Music size={16} className="text-accent" /> Play queue
            </h2>
            <p className="text-xs text-surface-400 mt-1">
              {queue.length} tracks ·{' '}
              {duration(queue.reduce((sum, t) => sum + (Number(t.duration) || 0), 0))}
            </p>
          </div>
          <div className="flex gap-1">
            <button
              disabled={!queue.length}
              onClick={() => setSaveTracks(queueOrder.map((index) => queue[index]))}
              title="Save as playlist"
              aria-label="Save queue as playlist"
              className="p-2 text-surface-400 hover:text-white disabled:opacity-30"
            >
              <ListPlus size={18} />
            </button>
            <button
              disabled={!queue.length}
              onClick={clearQueue}
              title="Clear queue"
              aria-label="Clear queue"
              className="p-2 text-surface-400 hover:text-rose-300 disabled:opacity-30"
            >
              <Trash2 size={17} />
            </button>
            <button
              onClick={() => setIsQueueOpen(false)}
              aria-label="Close queue"
              className="p-2 text-surface-400 hover:text-white"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {!queue.length && (
            <p className="py-20 text-center text-sm text-surface-500">Your queue is empty.</p>
          )}
          {queueOrder.map((index, position) => {
            const track = queue[index];
            return (
              <div
                key={`${track.id}-${index}`}
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragEnd={() => setDragIndex(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null) moveInQueue(dragIndex, index);
                  setDragIndex(null);
                }}
                className={`queue-entry flex items-center gap-2 rounded-xl p-2 ${index === queueIndex ? 'bg-accent/10 text-accent' : 'hover:bg-white/5 text-surface-200'} ${dragIndex === index ? 'opacity-40' : ''}`}
              >
                <GripVertical
                  size={14}
                  className="shrink-0 text-surface-600 cursor-grab"
                  aria-hidden="true"
                />
                <button
                  onClick={() => setQueueIndex(index)}
                  disabled={track.available === false}
                  className="flex-1 flex items-center gap-3 min-w-0 text-left py-2"
                  aria-label={`Play ${track.title || track.file_name}`}
                  aria-current={index === queueIndex ? 'true' : undefined}
                >
                  <span className="w-5 shrink-0 text-xs text-surface-500">
                    {index === queueIndex && isPlaying ? (
                      <Volume2 size={15} className="text-accent" />
                    ) : (
                      position + 1
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold truncate">
                      {track.title || track.file_name}
                    </span>
                    <span className="block text-[11px] text-surface-400 truncate mt-1">
                      {track.artist || 'Unknown artist'}
                    </span>
                  </span>
                </button>
                <div className="flex items-center shrink-0">
                  <button
                    onClick={() => moveInQueue(index, queueOrder[position - 1])}
                    disabled={position === 0}
                    aria-label={`Move ${track.title || 'track'} up`}
                    className="p-2 text-surface-500 hover:text-white disabled:opacity-20"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    onClick={() => moveInQueue(index, queueOrder[position + 1])}
                    disabled={position === queue.length - 1}
                    aria-label={`Move ${track.title || 'track'} down`}
                    className="p-2 text-surface-500 hover:text-white disabled:opacity-20"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    onClick={() => removeFromQueue(index)}
                    aria-label={`Remove ${track.title || 'track'} from queue`}
                    className="p-2 text-surface-500 hover:text-rose-300"
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {queue[queueIndex] && (
          <div className="p-4 border-t border-white/10 flex gap-4 text-xs text-surface-400">
            <button
              onClick={() => {
                const track = queue[queueIndex];
                onGoToAlbum?.({ id: track.album_id, title: track.album });
                setIsQueueOpen(false);
              }}
              disabled={!queue[queueIndex].album}
              className="hover:text-white disabled:opacity-30"
            >
              View album
            </button>
            <button
              onClick={() => {
                const track = queue[queueIndex];
                onGoToArtist?.({ id: track.artist_id, name: track.artist });
                setIsQueueOpen(false);
              }}
              disabled={!queue[queueIndex].artist}
              className="hover:text-white disabled:opacity-30"
            >
              View artist
            </button>
          </div>
        )}
      </aside>
      {saveTracks && (
        <CreatePlaylistModal
          initialTrackIds={saveTracks.map((t) => t.id)}
          onClose={() => setSaveTracks(null)}
        />
      )}
    </>
  );
}
