const GENRE_COLORS = [
  '#84cc16', // Lime
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#06b6d4', // Cyan
  '#0284c7', // Sky
  '#a855f7', // Purple
  '#f43f5e', // Rose
  '#6366f1', // Indigo
  '#eab308', // Yellow
  '#ec4899', // Pink
];

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % GENRE_COLORS.length;
  return GENRE_COLORS[idx];
}

export function GenrePill({ genre, count, active, onClick }) {
  const color = hashColor(genre);

  return (
    <button
      onClick={() => onClick?.(genre)}
      className={`group relative flex items-center gap-2.5 px-3.5 py-2 rounded-xl text-xs font-semibold backdrop-blur-md transition-all duration-200 select-none border ${
        active
          ? 'bg-white/[0.1] text-white border-white/[0.2] shadow-glass'
          : 'bg-white/[0.03] hover:bg-white/[0.07] text-surface-300 hover:text-white border-white/[0.06] hover:border-white/[0.14]'
      }`}
    >
      {/* Left indicator bar */}
      <span
        className="w-1.5 h-4 rounded-full transition-transform duration-200 group-hover:scale-y-110"
        style={{
          backgroundColor: color,
          boxShadow: `0 0 10px ${color}80`,
        }}
      />
      <span className="truncate max-w-[140px]">{genre}</span>
      {count != null && (
        <span className="text-[10px] text-surface-500 font-normal">
          {count}
        </span>
      )}
    </button>
  );
}
