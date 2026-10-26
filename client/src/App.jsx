import { useState, useEffect, useCallback, useRef } from 'react';
import { api, setAuthToken, getAuthToken, onAuthExpired } from './api.js';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { FavoritesProvider } from './context/FavoritesContext.jsx';
import { PlayerProvider, usePlayer } from './context/PlayerContext.jsx';

import { Sidebar } from './components/layout/Sidebar.jsx';
import { Header } from './components/layout/Header.jsx';
import { ToastContainer } from './components/layout/Toast.jsx';

import { Player } from './components/player/Player.jsx';
import { QueueDrawer } from './components/player/QueueDrawer.jsx';
import { LyricsModal } from './components/player/LyricsModal.jsx';
import { EditTrackModal } from './components/modals/EditTrackModal.jsx';

import { HomeView } from './views/HomeView.jsx';
import { AlbumsView } from './views/AlbumsView.jsx';
import { AlbumDetailView } from './views/AlbumDetailView.jsx';
import { ArtistsView } from './views/ArtistsView.jsx';
import { ArtistDetailView } from './views/ArtistDetailView.jsx';
import { TracksView } from './views/TracksView.jsx';
import { PlaylistsView } from './views/PlaylistsView.jsx';
import { PlaylistDetailView } from './views/PlaylistDetailView.jsx';
import { FavoritesView } from './views/FavoritesView.jsx';
import { BrowseView } from './views/BrowseView.jsx';
import { SearchView } from './views/SearchView.jsx';
import { SettingsView } from './views/SettingsView.jsx';
import { AdminView } from './views/AdminView.jsx';
import { LoginView } from './views/LoginView.jsx';
import { AddToPlaylistModal } from './components/modals/AddToPlaylistModal.jsx';

export function buildUrl(view, param = null) {
  switch (view) {
    case 'home':
      return '/';
    case 'albums':
      return '/albums';
    case 'album': {
      const idOrTitle = param?.id != null ? param.id : (param?.title ? encodeURIComponent(param.title) : '');
      return idOrTitle ? `/album/${idOrTitle}` : '/albums';
    }
    case 'artists':
      return '/artists';
    case 'artist': {
      const idOrName = param?.id != null ? param.id : (param?.name ? encodeURIComponent(param.name) : '');
      return idOrName ? `/artist/${idOrName}` : '/artists';
    }
    case 'tracks':
      return '/tracks';
    case 'playlists':
      return '/playlists';
    case 'playlist': {
      const plId = param?.id != null ? param.id : '';
      return plId ? `/playlist/${plId}` : '/playlists';
    }
    case 'favorites':
      return '/favorites';
    case 'browse': {
      const p = typeof param === 'string' && param.trim() ? param.trim() : '';
      return p ? `/browse/${p.split('/').map(encodeURIComponent).join('/')}` : '/browse';
    }
    case 'search': {
      const q = typeof param === 'string' && param.trim() ? param.trim() : '';
      return q ? `/search?q=${encodeURIComponent(q)}` : '/search';
    }
    case 'settings':
      return '/settings';
    case 'admin':
      return '/admin';
    default:
      return '/';
  }
}

export function parseLocation(pathname, search) {
  const rawPath = pathname !== undefined
    ? pathname
    : (typeof window !== 'undefined' && window.location ? window.location.pathname : '/');
  const rawSearch = search !== undefined
    ? search
    : (typeof window !== 'undefined' && window.location ? window.location.search : '');
  const cleanPath = (rawPath || '/').replace(/\/+$/, '') || '/';
  const searchParams = new URLSearchParams(rawSearch || '');

  if (cleanPath === '/' || cleanPath === '') {
    return { view: 'home', param: null };
  }
  if (cleanPath === '/albums') {
    return { view: 'albums', param: null };
  }
  const albumMatch = cleanPath.match(/^\/(?:album|albums)\/([^/]+)$/);
  if (albumMatch) {
    const raw = decodeURIComponent(albumMatch[1]);
    const num = parseInt(raw, 10);
    return { view: 'album', param: !isNaN(num) && String(num) === raw ? { id: num } : { title: raw } };
  }

  if (cleanPath === '/artists') {
    return { view: 'artists', param: null };
  }
  const artistMatch = cleanPath.match(/^\/(?:artist|artists)\/([^/]+)$/);
  if (artistMatch) {
    const raw = decodeURIComponent(artistMatch[1]);
    const num = parseInt(raw, 10);
    return { view: 'artist', param: !isNaN(num) && String(num) === raw ? { id: num, name: raw } : { name: raw } };
  }

  if (cleanPath === '/tracks') {
    return { view: 'tracks', param: null };
  }

  if (cleanPath === '/playlists') {
    return { view: 'playlists', param: null };
  }
  const playlistMatch = cleanPath.match(/^\/(?:playlist|playlists)\/([^/]+)$/);
  if (playlistMatch) {
    const raw = decodeURIComponent(playlistMatch[1]);
    const num = parseInt(raw, 10);
    return { view: 'playlist', param: !isNaN(num) ? { id: num } : null };
  }

  if (cleanPath === '/favorites') {
    return { view: 'favorites', param: null };
  }

  if (cleanPath === '/browse' || cleanPath.startsWith('/browse/')) {
    const sub = cleanPath.slice('/browse'.length).replace(/^\/+/, '');
    const browsePath = sub ? sub.split('/').map(decodeURIComponent).join('/') : '';
    return { view: 'browse', param: browsePath };
  }

  if (cleanPath === '/search') {
    const q = searchParams.get('q') || '';
    return { view: 'search', param: q };
  }

  if (cleanPath === '/settings') {
    return { view: 'settings', param: null };
  }

  if (cleanPath === '/admin') {
    return { view: 'admin', param: null };
  }

  return { view: 'home', param: null };
}

function MainLayout({ user, onLogout }) {
  const [route, setRoute] = useState(() => parseLocation());
  const [historyDepth, setHistoryDepth] = useState(() => (typeof window !== 'undefined' && window.history ? window.history.state?.idx ?? 0 : 0));

  const [selectedAlbum, setSelectedAlbum] = useState(() => (route.view === 'album' ? route.param : null));
  const [selectedArtist, setSelectedArtist] = useState(() => (route.view === 'artist' ? route.param : null));
  const [selectedPlaylist, setSelectedPlaylist] = useState(() => (route.view === 'playlist' ? route.param : null));
  const [browsePath, setBrowsePath] = useState(() => (route.view === 'browse' ? route.param || '' : ''));
  const [searchQuery, setSearchQuery] = useState(() => (route.view === 'search' ? route.param || '' : ''));

  const [addToPlaylistTrack, setAddToPlaylistTrack] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState(null);
  const [scanVersion, setScanVersion] = useState(0);

  const { currentTrack, playTrack } = usePlayer();

  const navigateTo = useCallback(
    (targetView, param = null, { replace = false } = {}) => {
      const targetUrl = buildUrl(targetView, param);
      const currentUrl = typeof window !== 'undefined' && window.location ? window.location.pathname + window.location.search : '';

      if (targetView === 'album') setSelectedAlbum(param);
      else if (targetView === 'artist') setSelectedArtist(param);
      else if (targetView === 'playlist') setSelectedPlaylist(param);
      else if (targetView === 'browse') setBrowsePath(param || '');
      else if (targetView === 'search') {
        if (typeof param === 'string') setSearchQuery(param);
      }

      if (targetUrl === currentUrl && route.view === targetView) {
        return;
      }

      if (typeof window !== 'undefined' && window.history) {
        const nextDepth = replace
          ? (window.history.state?.idx ?? 0)
          : (window.history.state?.idx ?? 0) + 1;
        const stateObj = { view: targetView, param, idx: nextDepth };

        if (replace && typeof window.history.replaceState === 'function') {
          window.history.replaceState(stateObj, '', targetUrl);
        } else if (typeof window.history.pushState === 'function') {
          window.history.pushState(stateObj, '', targetUrl);
        }
        setHistoryDepth(nextDepth);
      }

      setRoute({ view: targetView, param });
    },
    [route.view]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handlePopState = (e) => {
      const parsed = parseLocation();
      const currentDepth = e?.state?.idx ?? (window.history?.state?.idx ?? 0);
      setHistoryDepth(currentDepth);
      setRoute(parsed);

      if (parsed.view === 'album') setSelectedAlbum(parsed.param);
      else if (parsed.view === 'artist') setSelectedArtist(parsed.param);
      else if (parsed.view === 'playlist') setSelectedPlaylist(parsed.param);
      else if (parsed.view === 'browse') setBrowsePath(parsed.param || '');
      else if (parsed.view === 'search') setSearchQuery(parsed.param || '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history?.back) window.history.back();
  };

  const handleForward = () => {
    if (typeof window !== 'undefined' && window.history?.forward) window.history.forward();
  };

  const handleAlbumClick = (album) => navigateTo('album', album);
  const handleArtistClick = (artist) => navigateTo('artist', artist);
  const handlePlaylistClick = (playlist) => navigateTo('playlist', playlist);

  const activeAlbum = route.view === 'album' ? (selectedAlbum || route.param) : selectedAlbum;
  const activeArtist = route.view === 'artist' ? (selectedArtist || route.param) : selectedArtist;
  const activePlaylist = route.view === 'playlist' ? (selectedPlaylist || route.param) : selectedPlaylist;

  const viewTitles = {
    home: 'Home Hub',
    albums: 'Albums',
    album: activeAlbum?.title || 'Album',
    artists: 'Artists',
    artist: activeArtist?.name || 'Artist',
    tracks: 'Tracks Library',
    playlists: 'Playlists',
    playlist: activePlaylist?.name || 'Playlist',
    favorites: 'Favorites',
    browse: 'Folder Browser',
    search: 'Search Library',
    settings: 'Settings',
    admin: 'Admin Panel',
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-surface-950 text-surface-100">
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Left Sidebar */}
        <Sidebar
          activeView={route.view}
          onViewChange={(v) => navigateTo(v)}
          user={user}
          onLogout={onLogout}
          onScanComplete={() => setScanVersion((v) => v + 1)}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        {/* Center Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Header
            canGoBack={historyDepth > 0 || (typeof window !== 'undefined' && (window.history?.length || 0) > 1)}
            onBack={handleBack}
            canGoForward={true}
            onForward={handleForward}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSubmitSearch={(q) => navigateTo('search', q)}
            onSelectAlbum={handleAlbumClick}
            onSelectArtist={handleArtistClick}
            onPlayTrack={(track) => playTrack(track, [track])}
            onOpenSidebar={() => setSidebarOpen(true)}
            currentView={route.view}
            currentViewTitle={viewTitles[route.view]}
          />

          <main className="flex-1 overflow-y-auto p-4 sm:p-7 pb-[120px] sm:pb-[140px] bg-black/15">
            {route.view === 'home' && (
              <HomeView
                key={scanVersion}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                onNavigate={(v, q) => navigateTo(v, q)}
              />
            )}
            {route.view === 'albums' && (
              <AlbumsView
                key={scanVersion}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
              />
            )}
            {route.view === 'album' && activeAlbum && (
              <AlbumDetailView
                album={activeAlbum}
                onBack={handleBack}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'artists' && (
              <ArtistsView
                key={scanVersion}
                onArtistClick={handleArtistClick}
              />
            )}
            {route.view === 'artist' && activeArtist && (
              <ArtistDetailView
                artist={activeArtist}
                onBack={handleBack}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'tracks' && (
              <TracksView
                key={scanVersion}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'playlists' && (
              <PlaylistsView
                key={scanVersion}
                onPlaylistClick={handlePlaylistClick}
                user={user}
              />
            )}
            {route.view === 'playlist' && activePlaylist && (
              <PlaylistDetailView
                playlist={activePlaylist}
                onBack={handleBack}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'favorites' && (
              <FavoritesView
                user={user}
                onAlbumClick={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'browse' && (
              <BrowseView
                key={scanVersion}
                browsePath={browsePath}
                onBrowsePathChange={setBrowsePath}
                user={user}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'search' && (
              <SearchView
                initialQuery={searchQuery}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                user={user}
                onEditTags={(t) => setEditingTrack(t)}
                onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
              />
            )}
            {route.view === 'settings' && (
              <SettingsView
                user={user}
                onScanComplete={() => setScanVersion((v) => v + 1)}
              />
            )}
            {route.view === 'admin' && <AdminView user={user} />}
          </main>
        </div>
      </div>

      {/* Floating Bottom Player */}
      <Player
        onGoToAlbum={handleAlbumClick}
        onGoToArtist={handleArtistClick}
        onAddToPlaylist={(t) => setAddToPlaylistTrack(t)}
      />

      {/* Slide-out Queue Drawer */}
      <QueueDrawer
        onGoToAlbum={handleAlbumClick}
        onGoToArtist={handleArtistClick}
      />

      {/* Fullscreen Karaoke Lyrics Modal */}
      <LyricsModal
        onGoToAlbum={handleAlbumClick}
        onGoToArtist={handleArtistClick}
      />

      {/* Edit ID3 Tags Modal */}
      {editingTrack && (
        <EditTrackModal
          track={editingTrack}
          onClose={() => setEditingTrack(null)}
          onSaved={() => setScanVersion((v) => v + 1)}
        />
      )}

      {/* Add To Playlist Modal */}
      {addToPlaylistTrack && (
        <AddToPlaylistModal
          track={addToPlaylistTrack}
          onClose={() => setAddToPlaylistTrack(null)}
          onPlaylistCreated={(newPl) => {
            if (newPl?.id) navigateTo('playlist', newPl);
          }}
        />
      )}

      {/* Global Toast notifications */}
      <ToastContainer />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(() => !!getAuthToken());
  const [authError, setAuthError] = useState(null);
  const [sessionNotice, setSessionNotice] = useState(null);

  const verifyAuth = useCallback(async () => {
    if (!getAuthToken()) {
      setUser(null);
      setAuthError(null);
      setAuthLoading(false);
      return;
    }

    setAuthLoading(true);
    setAuthError(null);
    try {
      const data = await api.me();
      if (data && data.authenticated && data.user) {
        setUser(data.user);
        setAuthError(null);
      } else {
        setAuthToken(null);
        setUser(null);
        setAuthError(null);
      }
    } catch (err) {
      if (err?.status === 401) {
        setAuthToken(null);
        setUser(null);
        setAuthError(null);
      } else {
        setAuthError(err?.message || 'Unable to connect to TuneCloud server');
      }
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    verifyAuth();
  }, [verifyAuth]);

  useEffect(() => {
    return onAuthExpired(() => {
      setSessionNotice('Your session expired. Please sign in again.');
      setAuthToken(null);
      setUser(null);
      setAuthError(null);
    });
  }, []);

  // Preserve pre-auth destination URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!user) {
      const currentDest = window.location.pathname + window.location.search;
      if (currentDest && currentDest !== '/' && currentDest !== '/login') {
        try {
          sessionStorage.setItem('tunecloud_redirect', currentDest);
        } catch {}
      }
    }
  }, [user]);

  const handleLogin = (userData) => {
    setSessionNotice(null);
    setAuthError(null);
    setUser(userData);
    if (typeof window !== 'undefined') {
      try {
        const savedRedirect = sessionStorage.getItem('tunecloud_redirect');
        if (savedRedirect) {
          sessionStorage.removeItem('tunecloud_redirect');
          window.history.replaceState({ idx: 0 }, '', savedRedirect);
        }
      } catch {}
    }
  };

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
      setSessionNotice(null);
    } catch {
      setSessionNotice('Signed out on this device. Server sign-out could not be confirmed.');
    } finally {
      setAuthToken(null);
      setUser(null);
      setAuthError(null);
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem('tunecloud_redirect');
          window.history.replaceState({ idx: 0 }, '', '/');
        } catch {}
      }
    }
  }, []);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-950">
        <div className="glass-panel px-7 py-5 rounded-2xl flex items-center gap-3">
          <div className="w-5 h-5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <span className="text-sm font-medium text-surface-400">Loading TuneCloud...</span>
        </div>
      </div>
    );
  }

  if (authError && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-surface-950">
        <div className="glass-panel max-w-sm w-full p-6 sm:p-7 rounded-3xl border border-white/[0.08] text-center space-y-4">
          <p className="text-sm font-semibold text-white">Unable to reach server</p>
          <p className="text-xs text-surface-400">{authError}</p>
          <div className="flex items-center justify-center gap-3 pt-1">
            <button
              type="button"
              onClick={verifyAuth}
              className="btn-primary px-5 py-2 text-xs"
            >
              <span>Retry</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <ThemeProvider>
        <LoginView onLogin={handleLogin} notice={sessionNotice} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <FavoritesProvider>
        <PlayerProvider>
          <MainLayout user={user} onLogout={handleLogout} />
        </PlayerProvider>
      </FavoritesProvider>
    </ThemeProvider>
  );
}
