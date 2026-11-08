import { useState, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, VolumeX, Heart, ListMusic, Mic2, X, Disc, Maximize2, PanelRightOpen, Plus } from 'lucide-react';
import { NowPlaying } from './NowPlaying.jsx';
import { SleepTimer } from './SleepTimer.jsx';
import { RangeControl } from './RangeControl.jsx';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { CoverModal } from '../modals/CoverModal.jsx';
import { ArtistLinks } from '../common/ArtistLinks.jsx';
const time = sec => `${Math.floor(Math.max(0, sec || 0) / 60)}:${String(Math.floor(Math.max(0, sec || 0) % 60)).padStart(2, '0')}`;

export function Player({ onGoToAlbum, onGoToArtist, onAddToPlaylist }) {
  const { currentTrack: track, setIsNowPlayingOpen, isPlaying, currentTime, duration, volume, muted, repeat, shuffle,
    isLyricsOpen, setIsLyricsOpen, playerView, setPlayerView, isNowPlayingOpen, isQueueOpen, setIsQueueOpen, togglePlay, seek, next, prev, setVolume,
    toggleMute, toggleRepeat, toggleShuffle, clearQueue, hasNext, hasPrev } = usePlayer();
  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  const [showCover, setShowCover] = useState(false);
  const [volumeNode, setVolumeNode] = useState(null);
  useEffect(() => {
    if (!volumeNode) return;
    const wheel = event => { event.preventDefault(); event.stopPropagation(); setVolume(value => Math.max(0, Math.min(1, value + (event.deltaY < 0 ? 0.05 : -0.05)))); };
    volumeNode.addEventListener('wheel', wheel, { passive: false });
    return () => volumeNode.removeEventListener('wheel', wheel);
  }, [volumeNode, setVolume]);
  useEffect(() => {
    const handler = event => {
      if (!track || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(event.target?.tagName) || event.target?.isContentEditable || document.querySelector('[role="dialog"]')) return;
      if (event.key === ' ') { event.preventDefault(); togglePlay(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); seek(currentTime + 10); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(currentTime - 10); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [track, currentTime, togglePlay, seek]);
  if (!track) return null;
  const openNowPlaying = () => { setIsQueueOpen(false); setIsNowPlayingOpen(value => !value); };
  const openQueue = () => { setIsNowPlayingOpen(false); setIsQueueOpen(value => !value); };
  const openFullPlayer = view => { setPlayerView(view); setIsQueueOpen(false); setIsLyricsOpen(true); };
  const title = track.title || track.fileName || track.file_name;
  const starred = isTrackStarred(track.id);
  const goAlbum = () => onGoToAlbum?.({ id: track.album_id, title: track.album, artist: track.artist, cover_path: track.cover_path });
  const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0;
  return <>
    <div className="mobile-mini-player">
      <button className="mini-track" onClick={openNowPlaying} aria-label={`Expand player: ${title}`}>
        {track.cover_path ? <img src={api.coverUrl(track.cover_path)} alt="" /> : <Disc size={32} />}
        <span><strong>{title}</strong><small>{track.artist || 'Unknown artist'}</small></span>
      </button>
      <button onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
      <button onClick={openQueue} aria-label="Open queue"><ListMusic size={20} /></button>
      <div className="mini-progress" style={{ width: `${progress}%` }} />
    </div>
    <NowPlaying onGoToAlbum={onGoToAlbum} onGoToArtist={onGoToArtist} />
    <section className="playback-bar" aria-label="Music player">
      <div className="playback-track">
        <button className="playback-art" onClick={() => track.cover_path ? setShowCover(true) : setIsNowPlayingOpen(true)} aria-label="View cover">
          {track.cover_path ? <img src={api.coverUrl(track.cover_path)} alt="" draggable="false" /> : <Disc size={23} />}
          <span><Maximize2 size={16} /></span>
        </button>
        <div className="playback-meta">
          <button className="playback-title" onClick={goAlbum} disabled={!track.album_id && !track.album} title={title}>{title}</button>
          <div className="playback-artist"><ArtistLinks artist={track.artist} primaryArtistId={track.artist_id} primaryArtistName={track.primary_artist} albumArtistName={track.album_artist || track.album_artist_credit} artists={track.metadata?.artists || track.artists} onGoToArtist={onGoToArtist} /></div>
        </div>
        <button className={`player-icon playback-like ${starred ? 'is-active' : ''}`} onClick={() => toggleFavoriteTrack(track.id)} aria-label={starred ? 'Unlike' : 'Like'} aria-pressed={starred} title={starred ? 'Unlike' : 'Like'}><Heart size={17} fill={starred ? 'currentColor' : 'none'} /></button>
        {onAddToPlaylist && <button className="player-icon playback-add" onClick={() => onAddToPlaylist(track)} aria-label="Add to playlist" title="Add to playlist"><Plus size={17} /></button>}
      </div>
      <div className="playback-center">
        <div className="playback-buttons">
          <button className={`player-icon ${shuffle ? 'is-active' : ''}`} onClick={toggleShuffle} aria-label="Shuffle" aria-pressed={shuffle} title="Shuffle"><Shuffle size={16} /></button>
          <button className="player-icon" onClick={prev} disabled={!hasPrev} aria-label="Previous track" title="Previous track"><SkipBack size={19} fill="currentColor" /></button>
          <button className="playback-play" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'} title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
          <button className="player-icon" onClick={next} disabled={!hasNext} aria-label="Next track" title="Next track"><SkipForward size={19} fill="currentColor" /></button>
          <button className={`player-icon ${repeat !== 'none' ? 'is-active' : ''}`} onClick={toggleRepeat} aria-label={`Repeat: ${repeat}`} aria-pressed={repeat !== 'none'} title={`Repeat: ${repeat}`}>{repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}</button>
        </div>
        <div className="playback-timeline"><span>{time(currentTime)}</span><RangeControl label="Playback position" max={duration} step={0.1} value={currentTime} onChange={seek} valueText={`${time(currentTime)} of ${time(duration)}`} /><span>{time(duration)}</span></div>
      </div>
      <div className="playback-tools">
        <SleepTimer compact />
        <button className={`player-icon ${isLyricsOpen && playerView === 'lyrics' ? 'is-active' : ''}`} onClick={() => isLyricsOpen && playerView === 'lyrics' ? setIsLyricsOpen(false) : openFullPlayer('lyrics')} aria-label="Lyrics" aria-pressed={isLyricsOpen && playerView === 'lyrics'} title="Lyrics"><Mic2 size={17} /></button>
        <button className={`player-icon ${isQueueOpen ? 'is-active' : ''}`} onClick={openQueue} aria-label="Queue" aria-expanded={isQueueOpen} title="Queue"><ListMusic size={18} /></button>
        <div ref={setVolumeNode} className="playback-volume" title="Scroll to change volume">
          <button className="player-icon" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <RangeControl label="Volume" value={muted ? 0 : volume} onChange={setVolume} valueText={`${Math.round((muted ? 0 : volume) * 100)}%`} />
        </div>
        <button className={`player-icon playback-now-playing ${isNowPlayingOpen ? 'is-active' : ''}`} onClick={openNowPlaying} aria-label="Now playing" aria-expanded={isNowPlayingOpen} title="Now playing"><PanelRightOpen size={17} /></button>
        <button className="player-icon playback-expand" onClick={() => openFullPlayer('artwork')} aria-label="Full player" title="Full player"><Maximize2 size={16} /></button>
        <span className="playback-divider" />
        <button className="player-icon playback-close" onClick={clearQueue} aria-label="Close player" title="Close player"><X size={16} /></button>
      </div>
    </section>
    {showCover && track.cover_path && <CoverModal coverPath={track.cover_path} title={title} artist={track.artist} year={track.year} onClose={() => setShowCover(false)} />}
  </>;
}
