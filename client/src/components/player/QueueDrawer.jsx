import { X, Trash2, Music, Play, Volume2 } from 'lucide-react';
import { usePlayer } from '../../context/PlayerContext.jsx';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function QueueDrawer({ onGoToAlbum, onGoToArtist }) {
  const {
    queue,
    queueIndex,
    setQueueIndex,
    isQueueOpen,
    setIsQueueOpen,
    removeFromQueue,
    clearQueue,
  } = usePlayer();

  if (!isQueueOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40"
        onClick={() => setIsQueueOpen(false)}
      />

      {/* Drawer */}
      <aside className="fixed inset-y-0 right-0 z-50 w-full sm:w-96 glass-panel border-l border-white/[0.08] shadow-glass flex flex-col h-full animate-slide-left select-none">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-white/[0.06] flex items-center justify-between">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Music className="w-4 h-4 text-accent" />
              <span>Play Queue</span>
            </h3>
            <p className="text-xs text-surface-400 mt-0.5">
              {queue.length} track{queue.length !== 1 ? 's' : ''} in queue
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {queue.length > 0 && (
              <button
                onClick={clearQueue}
                className="p-2 text-surface-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition-colors text-xs flex items-center gap-1.5"
                title="Clear Queue"
              >
                <Trash2 className="w-4 h-4" />
                <span className="hidden sm:inline">Clear</span>
              </button>
            )}
            <button
              onClick={() => setIsQueueOpen(false)}
              className="p-2 text-surface-400 hover:text-white hover:bg-white/[0.06] rounded-xl transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tracks List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {queue.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-xs text-surface-500">
              Queue is empty
            </div>
          ) : (
            queue.map((track, idx) => {
              const isCurrent = idx === queueIndex;
              return (
                <div
                  key={`${track.id || track.fileName}-${idx}`}
                  onClick={() => setQueueIndex(idx)}
                  className={`group flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-all ${
                    isCurrent
                      ? 'bg-accent/15 border border-accent/25 text-accent shadow-glow'
                      : 'hover:bg-white/[0.04] text-surface-200'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="w-5 text-center text-xs font-mono text-surface-500 shrink-0">
                      {isCurrent ? (
                        <Volume2 className="w-4 h-4 text-accent animate-pulse" />
                      ) : (
                        idx + 1
                      )}
                    </span>
                    <div className="min-w-0">
                      <p
                        onClick={(e) => {
                          if (track.album_id || track.album) {
                            e.stopPropagation();
                            onGoToAlbum?.({
                              id: track.album_id,
                              title: track.album,
                              artist: track.artist,
                              cover_path: track.cover_path,
                            });
                            setIsQueueOpen(false);
                          }
                        }}
                        className={`text-xs font-semibold truncate ${
                          isCurrent ? 'text-accent' : 'text-surface-100'
                        } ${
                          track.album_id || track.album
                            ? 'hover:underline hover:text-accent cursor-pointer'
                            : ''
                        }`}
                        title={track.album ? `Go to album: ${track.album}` : ''}
                      >
                        {track.title || track.fileName || track.file_name}
                      </p>
                      <p
                        onClick={(e) => {
                          if (track.artist) {
                            e.stopPropagation();
                            onGoToArtist?.({ name: track.artist });
                            setIsQueueOpen(false);
                          }
                        }}
                        className={`text-[11px] text-surface-400 truncate mt-0.5 ${
                          track.artist ? 'hover:underline hover:text-white cursor-pointer' : ''
                        }`}
                        title={track.artist ? `Go to artist: ${track.artist}` : ''}
                      >
                        {track.artist || 'Unknown Artist'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[11px] text-surface-500 font-mono hidden sm:inline">
                      {formatDuration(track.duration)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromQueue(idx);
                      }}
                      className="p-1 text-surface-500 hover:text-rose-400 opacity-0 group-hover:opacity-100 rounded transition-opacity"
                      title="Remove"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
