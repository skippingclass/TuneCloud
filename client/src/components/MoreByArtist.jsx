import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { usePlayer } from '../context/PlayerContext.jsx';
import { AlbumCard } from './cards/AlbumCard.jsx';
import { toast } from './layout/Toast.jsx';

export function MoreByArtist({ artist, albumId, onGoToAlbum, onGoToArtist }) {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const playRequest = useRef(null);
  const { playTrack } = usePlayer();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setReleases([]);
    api.albums({ artist_id: artist.id, exclude_id: albumId, limit: 10, sort: 'year_desc' }, { signal: controller.signal })
      .then(response => {
        if (controller.signal.aborted) return;
        const seen = new Set([String(albumId)]);
        setReleases((Array.isArray(response) ? response : response.albums || []).filter(release => {
          const id = String(release.id);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }));
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [artist.id, albumId, attempt]);

  useEffect(() => () => playRequest.current?.abort(), []);

  const playRelease = async release => {
    playRequest.current?.abort();
    const controller = new AbortController();
    playRequest.current = controller;
    try {
      const tracks = await api.album(release.id, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const available = tracks.filter(track => track.available !== false);
      if (available.length) playTrack(available[0], available);
      else toast('No available tracks in this release', 'error');
    } catch {
      if (!controller.signal.aborted) toast('Could not play this release. Try again.', 'error');
    }
  };

  if (!loading && !failed && !releases.length) return null;

  return (
    <section aria-label={`More by ${artist.name}`} className="space-y-4 pt-4 sm:pt-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg sm:text-xl font-semibold text-surface-100">More by {artist.name}</h2>
        {onGoToArtist && (
          <button className="shrink-0 text-xs text-surface-400 hover:text-white hover:underline transition-colors"
            onClick={() => onGoToArtist({ id: artist.id, name: artist.name })}>
            See discography
          </button>
        )}
      </div>
      {failed ? (
        <div role="status" className="flex items-center gap-3 text-sm text-surface-400">
          <span>Could not load more releases.</span>
          <button className="text-surface-100 hover:underline" onClick={() => setAttempt(value => value + 1)}>Retry</button>
        </div>
      ) : (
        <div className="artist-release-shelf" aria-busy={loading}>
          {loading ? Array.from({ length: 6 }, (_, index) => (
            <div key={index} aria-hidden="true" className="rounded-xl bg-white/[0.025] p-3 animate-pulse">
              <div className="aspect-square rounded-md bg-white/[0.05]" />
              <div className="h-3 w-3/4 mt-4 rounded bg-white/[0.05]" />
              <div className="h-3 w-1/3 mt-2 rounded bg-white/[0.05]" />
            </div>
          )) : releases.map(release => (
            <AlbumCard key={release.id} album={release} onClick={onGoToAlbum} onArtistClick={onGoToArtist} onPlay={playRelease} />
          ))}
        </div>
      )}
    </section>
  );
}
