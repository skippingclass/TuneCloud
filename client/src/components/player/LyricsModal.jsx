import { useState, useEffect, useRef } from 'react';
import { X, Mic2, Disc, Loader2 } from 'lucide-react';
import { api } from '../../api.js';
import { usePlayer } from '../../context/PlayerContext.jsx';

function parseLrc(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const result = [];
  const regex = /\[(\d{2}):(\d{2}(?:\.\d+)?)\](.*)/;

  for (const line of lines) {
    const match = line.match(regex);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseFloat(match[2]);
      const text = match[3].trim();
      const time = min * 60 + sec;
      result.push({ time, text });
    }
  }

  return result.sort((a, b) => a.time - b.time);
}

export function LyricsModal() {
  const { currentTrack, currentTime, isLyricsOpen, setIsLyricsOpen, seek } = usePlayer();
  const [loading, setLoading] = useState(true);
  const [lyricsData, setLyricsData] = useState(null);
  const activeLineRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isLyricsOpen || !currentTrack) return;
    setLoading(true);
    setLyricsData(null);

    api
      .lyrics({
        id: currentTrack.id,
        title: currentTrack.title || currentTrack.fileName || '',
        artist: currentTrack.artist || '',
      })
      .then((data) => {
        if (data.synced) {
          const parsed = parseLrc(data.lyrics);
          setLyricsData({ synced: true, lines: parsed, source: data.source });
        } else {
          setLyricsData({ synced: false, text: data.lyrics, source: data.source });
        }
      })
      .catch(() => {
        setLyricsData({ notFound: true });
      })
      .finally(() => setLoading(false));
  }, [isLyricsOpen, currentTrack?.id]);

  // Find active line index
  let activeIndex = -1;
  if (lyricsData?.synced && lyricsData.lines.length > 0) {
    for (let i = 0; i < lyricsData.lines.length; i++) {
      if (currentTime >= lyricsData.lines[i].time) {
        activeIndex = i;
      } else {
        break;
      }
    }
  }

  // Auto-scroll to active line
  useEffect(() => {
    if (activeLineRef.current && containerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  }, [activeIndex]);

  if (!isLyricsOpen || !currentTrack) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 bg-black/80 backdrop-blur-2xl animate-fade-in select-none">
      {/* Background ambient album glow */}
      {currentTrack.cover_path && (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-15 filter blur-3xl pointer-events-none"
          style={{ backgroundImage: `url(${api.coverUrl(currentTrack.cover_path)})` }}
        />
      )}

      {/* Main glass modal container */}
      <div className="relative z-10 w-full max-w-2xl h-[85vh] glass-panel border border-white/[0.1] rounded-3xl shadow-glass flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-white/[0.08] flex items-center justify-between shrink-0 bg-black/20">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-xl overflow-hidden bg-surface-900 shrink-0 ring-1 ring-white/[0.1]">
              {currentTrack.cover_path ? (
                <img
                  src={api.coverUrl(currentTrack.cover_path)}
                  alt=""
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Disc className="w-5 h-5 text-surface-500" />
                </div>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-white truncate leading-tight">
                {currentTrack.title || currentTrack.fileName || currentTrack.file_name}
              </h3>
              <p className="text-xs text-surface-400 truncate mt-0.5">
                {currentTrack.artist || 'Unknown Artist'}
                {lyricsData?.source ? ` · synced via ${lyricsData.source.toUpperCase()}` : ''}
              </p>
            </div>
          </div>

          <button
            onClick={() => setIsLyricsOpen(false)}
            className="p-2.5 rounded-full text-surface-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Lyrics body */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-6 sm:p-10 space-y-6 text-center sm:text-left scroll-smooth"
        >
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-surface-400">
              <Loader2 className="w-7 h-7 animate-spin text-accent" />
              <span className="text-xs font-medium">Finding lyrics...</span>
            </div>
          ) : lyricsData?.notFound ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-surface-500">
              <Mic2 className="w-10 h-10 stroke-1 opacity-50" />
              <p className="text-sm font-semibold">No lyrics found for this track</p>
              <p className="text-xs text-surface-600">Enjoy the music</p>
            </div>
          ) : lyricsData?.synced ? (
            <div className="space-y-4 py-8">
              {lyricsData.lines.map((item, idx) => {
                const isActive = idx === activeIndex;
                const isPassed = idx < activeIndex;
                return (
                  <p
                    key={idx}
                    ref={isActive ? activeLineRef : null}
                    onClick={() => seek(item.time)}
                    className={`cursor-pointer transition-all duration-300 py-1.5 px-3 rounded-2xl ${
                      isActive
                        ? 'text-accent font-bold text-xl sm:text-2xl scale-[1.02] bg-white/[0.05] drop-shadow-[0_0_20px_var(--theme-glow)]'
                        : isPassed
                        ? 'text-surface-400 hover:text-surface-200 text-base sm:text-lg opacity-60'
                        : 'text-surface-500 hover:text-surface-300 text-base sm:text-lg opacity-40'
                    }`}
                  >
                    {item.text || '♪'}
                  </p>
                );
              })}
            </div>
          ) : (
            <div className="whitespace-pre-line text-sm sm:text-base leading-relaxed text-surface-300 font-sans py-4">
              {lyricsData?.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
