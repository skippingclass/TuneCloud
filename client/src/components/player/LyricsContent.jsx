import { useEffect, useRef } from 'react';
import { Loader2, Mic2, RefreshCw } from 'lucide-react';
import { usePlayer } from '../../context/PlayerContext.jsx';
import { useTrackLyrics } from '../../hooks/useTrackLyrics.js';
import { activeLineIndex } from '../../utils/lyrics.js';

export function LyricsContent({ enabled = true, compact = false }) {
  const { currentTrack, currentTime, seek } = usePlayer();
  const { loading, data, retry } = useTrackLyrics(currentTrack, enabled);
  const active = data?.synced ? activeLineIndex(data.lines, currentTime) : -1;
  const activeLine = useRef(null);
  const scroll = useRef(null);
  useEffect(() => {
    const line = activeLine.current;
    const container = scroll.current;
    if (!line || !container) return;
    // Scroll only the lyrics. scrollIntoView would also move the docked panel,
    // hiding its artwork every time the active line changes.
    const top = container.scrollTop + line.getBoundingClientRect().top - container.getBoundingClientRect().top
      - container.clientHeight / 2 + line.clientHeight / 2;
    container.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' });
  }, [active, currentTrack?.id, compact, enabled]);
  return <div className={`lyrics-content ${compact ? 'is-compact' : ''}`} aria-busy={loading}>
    {loading ? <div className="lyrics-message" role="status"><Loader2 size={22} className="animate-spin" /><span>Loading lyrics...</span></div>
      : !data || data.notFound ? <div className="lyrics-message"><Mic2 size={26} /><p>No lyrics found for this track.</p><button onClick={retry}><RefreshCw size={13} />Try again</button></div>
      : <>
        <div className="lyrics-scroll" ref={scroll}>
          {data.synced ? data.lines.map((line, index) => <div key={index} role="button" tabIndex={0}
            aria-label={line.text || 'Instrumental'}
            aria-current={index === active ? 'true' : undefined} ref={index === active ? activeLine : null}
            className={`lyrics-line ${index === active ? 'is-active' : ''} ${index < active ? 'is-past' : ''}`}
            onClick={() => seek(line.startMs / 1000)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seek(line.startMs / 1000); } }}>
            <p>{line.text || '♪'}</p>
          </div>) : <p className="lyrics-plain">{data.text}</p>}
        </div>
        <div className="lyrics-source">
          {data.source === 'lrc.red'
            ? <a href="https://lrc.red" target="_blank" rel="noopener noreferrer">Lyrics via lrc.red</a>
            : <span>{data.synced ? 'Synced lyrics' : 'Lyrics'} · {data.source}</span>}
        </div>
      </>}
  </div>;
}
