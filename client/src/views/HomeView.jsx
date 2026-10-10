import { useState, useEffect } from 'react';
import {
  Sparkles,
  Disc,
  Music2,
  Users,
  Heart,
  Folder,
  ArrowRight,
  Clock,
  Flame,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { api } from '../api.js';
import { AlbumCard } from '../components/cards/AlbumCard.jsx';
import { GenrePill } from '../components/cards/GenrePill.jsx';
import { usePlayer } from '../context/PlayerContext.jsx';

export function HomeView({ onAlbumClick, onArtistClick, onNavigate }) {
  const [albums, setAlbums] = useState([]);
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);
  const { playTrack } = usePlayer();

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.albums().catch(() => []),
      api.genres().catch(() => []),
    ])
      .then(([allAlbums, allGenres]) => {
        setAlbums(allAlbums);
        setGenres(allGenres);
      })
      .finally(() => setLoading(false));
  }, []);

  const handlePlayAlbum = async (album) => {
    try {
      const tracks = await api.album(album.id);
      if (tracks.length > 0) {
        playTrack(tracks[0], tracks);
      }
    } catch {}
  };

  const jumpBackIn = albums.slice(0, 10);
  const recentReleases = albums.slice(10, 22);

  const quickPills = [
    { label: 'All Albums', id: 'albums', icon: Disc, count: albums.length },
    { label: 'Tracks Library', id: 'tracks', icon: Music2 },
    { label: 'Artists', id: 'artists', icon: Users },
    { label: 'Favorites', id: 'favorites', icon: Heart },
    { label: 'Folders', id: 'browse', icon: Folder },
  ];

  if (loading) {
    return (
      <div className="h-96 flex flex-col items-center justify-center gap-3 text-surface-400">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
        <span className="text-xs font-medium">Loading your music hub...</span>
      </div>
    );
  }

  return (
    <div className="space-y-8 sm:space-y-10 animate-fade-in">
      {/* 1. Quick Category Shortcuts */}
      <div className="flex items-center gap-2.5 overflow-x-auto pb-2 scrollbar-none">
        {quickPills.map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              onClick={() => onNavigate?.(p.id)}
              className="glass-pill flex items-center gap-2 hover:border-accent/40 hover:text-white shrink-0 group"
            >
              <Icon className="w-3.5 h-3.5 text-accent group-hover:scale-110 transition-transform" />
              <span>{p.label}</span>
              {p.count != null && (
                <span className="text-[10px] text-surface-500 font-mono">
                  ({p.count})
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 2. Jump Back In / Recently Added Carousel */}
      {jumpBackIn.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Clock className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                Jump Back In
              </h2>
            </div>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              <span>View All</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {jumpBackIn.slice(0, 6).map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>
        </section>
      )}

      {/* 3. Genres Strip */}
      {genres.length > 0 && (
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                Explore Genres
              </h2>
            </div>
          </div>

          <div className="flex items-center gap-2.5 overflow-x-auto pb-2 scrollbar-none flex-wrap">
            {genres.slice(0, 14).map((g) => (
              <GenrePill
                key={g.name}
                genre={g.name}
                count={g.track_count}
                onClick={() => onNavigate?.('search', g.name)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 4. Curated Releases Grid */}
      {recentReleases.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Flame className="w-5 h-5 text-accent" />
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                More From Your Collection
              </h2>
            </div>
            <button
              onClick={() => onNavigate?.('albums')}
              className="text-xs font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors"
            >
              <span>Explore</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {recentReleases.map((album) => (
              <AlbumCard
                key={album.id}
                album={album}
                onClick={onAlbumClick}
                onArtistClick={onArtistClick}
                onPlay={handlePlayAlbum}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
