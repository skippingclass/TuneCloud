import { useState, useEffect, useMemo } from 'react';
import { Search, Play, Shuffle, Music2, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function TracksView({ user, onGoToAlbum, onGoToArtist, onEditTags }) {
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const { currentTrack, playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    api
      .tracks({ limit: 10000, sort: 'title', order: 'asc' })
      .then((res) => setTracks(res.tracks || []))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return tracks;
    const q = filter.toLowerCase();
    return tracks.filter(
      (t) =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.artist || '').toLowerCase().includes(q) ||
        (t.album || '').toLowerCase().includes(q)
    );
  }, [tracks, filter]);

  const handlePlayAll = () => {
    if (filtered.length > 0) playTrack(filtered[0], filtered);
  };

  const handleShufflePlay = () => {
    if (filtered.length === 0) return;
    const shuffled = [...filtered].sort(() => Math.random() - 0.5);
    playTrack(shuffled[0], shuffled);
  };

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading tracks library...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter tracks..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="glass-input w-full pl-9 pr-4 text-sm"
          />
        </div>

        <div className="flex items-center gap-3 self-end sm:self-auto">
          <button
            onClick={handlePlayAll}
            disabled={filtered.length === 0}
            className="btn-primary py-2 px-4 text-xs shadow-glow"
          >
            <Play className="w-3.5 h-3.5 fill-surface-950" />
            <span>Play All</span>
          </button>
          <button
            onClick={handleShufflePlay}
            disabled={filtered.length === 0}
            className="btn-glass py-2 px-3 text-xs"
          >
            <Shuffle className="w-3.5 h-3.5 text-accent" />
            <span>Shuffle</span>
          </button>
          <span className="text-surface-500 font-mono text-xs pl-1">
            ({filtered.length} songs)
          </span>
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Music2 className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No tracks match your filter</p>
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
                  <th className="px-3 sm:px-4 py-3 hidden md:table-cell">Album</th>
                  <th className="px-3 sm:px-4 py-3 text-right hidden sm:table-cell">Duration</th>
                  <th className="px-2 py-3 text-center hidden lg:table-cell">Format</th>
                  <th className="w-9 px-2 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.03]">
                {filtered.map((track, idx) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={idx}
                    onPlay={(t) => playTrack(t, filtered)}
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
      )}
    </div>
  );
}
