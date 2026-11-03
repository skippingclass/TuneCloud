import { useEffect, useState } from 'react';
import { Clock3, RefreshCw, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { usePlayer } from '../context/PlayerContext.jsx';
import { TrackRow } from '../components/cards/TrackRow.jsx';

export function HistoryView({ user, onGoToAlbum, onGoToArtist, onAddToPlaylist, onEditTags }) {
  const [page, setPage] = useState(0);
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState({ tracks: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { currentTrack, playTrack } = usePlayer();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    api
      .history({ limit: 50, offset: page * 50 }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((err) => {
        if (err.name !== 'AbortError' && !controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, retry]);
  const groups = new Map();
  const activeHistoryId = currentTrack?.history_id ?? data.tracks.find((track) => track.id === currentTrack?.id)?.history_id;
  for (const [index, track] of data.tracks.entries()) {
    const date = new Date(track.played_at).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push({ track, displayIndex: page * 50 + index + 1 });
  }
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Listening history</h1>
          <p className="text-sm text-surface-400 mt-1">Find your way back to a song.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-surface-500" role="status">
          {loading && <Loader2 className="w-3 h-3 animate-spin" />}
          {error ? 'History unavailable' : `${data.total} plays`}
          <button
            onClick={() => setRetry((v) => v + 1)}
            title="Refresh history"
            aria-label="Refresh history"
            className="p-2 hover:text-white"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>
      {!loading && !error && data.total === 0 && (
        <div className="py-20 text-center text-surface-500">
          <Clock3 className="w-8 h-8 mx-auto mb-3" />
          <p>Your listening history starts with your next song.</p>
        </div>
      )}
      {!error &&
        [...groups].map(([date, tracks]) => (
          <section key={date} className="space-y-3">
            <h2 className="text-sm font-semibold text-surface-300">{date}</h2>
            <div className="glass-panel rounded-2xl overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-[11px] text-surface-500">
                  <tr>
                    <th className="p-3">#</th>
                    <th aria-label="Favorite" />
                    <th className="p-3">Title</th>
                    <th className="p-3 hidden sm:table-cell">Artist</th>
                    <th className="p-3 hidden md:table-cell">Album</th>
                    <th className="p-3 hidden sm:table-cell">Duration</th>
                    <th className="p-3 hidden lg:table-cell">Format</th>
                    <th className="p-3">Played</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {tracks.map(({ track, displayIndex }) => (
                    <TrackRow
                      displayIndex={displayIndex}
                      key={track.history_id}
                      track={track}
                      isPlaying={currentTrack?.id === track.id && activeHistoryId === track.history_id}
                      isCurrentTrack={currentTrack?.id === track.id && activeHistoryId === track.history_id}
                      user={user}
                      onPlay={(t) => playTrack(t, data.tracks)}
                      onGoToAlbum={onGoToAlbum}
                      onGoToArtist={onGoToArtist}
                      onAddToPlaylist={onAddToPlaylist}
                      onEditTags={onEditTags}
                      reorderControls={
                        <span
                          className="text-[11px] text-surface-400 tabular-nums whitespace-nowrap"
                          title={new Date(track.played_at).toLocaleString()}
                        >
                          {new Date(track.played_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      {data.total > 50 && (
        <div className="flex items-center justify-end gap-3 text-xs text-surface-400">
          <button
            className="p-2 disabled:opacity-30"
            disabled={page === 0 || loading}
            aria-label="Previous history page"
            onClick={() => setPage((v) => v - 1)}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span>
            {page + 1} / {Math.ceil(data.total / 50)}
          </span>
          <button
            className="p-2 disabled:opacity-30"
            disabled={(page + 1) * 50 >= data.total || loading}
            aria-label="Next history page"
            onClick={() => setPage((v) => v + 1)}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
