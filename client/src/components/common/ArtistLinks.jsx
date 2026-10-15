export function parseArtistTokens(artistStr) {
  if (!artistStr || typeof artistStr !== 'string') return [];
  // Matches delimiters while capturing them: comma, ampersand, feat, ft, featuring, vs, slash
  const regex = /(\s*(?:,|&|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bvs\.?)\s*)/gi;
  const parts = artistStr.split(regex);
  return parts;
}

export function ArtistLinks({
  artist,
  primaryArtistId,
  onGoToArtist,
  className = '',
  linkClassName = 'hover:underline hover:text-white cursor-pointer transition-colors',
  delimiterClassName = 'text-surface-500',
  onBeforeNavigate,
}) {
  if (!artist) {
    return <span className={className}>Unknown Artist</span>;
  }

  const parts = parseArtistTokens(String(artist));

  // Single artist without delimiters
  if (parts.length <= 1) {
    const name = String(artist).trim();
    return (
      <span
        onClick={(e) => {
          if (onGoToArtist) {
            e.stopPropagation();
            onBeforeNavigate?.();
            onGoToArtist({ id: primaryArtistId, name });
          }
        }}
        className={`${onGoToArtist ? linkClassName : ''} ${className}`}
        title={onGoToArtist ? `Go to artist: ${name}` : undefined}
      >
        {artist}
      </span>
    );
  }

  // Multi-artist segmented rendering
  let artistIndex = 0;
  return (
    <span className={className}>
      {parts.map((part, idx) => {
        // Delimiters have odd indexes in captured split array
        const isDelimiter = idx % 2 === 1;

        if (isDelimiter) {
          return (
            <span key={idx} className={delimiterClassName}>
              {part}
            </span>
          );
        }

        const trimmed = part.trim();
        if (!trimmed) return null;

        const currentIdx = artistIndex++;
        const targetId = currentIdx === 0 ? primaryArtistId : undefined;

        return (
          <span
            key={idx}
            onClick={(e) => {
              if (onGoToArtist) {
                e.stopPropagation();
                onBeforeNavigate?.();
                onGoToArtist({ id: targetId, name: trimmed });
              }
            }}
            className={onGoToArtist ? linkClassName : ''}
            title={onGoToArtist ? `Go to artist: ${trimmed}` : undefined}
          >
            {part}
          </span>
        );
      })}
    </span>
  );
}
