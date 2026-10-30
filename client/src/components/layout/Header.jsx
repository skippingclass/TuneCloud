import { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Search,
  Menu,
  X,
  Disc,
  Users,
  Music2,
  Play,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { api } from '../../api.js';

function formatDuration(sec) {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Header({
  canGoBack,
  onBack,
  canGoForward,
  onForward,
  searchQuery,
  onSearchChange,
  onSubmitSearch,
  onSelectAlbum,
  onSelectArtist,
  onPlayTrack,
  onOpenSidebar,
  currentView,
  currentViewTitle,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const isFocusedRef = useRef(false);
  const inputRef = useRef(null);
  const [results, setResults] = useState({ tracks: [], albums: [], artists: [] });
  const [loading, setLoading] = useState(false);
  const searchContainerRef = useRef(null);
  const requestIdRef = useRef(0);
  const abortRef = useRef(null);

  const closeAndBlur = () => {
    setIsFocused(false);
    isFocusedRef.current = false;
    setDropdownOpen(false);
    inputRef.current?.blur();
  };

  // Close dropdown on outside click or touch
  useEffect(() => {
    const handlePointerDown = (e) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setIsFocused(false);
        isFocusedRef.current = false;
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, []);

  // When view changes, immediately close dropdown and blur
  useEffect(() => {
    closeAndBlur();
  }, [currentView]);

  // Debounced search query fetching (strictly bound to user typing)
  useEffect(() => {
    const reqId = ++requestIdRef.current;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    const q = (searchQuery || '').trim();
    if (!q || currentView === 'search') {
      setResults({ tracks: [], albums: [], artists: [] });
      setDropdownOpen(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      api
        .search(q, { signal: controller.signal })
        .then((data) => {
          if (reqId !== requestIdRef.current || controller.signal.aborted) return;
          setResults({
            tracks: data?.tracks?.slice(0, 4) || [],
            albums: data?.albums?.slice(0, 3) || [],
            artists: data?.artists?.slice(0, 3) || [],
          });
          // ONLY open dropdown if input is currently focused by user
          if (isFocusedRef.current) {
            setDropdownOpen(true);
          }
        })
        .catch((err) => {
          if (
            err?.name === 'AbortError' ||
            reqId !== requestIdRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          setResults({ tracks: [], albums: [], artists: [] });
        })
        .finally(() => {
          if (reqId === requestIdRef.current && !controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [searchQuery, currentView]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      const q = (searchQuery || '').trim();
      if (q) {
        closeAndBlur();
        onSubmitSearch?.(q);
      }
    } else if (e.key === 'Escape') {
      closeAndBlur();
    }
  };

  const handleClear = () => {
    requestIdRef.current += 1;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    closeAndBlur();
    onSearchChange?.('');
    setResults({ tracks: [], albums: [], artists: [] });
  };

  const hasAnyResults =
    results.tracks.length > 0 || results.albums.length > 0 || results.artists.length > 0;

  return (
    <header className="h-16 px-4 sm:px-6 glass-panel border-b border-white/[0.06] flex items-center justify-between gap-4 shrink-0 select-none z-30">
      {/* Left: Mobile menu toggle + Navigation history */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenSidebar}
          className="lg:hidden p-2 rounded-xl text-surface-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          title="Open Menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={onBack}
            disabled={!canGoBack}
            className={`p-2 rounded-xl transition-all ${
              canGoBack
                ? 'text-surface-300 hover:text-white hover:bg-white/[0.06]'
                : 'text-surface-600 opacity-40 cursor-default'
            }`}
            title="Go Back"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={onForward}
            disabled={!canGoForward}
            className={`p-2 rounded-xl transition-all ${
              canGoForward
                ? 'text-surface-300 hover:text-white hover:bg-white/[0.06]'
                : 'text-surface-600 opacity-40 cursor-default'
            }`}
            title="Go Forward"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {currentViewTitle && (
          <div className="hidden sm:flex items-center gap-2 pl-3 border-l border-white/[0.08]">
            <h2 className="text-sm font-semibold text-surface-200 capitalize">
              {currentViewTitle}
            </h2>
          </div>
        )}
      </div>

      {/* Center / Right: Global Search Bar with Spotify-style Dropdown */}
      <div ref={searchContainerRef} className="flex-1 max-w-md relative">
        <div className="relative flex items-center">
          {loading ? (
            <Loader2 className="w-4 h-4 text-accent absolute left-3.5 animate-spin pointer-events-none" />
          ) : (
            <Search className="w-4 h-4 text-surface-500 absolute left-3.5 pointer-events-none" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={searchQuery || ''}
            onChange={(e) => onSearchChange?.(e.target.value)}
            onFocus={() => {
              setIsFocused(true);
              isFocusedRef.current = true;
              if (
                (searchQuery || '').trim() &&
                currentView !== 'search' &&
                hasAnyResults
              ) {
                setDropdownOpen(true);
              }
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search your music"
            className="glass-input w-full pl-9 pr-9 py-1.5 text-xs sm:text-sm bg-white/[0.025]"
          />
          {searchQuery && (
            <button
              onClick={handleClear}
              className="p-1 rounded-full text-surface-500 hover:text-white absolute right-2.5 transition-colors"
              title="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Dropdown Results Popover */}
        {dropdownOpen && currentView !== 'search' && (
          <div
            onMouseDown={(e) => e.preventDefault()}
            className="absolute top-full left-0 right-0 sm:-left-12 sm:-right-12 mt-2 glass-panel rounded-2xl shadow-glass-lg border border-white/[0.1] backdrop-blur-2xl overflow-hidden z-50 animate-fade-in max-h-[75vh] flex flex-col"
          >
            <div className="p-2 space-y-3 overflow-y-auto flex-1">
              {!hasAnyResults && !loading && (
                <div className="py-6 text-center text-xs text-surface-500">
                  No matching results for "{searchQuery}"
                </div>
              )}

              {/* Top Artists */}
              {results.artists.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold tracking-wider text-surface-500 uppercase px-2 mb-1 block">
                    Artists
                  </span>
                  <div className="space-y-0.5">
                    {results.artists.map((artist) => (
                      <div
                        key={artist.id || artist.name}
                        onClick={() => {
                          closeAndBlur();
                          onSelectArtist?.({ id: artist.id, name: artist.name });
                        }}
                        className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/[0.06] cursor-pointer transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-full bg-surface-800 flex items-center justify-center ring-1 ring-white/[0.08] text-surface-400 group-hover:text-accent transition-colors">
                          <Users className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-white truncate group-hover:text-accent transition-colors">
                            {artist.name}
                          </p>
                          <p className="text-[10px] text-surface-500">Artist</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Albums */}
              {results.albums.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold tracking-wider text-surface-500 uppercase px-2 mb-1 block">
                    Albums
                  </span>
                  <div className="space-y-0.5">
                    {results.albums.map((album) => (
                      <div
                        key={album.id}
                        onClick={() => {
                          closeAndBlur();
                          onSelectAlbum?.(album);
                        }}
                        className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/[0.06] cursor-pointer transition-colors group"
                      >
                        <div className="w-9 h-9 rounded-lg overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.08]">
                          {album.cover_path ? (
                            <img
                              src={api.coverUrl(album.cover_path)}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Disc className="w-4 h-4 text-surface-500" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-white truncate group-hover:text-accent transition-colors">
                            {album.title}
                          </p>
                          <p className="text-[10px] text-surface-400 truncate">
                            {album.artist} {album.year ? `· ${album.year}` : ''}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tracks */}
              {results.tracks.length > 0 && (
                <div>
                  <span className="text-[10px] font-bold tracking-wider text-surface-500 uppercase px-2 mb-1 block">
                    Songs
                  </span>
                  <div className="space-y-0.5">
                    {results.tracks.map((track) => (
                      <div
                        key={track.id}
                        onClick={() => {
                          closeAndBlur();
                          onPlayTrack?.(track);
                        }}
                        className="flex items-center justify-between gap-3 p-2 rounded-xl hover:bg-white/[0.06] cursor-pointer transition-colors group"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-8 h-8 rounded-lg overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.08] relative">
                            {track.cover_path ? (
                              <img
                                src={api.coverUrl(track.cover_path)}
                                alt=""
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music2 className="w-3.5 h-3.5 text-surface-500" />
                              </div>
                            )}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                              <Play className="w-3 h-3 fill-white text-white ml-0.5" />
                            </div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-white truncate group-hover:text-accent transition-colors">
                              {track.title || track.file_name}
                            </p>
                            <p className="text-[10px] text-surface-400 truncate">
                              {track.artist || 'Unknown'}
                            </p>
                          </div>
                        </div>
                        <span className="text-[10px] text-surface-500 font-mono shrink-0">
                          {formatDuration(track.duration)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Footer: See all results */}
            <div
              onClick={() => {
                closeAndBlur();
                onSubmitSearch?.(searchQuery);
              }}
              className="p-2.5 bg-white/[0.03] hover:bg-accent/15 border-t border-white/[0.06] flex items-center justify-between cursor-pointer transition-colors group"
            >
              <span className="text-xs font-medium text-surface-300 group-hover:text-white">
                See all results for "{searchQuery}"
              </span>
              <div className="flex items-center gap-1 text-accent text-xs font-semibold">
                <span>Enter</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

