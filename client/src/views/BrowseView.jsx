import { useState, useEffect } from 'react';
import { Folder, ArrowLeft, Disc, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { TrackRow } from '../components/cards/TrackRow.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function BrowseView({
  browsePath,
  onBrowsePathChange,
  user,
  onAlbumClick,
  onArtistClick,
  onEditTags,
  onAddToPlaylist,
}) {
  const [dirs, setDirs] = useState([]);
  const [loading, setLoading] = useState(true);
  const { currentTrack, playTrack } = usePlayer();

  const path = browsePath || '';
  const setPath = onBrowsePathChange;

  const reload = () => {
    setLoading(true);
    api
      .browse(path)
      .then(setDirs)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
  }, [path]);

  const parentPath = path.split('/').slice(0, -1).join('/');
  const files = dirs
    .filter((e) => e.type === 'file')
    .map((e) =>
      e.meta ? { ...e.meta, fileName: e.name } : { id: null, title: e.name, fileName: e.name }
    );

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Breadcrumb navigator */}
      <div className="flex items-center gap-2 text-xs sm:text-sm text-surface-400 glass-panel px-4 py-2.5 rounded-2xl w-fit flex-wrap border border-white/[0.06]">
        <button
          onClick={() => setPath('')}
          className="hover:text-accent font-semibold transition-colors flex items-center gap-1.5"
        >
          <Folder className="w-3.5 h-3.5 text-accent" />
          <span>Music Root</span>
        </button>
        {path
          .split('/')
          .filter(Boolean)
          .map((part, i) => (
            <span key={i} className="flex items-center gap-2">
              <span className="text-white/20">/</span>
              <button
                onClick={() => setPath(path.split('/').slice(0, i + 1).join('/'))}
                className="hover:text-white transition-colors"
              >
                {part}
              </button>
            </span>
          ))}
      </div>

      {loading ? (
        <div className="h-64 flex items-center justify-center gap-2 text-surface-500">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <span className="text-xs">Loading folder...</span>
        </div>
      ) : (
        <>
          {/* Folders grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
            {path && (
              <button
                onClick={() => setPath(parentPath)}
                className="glass-card flex flex-col items-center justify-center h-28 gap-2 p-3 text-surface-300 hover:text-white group"
              >
                <ArrowLeft className="w-6 h-6 text-surface-400 group-hover:text-accent group-hover:-translate-x-1 transition-all" />
                <span className="text-xs font-medium">.. (Back)</span>
              </button>
            )}

            {dirs
              .filter((e) => e.type === 'dir')
              .map((d) => (
                <button
                  key={d.path}
                  onClick={() => setPath(d.path)}
                  className="glass-card flex flex-col items-center justify-center h-28 gap-2 p-3 text-left group"
                >
                  <Folder className="w-8 h-8 text-accent fill-accent/15 group-hover:scale-110 transition-transform duration-200" />
                  <span className="text-xs font-semibold text-center truncate w-full text-surface-200 group-hover:text-white">
                    {d.name}
                  </span>
                </button>
              ))}
          </div>

          {/* Files table in current directory */}
          {files.length > 0 && (
            <div className="space-y-3 pt-4">
              <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-2">
                <Disc className="w-4 h-4 text-accent" />
                <span>Audio Files ({files.length})</span>
              </h3>

              <div className="glass-panel rounded-3xl overflow-hidden border border-white/[0.06]">
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
                    {files.map((track, idx) => (
                      <TrackRow
                        key={track.id || track.fileName}
                        track={track}
                        index={idx}
                        onPlay={(t) => playTrack(t, files)}
                        isPlaying={currentTrack?.id === track.id}
                        user={user}
                        onEditTags={onEditTags}
                        onGoToAlbum={onAlbumClick}
                        onGoToArtist={onArtistClick}
                        onAddToPlaylist={onAddToPlaylist}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
