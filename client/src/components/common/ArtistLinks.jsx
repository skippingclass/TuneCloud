export function parseArtistTokens(artistStr, artists = []) {
  if (!artistStr || typeof artistStr !== 'string') return [];
  // Matches delimiters while capturing them: explicit participant separators; ampersands and slashes may be part of a band name
  const regex = /(\s*[,;]\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+)/gi;
  // Protect explicit artist names before splitting display delimiters: a band
  // such as Earth, Wind & Fire can itself be followed by "feat. Guest".
  const names = artists.map(a => a.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return artistStr.split(regex);
  const protectedNames = [];
  const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const protectedText = artistStr.replace(new RegExp(pattern, 'gi'), name => {
    protectedNames.push(name);
    return `\uE000${protectedNames.length - 1}\uE001`;
  });
  return protectedText.split(regex).map(part => part.replace(/\uE000(\d+)\uE001/g, (_, index) => protectedNames[index]));
}

export function ArtistLinks({
  artist,
  primaryArtistId,
  primaryArtistName,
  albumArtistName,
  artists,
  onGoToArtist,
  className = '',
  linkClassName = 'hover:underline hover:text-white cursor-pointer transition-colors',
  delimiterClassName = 'text-surface-500',
  onBeforeNavigate,
}) {
  if (!artist) {
    return <span className={className}>Unknown Artist</span>;
  }

  const text = String(artist).trim();
  const references = Array.isArray(artists) ? artists : [];
  const explicitLead = albumArtistName && text.toLowerCase().startsWith(`${albumArtistName.trim().toLowerCase()},`);
  const wholeArtist = references.find(a => a.name?.trim().toLowerCase() === text.toLowerCase());
  const parts = !explicitLead && (wholeArtist || primaryArtistName?.trim().toLowerCase() === text.toLowerCase())
    ? [text] : parseArtistTokens(text, explicitLead ? references.filter(a => a !== wholeArtist) : references);

  // Single artist without delimiters
  if (parts.length <= 1) {
    const name = String(artist).trim();
    return (
      <span
        onClick={(e) => {
          if (onGoToArtist) {
            e.stopPropagation();
            onBeforeNavigate?.();
            onGoToArtist({ id: wholeArtist?.id ?? primaryArtistId, name });
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
        const reference = references.find(a => a.name?.trim().toLowerCase() === trimmed.toLowerCase());
        const targetId = reference?.id ?? (currentIdx === 0 && (!primaryArtistName || primaryArtistName.trim().toLowerCase() === trimmed.toLowerCase()) ? primaryArtistId : undefined);

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
