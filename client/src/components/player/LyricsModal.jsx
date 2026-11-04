import { useEffect, useState } from 'react';
import { X, Maximize2, Minimize2, Volume2, VolumeX, ListMusic, Heart } from 'lucide-react';
import { useDialog } from '../../hooks/useDialog.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { LyricsContent, LyricsSource } from './LyricsContent.jsx';
import { PlaybackArtwork, PlaybackIdentity, PlaybackTimeline, PlaybackTransport } from './PlaybackDetails.jsx';
import { RangeControl } from './RangeControl.jsx';
import { SleepTimer } from './SleepTimer.jsx';
import { useTrackLyrics } from '../../hooks/useTrackLyrics.js';
import { extractPalette } from '../../utils/palette.js';
import { api } from '../../api.js';
import { useFavorites } from '../../context/FavoritesContext.jsx';

// A single full-player surface for artwork and lyrics, on both screen sizes.
export function LyricsModal({ onGoToAlbum, onGoToArtist }) {
  const { currentTrack, isLyricsOpen, setIsLyricsOpen, playerView, setPlayerView, volume, muted, toggleMute, setVolume, setIsQueueOpen, setIsNowPlayingOpen } = usePlayer();
  const lyrics = useTrackLyrics(currentTrack, isLyricsOpen && playerView === 'lyrics');
  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  const [palette, setPalette] = useState(null);
  const cover = currentTrack?.cover_path;
  useEffect(() => {
    if (!isLyricsOpen || !cover || typeof Image === 'undefined') return;
    let active = true;
    extractPalette(api.coverUrl(cover)).then(colors => { if (active) setPalette({ cover, colors }); });
    return () => { active = false; };
  }, [isLyricsOpen, cover]);
  const colors = palette && palette.cover === cover ? palette.colors : null;
  const [fullscreen, setFullscreen] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const close = () => {
    if (document.fullscreenElement === dialog.current) document.exitFullscreen?.().catch(() => {});
    setIsLyricsOpen(false);
  };
  const dialog = useDialog(isLyricsOpen && Boolean(currentTrack), () => {
    if (document.fullscreenElement === dialog.current) document.exitFullscreen?.().catch(() => {});
    else setIsLyricsOpen(false);
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else dialog.current?.requestFullscreen?.().catch(() => {});
  };
  const navigate = () => { close(); setIsNowPlayingOpen(false); };
  useEffect(() => {
    if (!isLyricsOpen) return;
    const change = () => setFullscreen(document.fullscreenElement === dialog.current);
    const key = event => {
      if ((event.key === 'f' || event.key === 'F') && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName) && !event.target?.isContentEditable) {
        event.preventDefault(); toggleFullscreen();
      }
    };
    change();
    document.addEventListener('fullscreenchange', change);
    window.addEventListener('keydown', key);
    return () => { document.removeEventListener('fullscreenchange', change); window.removeEventListener('keydown', key); };
  }, [isLyricsOpen]);
  useEffect(() => {
    const node = dialog.current;
    return () => { if (node && document.fullscreenElement === node) document.exitFullscreen?.().catch(() => {}); };
  }, [isLyricsOpen]);
  if (!isLyricsOpen || !currentTrack) return null;
  const controls = <>
    <div className="full-player-playback"><PlaybackTransport />{mobile && <PlaybackTimeline />}</div>
    <div className="full-player-tools">
      <div className="full-player-extras"><SleepTimer compact />
        <button className="player-icon" onClick={() => { close(); setIsNowPlayingOpen(false); setIsQueueOpen(true); }} aria-label="Open queue"><ListMusic size={19} /></button></div>
    </div>
  </>;
  const starred = isTrackStarred(currentTrack.id);
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={playerView === 'lyrics' ? 'Lyrics' : 'Now playing'} tabIndex={-1}
    className={`full-player font-lyrics ${playerView === 'lyrics' ? 'show-lyrics' : 'show-artwork'}`}
    style={{ '--art-color-1': colors?.[0] || 'var(--theme-primary)', '--art-color-2': colors?.[1] || 'var(--theme-secondary)', '--art-color-3': colors?.[2] || colors?.[0] || 'var(--theme-primary)' }}>
    <div className="full-player-ambience" aria-hidden="true"><i /><i /><i /><div /></div>
    <header className="full-player-header">
      <div className="full-player-source">{playerView === 'lyrics' && <LyricsSource data={lyrics.data} loading={lyrics.loading} />}</div>
      <div className="player-view-switch" role="group" aria-label="Player view">
        <button data-autofocus={playerView === 'artwork' ? true : undefined} onClick={() => setPlayerView('artwork')} aria-pressed={playerView === 'artwork'}>Artwork</button>
        <button data-autofocus={playerView === 'lyrics' ? true : undefined} onClick={() => setPlayerView('lyrics')} aria-pressed={playerView === 'lyrics'}>Lyrics</button>
      </div>
      <div><button className="player-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Fullscreen (F)">
        {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>
        <button className="player-icon" onClick={close} aria-label="Close player view"><X size={22} /></button></div>
    </header>
    <main className="full-player-main">
      <div className="full-player-art">
        <div className="full-player-cover">
          <PlaybackArtwork />
          {!mobile && <div className="full-player-cover-controls" aria-label="Playback controls">
            <button className={`full-player-cover-heart ${starred ? 'is-active' : ''}`} onClick={() => toggleFavoriteTrack(currentTrack.id)}
              aria-label={starred ? 'Unlike track' : 'Like track'} aria-pressed={starred}><Heart size={48} fill={starred ? 'currentColor' : 'none'} /></button>
            <div className="full-player-volume">
              <div className="full-player-vertical-range"><RangeControl label="Volume" value={muted ? 0 : volume} onChange={setVolume} orientation="vertical" valueText={`${Math.round((muted ? 0 : volume) * 100)}%`} /></div>
              <button className="player-icon" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
            </div>
            {controls}
          </div>}
        </div>
        {!mobile && <PlaybackTimeline />}
        <PlaybackIdentity showFavorite={mobile} onGoToArtist={onGoToArtist} onGoToAlbum={onGoToAlbum} onNavigate={navigate} />
      </div>
      {playerView === 'lyrics' && <section className="full-player-lyrics" aria-label="Song lyrics">
        <div className="full-player-lyrics-track"><PlaybackIdentity onGoToArtist={onGoToArtist} onGoToAlbum={onGoToAlbum} onNavigate={navigate} /></div>
        <LyricsContent result={lyrics} showSource={false} />
      </section>}
    </main>
    {mobile && <footer className="full-player-footer">{controls}</footer>}
  </div>;
}
