// Commas and semicolons separate participants; slashes and ampersands remain names.
export function splitArtists(value) {
  return String(value || '').split(/\s*[,;]\s*|\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+/i).map(s => s.trim()).filter(Boolean);
}

const list = value => [...new Set((Array.isArray(value) ? value : value ? [value] : []).map(v => String(v).trim()).filter(Boolean))];
export function readMetadata(common, format = {}) {
  const artists = list((common.artists?.length > 1 ? common.artists : [common.artist || common.artists?.[0]]).flatMap(splitArtists));
  const albumArtists = list((common.albumartists?.length > 1 ? common.albumartists : [common.albumartist || common.albumartists?.[0]]).flatMap(splitArtists));
  return {
    artists: artists.map(name => ({ name })), albumArtists: albumArtists.map(name => ({ name })),
    genres: list(common.genre), composers: list(common.composer),
    compilation: Boolean(common.compilation), discTotal: common.disk?.of || null,
    musicBrainzId: common.musicbrainz_recordingid || common.musicbrainz_trackid || null,
    albumMusicBrainzId: common.musicbrainz_albumid || null,
    artistMusicBrainzIds: list(common.musicbrainz_artistid),
    bitDepth: format.bitsPerSample, channelCount: format.numberOfChannels,
    replayGain: common.replaygain_track_gain || common.replaygain_album_gain ? {
      trackGain: common.replaygain_track_gain?.dB, albumGain: common.replaygain_album_gain?.dB,
      trackPeak: common.replaygain_track_peak, albumPeak: common.replaygain_album_peak,
    } : undefined,
  };
}

/**
 * Resolves all participating artist IDs in bulk (`DO NOTHING` avoids dead-tuple
 * churn on existing artists) and enriches `record.metadata` + `record.composer`
 * in memory BEFORE `INSERT INTO tracks`, eliminating a second `UPDATE tracks` pass.
 */
export async function prepareTrackMetadataBatch(client, records) {
  if (!records.length) return;
  const names = [...new Set(records.flatMap(r => [
    ...(r.metadata?.artists?.map(a => a.name) || []),
    ...(r.metadata?.albumArtists?.map(a => a.name) || []),
    ...(r.metadata?.composers || []),
  ]))];
  if (names.length) {
    await client.query(
      `INSERT INTO artists(name)
       SELECT DISTINCT ON (LOWER(n)) n FROM unnest($1::text[]) n
       ON CONFLICT (LOWER(name)) DO NOTHING`,
      [names]
    );
  }
  const artists = names.length
    ? (await client.query('SELECT id, name FROM artists WHERE LOWER(name) = ANY($1::text[])', [names.map(n => n.toLowerCase())])).rows
    : [];
  const byName = new Map(artists.map(a => [a.name.toLowerCase(), a.id]));
  for (const record of records) {
    for (const field of ['artists', 'albumArtists']) {
      record.metadata[field] = (record.metadata[field] || []).map(a => ({ ...a, id: String(byName.get(a.name.toLowerCase())) }));
    }
    record.metadata.contributors = (record.metadata.composers || []).map(name => ({
      role: 'composer',
      artist: { name, id: String(byName.get(name.toLowerCase())) },
    }));
    record.composer = record.metadata.composers?.length ? record.metadata.composers.join(', ') : null;
  }
}

/**
 * Syncs `track_credits` and `artists.musicbrainz_id` in set-based queries
 * after `tracks` rows have been inserted/upserted.
 */
export async function syncTrackCreditsAndMbids(client, records) {
  if (!records.length) return;
  const paths = records.map(r => r.file_path);
  await client.query(
    `DELETE FROM track_credits c USING tracks t
     WHERE c.track_id = t.id AND t.file_path = ANY($1::text[]) AND c.role IN ('artist','albumartist','composer')`,
    [paths]
  );
  await client.query(
    `INSERT INTO track_credits(track_id, artist_id, role, credited_as)
     SELECT t.id, (a->>'id')::int, role, a->>'name' FROM tracks t
     CROSS JOIN (VALUES ('artist','artists'),('albumartist','albumArtists')) roles(role, field)
     CROSS JOIN LATERAL jsonb_array_elements(t.metadata->roles.field) a
     WHERE t.file_path = ANY($1::text[]) ON CONFLICT DO NOTHING`,
    [paths]
  );
  await client.query(
    `INSERT INTO track_credits(track_id, artist_id, role, credited_as)
     SELECT t.id, (c->'artist'->>'id')::int, 'composer', c->'artist'->>'name' FROM tracks t
     CROSS JOIN LATERAL jsonb_array_elements(t.metadata->'contributors') c
     WHERE t.file_path = ANY($1::text[]) ON CONFLICT DO NOTHING`,
    [paths]
  );

  // Batch MusicBrainz artist ID updates instead of issuing N+1 queries per track.
  // Never associate the same MBID with a different named artist on a tag error.
  const mbidPairs = new Map(); // mbid -> artistId
  const seenArtists = new Set();
  for (const record of records) {
    const ids = record.metadata.artistMusicBrainzIds || [];
    if (ids.length === 1 || ids.length === record.metadata.artists.length) {
      for (const [index, artist] of record.metadata.artists.entries()) {
        const mbid = ids[index];
        const artistId = Number(artist.id);
        if (!mbid || !Number.isFinite(artistId) || seenArtists.has(artistId) || mbidPairs.has(mbid)) continue;
        seenArtists.add(artistId);
        mbidPairs.set(mbid, artistId);
      }
    }
  }
  if (mbidPairs.size > 0) {
    const mbids = [...mbidPairs.keys()];
    const artistIds = [...mbidPairs.values()];
    await client.query(
      `UPDATE artists AS a
       SET musicbrainz_id = u.mbid
       FROM unnest($1::text[], $2::int[]) AS u(mbid, artist_id)
       WHERE a.id = u.artist_id
         AND a.musicbrainz_id IS DISTINCT FROM u.mbid
         AND NOT EXISTS (
           SELECT 1 FROM artists other
           WHERE other.musicbrainz_id = u.mbid AND other.id <> u.artist_id
         )`,
      [mbids, artistIds]
    );
  }
}

// Used by staged tag writes (and legacy callers) inside their DB transaction.
export async function saveTrackMetadata(client, records) {
  if (!records.length) return;
  await prepareTrackMetadataBatch(client, records);
  const payload = JSON.stringify(records);
  await client.query(
    `UPDATE tracks t
     SET metadata = r.metadata,
         composer = NULLIF((SELECT string_agg(c, ', ') FROM jsonb_array_elements_text(r.metadata->'composers') c), '')
     FROM jsonb_to_recordset($1::jsonb) r(file_path text, metadata jsonb)
     WHERE t.file_path = r.file_path`,
    [payload]
  );
  await syncTrackCreditsAndMbids(client, records);
}

export function albumReleaseKey(folder, metadata) {
  return metadata?.albumMusicBrainzId ? `mbid:${metadata.albumMusicBrainzId}` : `folder:${folder}`;
}
