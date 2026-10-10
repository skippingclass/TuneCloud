import { Users } from 'lucide-react';

export function ArtistCard({ artist, image, onClick }) {
  return (
    <div
      onClick={() => onClick?.(artist)}
      className="glass-card group p-4 text-center cursor-pointer select-none flex flex-col items-center justify-between"
    >
      <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-full overflow-hidden bg-surface-900 relative mb-3 ring-2 ring-white/[0.08] group-hover:ring-accent/40 shadow-glass group-hover:shadow-glow transition-all duration-300">
        {image ? (
          <img
            src={image}
            alt={artist.name}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            draggable="false"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-white/[0.03]">
            <Users className="w-12 h-12 text-surface-500 stroke-1" />
          </div>
        )}
      </div>

      <div className="w-full px-1">
        <h3 className="text-sm font-semibold truncate text-surface-100 group-hover:text-accent transition-colors">
          {artist.name}
        </h3>
        <p className="text-[11px] text-surface-500 mt-1 font-medium">
          {artist.album_count ? `${artist.album_count} albums` : ''}{' '}
          {artist.track_count ? `· ${artist.track_count} tracks` : ''}
        </p>
      </div>
    </div>
  );
}
