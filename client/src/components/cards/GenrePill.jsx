export function GenrePill({ genre, count, active, onClick }) {
  return (
    <button
      aria-pressed={Boolean(active)}
      className={`genre-filter ${active ? "is-active" : ""}`}
      onClick={() => onClick?.(genre)}
    >
      <span>{genre}</span>
      {count != null && <span className="genre-count">{count}</span>}
    </button>
  );
}
