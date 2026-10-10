import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';

export function CoverModal({ coverPath, title, artist, year, onClose }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!coverPath) return null;

  const url = api.coverUrl(coverPath);

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-8 bg-black/85 backdrop-blur-2xl animate-fade-in select-none"
      onClick={onClose}
    >
      {/* Ambient background glow of the cover */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-25 filter blur-3xl pointer-events-none"
        style={{ backgroundImage: `url(${url})` }}
      />

      {/* Main modal container */}
      <div
        className="relative z-10 flex flex-col items-center max-w-4xl max-h-[92vh] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top controls bar */}
        <div className="w-full flex items-center justify-between pb-3 sm:pb-4 text-white">
          <div className="min-w-0 pr-4">
            <h3 className="text-base sm:text-lg font-bold truncate tracking-tight">
              {title || 'Album Artwork'}
            </h3>
            {(artist || year) && (
              <p className="text-xs text-surface-400 truncate">
                {artist} {year ? `· ${year}` : ''}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              download={`${title || 'album'}-cover.jpg`}
              className="p-2 text-surface-300 hover:text-white glass-panel rounded-xl hover:bg-white/[0.08] transition-colors"
              title="Open full size / Download"
            >
              <ExternalLink className="w-4 h-4" />
            </a>

            <button
              onClick={onClose}
              className="p-2 text-surface-300 hover:text-rose-400 glass-panel rounded-xl hover:bg-white/[0.08] transition-colors"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Artwork Image */}
        <div className="flex items-center justify-center rounded-2xl sm:rounded-3xl shadow-glass-lg ring-1 ring-white/[0.12] bg-surface-950/80 overflow-hidden max-h-[80vh] max-w-full">
          <img
            src={url}
            alt={title || 'Cover'}
            className="max-h-[80vh] max-w-full object-contain rounded-2xl sm:rounded-3xl"
            draggable="false"
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
