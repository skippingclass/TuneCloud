import { Disc, Heart, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1 } from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useFavorites } from '../../context/FavoritesContext.jsx';
import { ArtistLinks } from '../common/ArtistLinks.jsx';
import { RangeControl } from './RangeControl.jsx';

export const playbackTime = seconds => `${Math.floor(Math.max(0, seconds || 0) / 60)}:${String(Math.floor(Math.max(0, seconds || 0) % 60)).padStart(2, '0')}`;

export function PlaybackArtwork() {
  const { currentTrack: track } = usePlayer();
  return <div className="np-artwork">{track?.cover_path
    ? <img src={api.coverUrl(track.cover_path)} alt={`Cover of ${track.album || track.title}`} draggable="false" />
    : <Disc size={72} aria-hidden="true" />}</div>;
}

export function PlaybackIdentity({ onGoToArtist, onGoToAlbum, onNavigate, showFavorite = true }) {
  const { currentTrack: track } = usePlayer();
  const { isTrackStarred, toggleFavoriteTrack } = useFavorites();
  if (!track) return null;
  const starred = isTrackStarred(track.id);
  return <div className="np-identity">
    <div className="np-title-row"><h2>{track.title || track.file_name || track.fileName}</h2>
      {showFavorite && <button className={`player-icon np-favorite ${starred ? 'is-active' : ''}`} onClick={() => toggleFavoriteTrack(track.id)}
        aria-label={starred ? 'Unlike track' : 'Like track'} aria-pressed={starred} title={starred ? 'Unlike' : 'Like'}>
        <Heart size={22} fill={starred ? 'currentColor' : 'none'} />
      </button>}
    </div>
    <div className="np-artist"><ArtistLinks artist={track.artist} primaryArtistId={track.artist_id} primaryArtistName={track.primary_artist} albumArtistName={track.album_artist || track.album_artist_credit} artists={track.metadata?.artists || track.artists}
      onGoToArtist={onGoToArtist} onBeforeNavigate={onNavigate} /></div>
    {track.album && <button className="np-album" onClick={() => { onGoToAlbum?.({ id: track.album_id, title: track.album, artist: track.artist, cover_path: track.cover_path }); onNavigate?.(); }}>{track.album}</button>}
  </div>;
}

export function PlaybackTimeline() {
  const { duration, currentTime, seek } = usePlayer();
  return <div className="np-timeline">
    <RangeControl label="Playback position" max={duration} step={0.1} value={currentTime} onChange={seek}
      valueText={`${playbackTime(currentTime)} of ${playbackTime(duration)}`} />
    <div><span>{playbackTime(currentTime)}</span><span>{playbackTime(duration)}</span></div>
  </div>;
}

export function PlaybackTransport() {
  const { isPlaying, togglePlay, prev, next, hasPrev, hasNext, shuffle, toggleShuffle, repeat, toggleRepeat } = usePlayer();
  return <div className="np-transport">
    <button className={`player-icon ${shuffle ? 'is-active' : ''}`} onClick={toggleShuffle} aria-label="Shuffle" aria-pressed={shuffle}><Shuffle size={20} /></button>
    <button className="player-icon" onClick={prev} disabled={!hasPrev} aria-label="Previous track"><SkipBack size={25} fill="currentColor" /></button>
    <button className="np-play" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause size={25} fill="currentColor" /> : <Play size={25} fill="currentColor" />}</button>
    <button className="player-icon" onClick={next} disabled={!hasNext} aria-label="Next track"><SkipForward size={25} fill="currentColor" /></button>
    <button className={`player-icon ${repeat !== 'none' ? 'is-active' : ''}`} onClick={toggleRepeat} aria-label={`Repeat: ${repeat}`} aria-pressed={repeat !== 'none'}>
      {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
    </button>
  </div>;
}
