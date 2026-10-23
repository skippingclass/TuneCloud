export function badRequest(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function ids(value) {
  if (!Array.isArray(value) || value.length > 10000 || value.some(id => !['number', 'string'].includes(typeof id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || Number(id) > 2147483647)) {
    throw badRequest('Expected at most 10000 positive integer track IDs');
  }
  return value.map(Number);
}
export async function checkTracks(client, trackIds) {
  if (!trackIds.length) return;
  const { rows } = await client.query('SELECT id FROM tracks WHERE id = ANY($1::int[]) FOR KEY SHARE', [trackIds]);
  if (new Set(trackIds).size !== rows.length) throw badRequest('One or more tracks do not exist');
}
export async function lockPlaylist(client, id, user) {
  const { rows } = await client.query('SELECT id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true) FOR UPDATE',
    [id, user.id, Boolean(user.is_admin)]);
  if (!rows.length) throw badRequest('Playlist not found or access denied', 404);
}
export async function appendTracks(client, playlistId, trackIds) {
  await checkTracks(client, trackIds);
  await client.query(`INSERT INTO playlist_tracks (playlist_id, track_id, track_order)
    SELECT $1, track_id, (SELECT COALESCE(MAX(track_order), 0) FROM playlist_tracks WHERE playlist_id = $1) + position::int
    FROM unnest($2::int[]) WITH ORDINALITY AS entries(track_id, position)`, [playlistId, trackIds]);
}

