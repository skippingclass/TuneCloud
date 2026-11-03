import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, Maximize2, Mic2, ListMusic, ArrowUpRight, Disc, Play } from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useDialog, hasOpenDialog } from '../../hooks/useDialog.js';
import { LyricsContent } from './LyricsContent.jsx';
import { PlaybackArtwork, PlaybackIdentity, PlaybackTimeline, PlaybackTransport } from './PlaybackDetails.jsx';
import { SleepTimer } from './SleepTimer.jsx';
export { SleepTimer } from './SleepTimer.jsx';

export function NowPlaying({ onGoToAlbum, onGoToArtist }) {
  const { currentTrack: track, queue, queueOrder, queueIndex, setQueueIndex, repeat, isNowPlayingOpen, setIsNowPlayingOpen, isLyricsOpen, setIsLyricsOpen, setPlayerView, setIsQueueOpen } = usePlayer();
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  const open = isNowPlayingOpen && !isLyricsOpen && Boolean(track);
  const close = () => setIsNowPlayingOpen(false);
  const dialog = useDialog(open && mobile, close);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!open || mobile) return;
    const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && !hasOpenDialog()) close(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, mobile]);
  if (!open) return null;
  const expand = view => { setPlayerView(view); setIsLyricsOpen(true); };
  const position = queueOrder.indexOf(queueIndex);
  const nextIndex = position >= 0 ? queueOrder[position + 1] ?? (repeat === 'all' ? queueOrder[0] : undefined) : undefined;
  const nextTrack = queue[nextIndex];
  const openQueue = () => { close(); setIsQueueOpen(true); };
  const identity = <PlaybackIdentity onGoToArtist={onGoToArtist} onGoToAlbum={onGoToAlbum} onNavigate={close} />;
  if (mobile) return createPortal(
    <div ref={dialog} className="np-mobile" role="dialog" aria-modal="true" aria-label="Now playing" tabIndex={-1}>
      <div className="np-mobile-content">
        <header className="np-mobile-header">
          <button className="player-icon" onClick={close} aria-label="Collapse player"><ChevronDown size={24} /></button>
          <span>Now playing</span>
          <button className="player-icon" onClick={() => expand('lyrics')} aria-label="Open lyrics"><Mic2 size={20} /></button>
        </header>
        <PlaybackArtwork />
        {identity}
        <PlaybackTimeline />
        <PlaybackTransport />
        <footer className="np-mobile-footer">
          <SleepTimer />
          <div><button className="player-icon" onClick={() => expand('lyrics')} aria-label="Lyrics"><Mic2 size={21} /></button>
            <button className="player-icon" onClick={() => { close(); setIsQueueOpen(true); }} aria-label="Open queue"><ListMusic size={22} /></button></div>
        </footer>
      </div>
    </div>, document.body,
  );
  return <aside className="now-playing-panel" aria-label="Now playing">
    <header className="np-panel-header"><h2>Now playing</h2><div>
      <button className="player-icon" onClick={() => expand('artwork')} aria-label="Expand player" title="Full player"><Maximize2 size={17} /></button>
      <button className="player-icon" onClick={close} aria-label="Close now playing"><X size={19} /></button>
    </div></header>
    <div className="np-panel-scroll">
      <PlaybackArtwork />
      {identity}
      <section className="np-lyrics-card">
        <header><h3>Lyrics</h3><button className="player-icon" onClick={() => expand('lyrics')} aria-label="Open lyrics" title="Expand lyrics"><ArrowUpRight size={18} /></button></header>
        <LyricsContent compact />
      </section>
      <section className="np-next-card" aria-label="Next up">
        <header><h3>Next up</h3><button onClick={openQueue}>Open queue</button></header>
        {nextTrack ? <button className="np-next-track" onClick={() => setQueueIndex(nextIndex)} disabled={nextTrack.available === false}
          aria-label={`Play next: ${nextTrack.title || nextTrack.file_name || nextTrack.fileName}`}>
          <span className="np-next-art">{nextTrack.cover_path ? <img src={api.coverUrl(nextTrack.cover_path)} alt="" /> : <Disc size={20} />}
            <span><Play size={18} fill="currentColor" /></span></span>
          <span className="np-next-copy"><strong>{nextTrack.title || nextTrack.file_name || nextTrack.fileName}</strong>
            <span>{nextTrack.available === false ? 'Unavailable' : nextTrack.artist || 'Unknown artist'}</span></span>
        </button> : <p className="np-next-empty">No tracks up next.</p>}
      </section>
    </div>
  </aside>;
}
