import { useState, useEffect, useRef } from 'react';
import { Search, Users, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { ArtistCard } from '../components/cards/ArtistCard.jsx';

const ARTIST_IMG_CACHE_KEY = 'tunecloud-artist-images';
export const DEFAULT_ARTISTS_PAGE_SIZE = 48;

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
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [artistImages, setArtistImages] = useState(() => loadArtistImageCache());

  const reqIdRef = useRef(0);
  const abortRef = useRef(null);

  // Debounce search filter
  useEffect(() => {
    const trimmed = filter.trim();
    const timer = setTimeout(() => {
      setDebouncedQuery(trimmed);
      setPage(1);
    }, 150);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    const offset = (page - 1) * DEFAULT_ARTISTS_PAGE_SIZE;
    const params = {
      limit: DEFAULT_ARTISTS_PAGE_SIZE,
      offset,
      sort: 'name',
      order: 'asc',
    };
    if (debouncedQuery) params.q = debouncedQuery;

    api
      .artists(params, { signal: controller.signal })
      .then((res) => {
        if (reqId !== reqIdRef.current || controller.signal.aborted) return;
        const list = Array.isArray(res) ? res : (res?.artists || []);
        const totalCount = typeof res?.total === 'number' ? res.total : list.length;
        setArtists(list);
        setTotal(totalCount);

        // Enrich missing Spotify images for the current page
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
      .catch((err) => {
        if (err?.name === 'AbortError' || controller.signal.aborted) return;
        setArtists([]);
        setTotal(0);
      })
      .finally(() => {
        if (reqId === reqIdRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [page, debouncedQuery]);

  const totalPages = Math.ceil(total / DEFAULT_ARTISTS_PAGE_SIZE) || 1;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search all artists..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="glass-input w-full pl-9 pr-4 text-sm"
          />
        </div>
        <span className="text-surface-500 font-mono text-xs">
          ({total} artists)
        </span>
      </div>

      {loading ? (
        <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
          <Loader2 className="w-8 h-8 animate-spin text-accent" />
          <span className="text-xs font-medium">Loading artists...</span>
        </div>
      ) : artists.length === 0 ? (
        <div className="h-64 flex flex-col items-center justify-center gap-2 text-surface-500">
          <Users className="w-10 h-10 stroke-1 opacity-50" />
          <p className="text-sm font-semibold">
            {debouncedQuery ? 'No artists match your search' : 'No artists in library'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {artists.map((artist) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                image={
                  artistImages[artist.name] && artistImages[artist.name] !== 'none'
                    ? artistImages[artist.name]
                    : null
                }
                onClick={onArtistClick}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-2 py-3 text-xs text-surface-400">
              <span>
                Showing {(page - 1) * DEFAULT_ARTISTS_PAGE_SIZE + 1}–
                {Math.min(page * DEFAULT_ARTISTS_PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                  title="Previous Page"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="font-mono px-2 font-medium text-surface-200">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="p-1.5 rounded-lg border border-white/[0.08] hover:bg-white/[0.06] disabled:opacity-30 disabled:pointer-events-none text-white transition-colors"
                  title="Next Page"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
