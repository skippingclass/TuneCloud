import { useState, useEffect, useCallback } from 'react';
import { api, setAuthToken, getAuthToken } from './api.js';
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
import { FavoritesView } from './views/FavoritesView.jsx';
import { BrowseView } from './views/BrowseView.jsx';
import { SearchView } from './views/SearchView.jsx';
import { SettingsView } from './views/SettingsView.jsx';
import { AdminView } from './views/AdminView.jsx';
import { LoginView } from './views/LoginView.jsx';

function MainLayout({ user, onLogout }) {
  const [view, setView] = useState('home');
  const [history, setHistory] = useState([{ view: 'home', param: null }]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const [selectedAlbum, setSelectedAlbum] = useState(null);
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [browsePath, setBrowsePath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState(null);
  const [scanVersion, setScanVersion] = useState(0);

  const { currentTrack, playTrack } = usePlayer();

  const navigateTo = useCallback(
    (targetView, param = null) => {
      // Prevent duplicate history entries when clicking same page or same item
      const currentEntry = history[historyIndex];
      if (currentEntry && currentEntry.view === targetView) {
        if (
          targetView === 'album' &&
          (currentEntry.param?.id === param?.id ||
            (!param?.id && currentEntry.param?.title === param?.title))
        ) {
          return;
        }
        if (targetView === 'artist' && currentEntry.param?.name === param?.name) {
          return;
        }
        if (targetView === 'search' && currentEntry.param === param) {
          return;
        }
        if (targetView === 'browse' && currentEntry.param === param) {
          return;
        }
        if (!['album', 'artist', 'search', 'browse'].includes(targetView)) {
          return;
        }
      }

      if (targetView === 'album') {
        setSelectedAlbum(param);
      } else if (targetView === 'artist') {
        setSelectedArtist(param);
      } else if (targetView === 'browse') {
        setBrowsePath(param || '');
      } else if (targetView === 'search') {
        if (typeof param === 'string') setSearchQuery(param);
      }

      setView(targetView);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), { view: targetView, param }]);
      setHistoryIndex((prev) => prev + 1);
    },
    [historyIndex, history]
  );

  const handleBack = () => {
    if (historyIndex > 0) {
      const prevEntry = history[historyIndex - 1];
      setHistoryIndex((i) => i - 1);
      setView(prevEntry.view);
      if (prevEntry.view === 'album') setSelectedAlbum(prevEntry.param);
      if (prevEntry.view === 'artist') setSelectedArtist(prevEntry.param);
      if (prevEntry.view === 'browse') setBrowsePath(prevEntry.param || '');
      if (prevEntry.view === 'search') setSearchQuery(prevEntry.param || '');
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const nextEntry = history[historyIndex + 1];
      setHistoryIndex((i) => i + 1);
      setView(nextEntry.view);
      if (nextEntry.view === 'album') setSelectedAlbum(nextEntry.param);
      if (nextEntry.view === 'artist') setSelectedArtist(nextEntry.param);
      if (nextEntry.view === 'browse') setBrowsePath(nextEntry.param || '');
      if (nextEntry.view === 'search') setSearchQuery(nextEntry.param || '');
    }
  };

  const handleAlbumClick = (album) => navigateTo('album', album);
  const handleArtistClick = (artist) => navigateTo('artist', artist);

  const viewTitles = {
    home: 'Home Hub',
    albums: 'Albums',
    album: selectedAlbum?.title || 'Album',
    artists: 'Artists',
    artist: selectedArtist?.name || 'Artist',
    tracks: 'Tracks Library',
    favorites: 'Favorites',
    browse: 'Folder Browser',
    search: 'Search Library',
    settings: 'Settings',
    admin: 'Admin Panel',
  };

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-surface-950 text-surface-100">
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar */}
        <Sidebar
          activeView={view}
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
            canGoBack={historyIndex > 0}
            onBack={handleBack}
            canGoForward={historyIndex < history.length - 1}
            onForward={handleForward}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSubmitSearch={(q) => navigateTo('search', q)}
            onSelectAlbum={handleAlbumClick}
            onSelectArtist={handleArtistClick}
            onPlayTrack={(track) => playTrack(track, [track])}
            onOpenSidebar={() => setSidebarOpen(true)}
            currentView={view}
            currentViewTitle={viewTitles[view]}
          />

          <main className="flex-1 overflow-y-auto p-4 sm:p-7 pb-28 sm:pb-32 bg-black/15">
            {view === 'home' && (
              <HomeView
                key={scanVersion}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                onNavigate={(v, q) => navigateTo(v, q)}
              />
            )}
            {view === 'albums' && (
              <AlbumsView
                key={scanVersion}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
              />
            )}
            {view === 'album' && selectedAlbum && (
              <AlbumDetailView
                album={selectedAlbum}
                onBack={handleBack}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'artists' && (
              <ArtistsView
                key={scanVersion}
                onArtistClick={handleArtistClick}
              />
            )}
            {view === 'artist' && selectedArtist && (
              <ArtistDetailView
                artist={selectedArtist}
                onBack={handleBack}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'tracks' && (
              <TracksView
                key={scanVersion}
                user={user}
                onGoToAlbum={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'favorites' && (
              <FavoritesView
                user={user}
                onAlbumClick={handleAlbumClick}
                onGoToArtist={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'browse' && (
              <BrowseView
                key={scanVersion}
                browsePath={browsePath}
                onBrowsePathChange={setBrowsePath}
                user={user}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'search' && (
              <SearchView
                initialQuery={searchQuery}
                onAlbumClick={handleAlbumClick}
                onArtistClick={handleArtistClick}
                user={user}
                onEditTags={(t) => setEditingTrack(t)}
              />
            )}
            {view === 'settings' && (
              <SettingsView
                user={user}
                onScanComplete={() => setScanVersion((v) => v + 1)}
              />
            )}
            {view === 'admin' && <AdminView />}
          </main>
        </div>
      </div>

      {/* Floating Bottom Player */}
      <Player
        onGoToAlbum={handleAlbumClick}
        onGoToArtist={handleArtistClick}
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

      {/* Global Toast notifications */}
      <ToastContainer />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    if (getAuthToken()) {
      api
        .me()
        .then((data) => {
          if (data.authenticated) setUser(data.user);
          else setAuthToken(null);
        })
        .catch(() => setAuthToken(null))
        .finally(() => setAuthLoading(false));
    } else {
      setAuthLoading(false);
    }
  }, []);

  const handleLogin = (userData) => setUser(userData);
  const handleLogout = () => {
    setUser(null);
    setAuthToken(null);
  };

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

  if (!user) {
    return (
      <ThemeProvider>
        <LoginView onLogin={handleLogin} />
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
