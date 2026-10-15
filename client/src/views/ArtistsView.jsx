import { useState, useEffect, useMemo } from 'react';
import { Search, Users, Loader2 } from 'lucide-react';
import { api } from '../api.js';
import { ArtistCard } from '../components/cards/ArtistCard.jsx';

const ARTIST_IMG_CACHE_KEY = 'tunecloud-artist-images';

function loadArtistImageCache() {
  try {
    return JSON.parse(localStorage.getItem(ARTIST_IMG_CACHE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveArtistImageCache(cache) {
  try {
    localStorage.setItem(ARTIST_IMG_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export function ArtistsView({ onArtistClick }) {
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [artistImages, setArtistImages] = useState(() => loadArtistImageCache());

  useEffect(() => {
    setLoading(true);
    api
      .artists()
      .then((list) => {
        setArtists(list);
        const cache = loadArtistImageCache();
        const missing = list.filter((a) => !(a.name in cache));
        if (missing.length > 0) {
          (async () => {
            const BATCH_SIZE = 5;
            for (let i = 0; i < missing.length; i += BATCH_SIZE) {
              const chunk = missing.slice(i, i + BATCH_SIZE);
              let chunkChanged = false;
              await Promise.allSettled(
                chunk.map(async (a) => {
                  try {
                    const data = await api.spotifyArtist(a.name);
                    if (data?.found && data.artist?.image) {
                      cache[a.name] = data.artist.image;
                    } else {
                      cache[a.name] = 'none';
                    }
                    chunkChanged = true;
                  } catch {
                    cache[a.name] = 'none';
                    chunkChanged = true;
                  }
                })
              );
              if (chunkChanged) {
                saveArtistImageCache(cache);
                setArtistImages({ ...cache });
              }
            }
          })();
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!filter.trim()) return artists;
    const q = filter.toLowerCase();
    return artists.filter((a) => (a.name || '').toLowerCase().includes(q));
  }, [artists, filter]);

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading artists...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter artists..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="glass-input w-full pl-9 pr-4 text-sm"
          />
        </div>
        <span className="text-surface-500 font-mono text-xs">
          ({filtered.length} artists)
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Users className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">No artists match your filter</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {filtered.map((artist) => (
            <ArtistCard
              key={artist.id}
              artist={artist}
              image={artistImages[artist.name] && artistImages[artist.name] !== 'none' ? artistImages[artist.name] : null}
              onClick={onArtistClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}
