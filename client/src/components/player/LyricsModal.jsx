import { useEffect, useState } from 'react';
import { X, Maximize2, Minimize2, Volume2, VolumeX, ListMusic } from 'lucide-react';
import { useDialog } from '../../hooks/useDialog.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { LyricsContent } from './LyricsContent.jsx';
import { PlaybackArtwork, PlaybackIdentity, PlaybackTimeline, PlaybackTransport } from './PlaybackDetails.jsx';
import { RangeControl } from './RangeControl.jsx';
import { SleepTimer } from './SleepTimer.jsx';

// A single full-player surface for artwork and lyrics, on both screen sizes.
export function LyricsModal({ onGoToAlbum, onGoToArtist }) {
  const { currentTrack, isLyricsOpen, setIsLyricsOpen, playerView, setPlayerView, volume, muted, toggleMute, setVolume, setIsQueueOpen, setIsNowPlayingOpen } = usePlayer();
  const [fullscreen, setFullscreen] = useState(false);
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
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label={playerView === 'lyrics' ? 'Lyrics' : 'Now playing'} tabIndex={-1}
    className={`full-player ${playerView === 'lyrics' ? 'show-lyrics' : 'show-artwork'}`}>
    <header className="full-player-header">
      <span>Now playing</span>
      <div className="player-view-switch" role="group" aria-label="Player view">
        <button onClick={() => setPlayerView('artwork')} aria-pressed={playerView === 'artwork'}>Artwork</button>
        <button onClick={() => setPlayerView('lyrics')} aria-pressed={playerView === 'lyrics'}>Lyrics</button>
      </div>
      <div><button className="player-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Fullscreen (F)">
        {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>
        <button className="player-icon" onClick={close} aria-label="Close player view"><X size={22} /></button></div>
    </header>
    <main className="full-player-main">
      <div className="full-player-art">
        <PlaybackArtwork />
        <PlaybackIdentity onGoToArtist={onGoToArtist} onGoToAlbum={onGoToAlbum} onNavigate={navigate} />
      </div>
      {playerView === 'lyrics' && <section className="full-player-lyrics" aria-label="Song lyrics">
        <div className="full-player-lyrics-track"><PlaybackIdentity onGoToArtist={onGoToArtist} onGoToAlbum={onGoToAlbum} onNavigate={navigate} /></div>
        <LyricsContent />
      </section>}
    </main>
    <footer className="full-player-footer">
      <div className="full-player-extras"><SleepTimer compact />
        <button className="player-icon" onClick={() => { close(); setIsNowPlayingOpen(false); setIsQueueOpen(true); }} aria-label="Open queue"><ListMusic size={21} /></button></div>
      <div className="full-player-playback"><PlaybackTransport /><PlaybackTimeline /></div>
      <div className="full-player-volume"><button className="player-icon" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
        {muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
        <RangeControl label="Volume" value={muted ? 0 : volume} onChange={setVolume} valueText={`${Math.round((muted ? 0 : volume) * 100)}%`} /></div>
    </footer>
  </div>;
}
