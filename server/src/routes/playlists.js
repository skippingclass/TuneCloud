import { query } from '../db.js';
import { requireAuth } from '../auth.js';

export default async function playlistRoutes(fastify) {
  // GET /api/playlists — list playlists accessible by user
  fastify.get('/api/playlists', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user.id;
    const { rows } = await query(
      `SELECT p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at,
              u.username AS owner_username,
              (p.owner_id = $1) AS is_owner,
              COUNT(pt.id)::int AS track_count,
              COALESCE(SUM(t.duration), 0)::int AS duration,
              (
                SELECT COALESCE(t2.cover_path, al.cover_path)
                FROM playlist_tracks pt2
                JOIN tracks t2 ON pt2.track_id = t2.id
                LEFT JOIN albums al ON t2.album_id = al.id
                WHERE pt2.playlist_id = p.id AND (t2.cover_path IS NOT NULL OR al.cover_path IS NOT NULL)
                ORDER BY pt2.track_order ASC, pt2.id ASC
                LIMIT 1
              ) AS cover_path,
              (
                SELECT ARRAY(
                  SELECT COALESCE(t2.cover_path, al.cover_path)
                  FROM playlist_tracks pt2
                  JOIN tracks t2 ON pt2.track_id = t2.id
                  LEFT JOIN albums al ON t2.album_id = al.id
                  WHERE pt2.playlist_id = p.id AND (t2.cover_path IS NOT NULL OR al.cover_path IS NOT NULL)
                  ORDER BY pt2.track_order ASC, pt2.id ASC
                  LIMIT 4
                )
              ) AS sample_covers
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       WHERE p.owner_id = $1 OR p.is_public = true
       GROUP BY p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at, u.username
       ORDER BY p.updated_at DESC, p.id DESC`,
      [userId]
    );

    return { playlists: rows };
  });

  // GET /api/playlists/:id — get playlist metadata and ordered tracks
  fastify.get('/api/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || isNaN(playlistId)) {
      return reply.status(400).send({ error: 'Invalid playlist ID' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const { rows: pRows } = await query(
      `SELECT p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at,
              p.owner_id,
              u.username AS owner_username,
              (p.owner_id = $1) AS is_owner,
              COUNT(pt.id)::int AS track_count,
              COALESCE(SUM(t.duration), 0)::int AS duration
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       WHERE p.id = $2 AND (p.owner_id = $1 OR p.is_public = true OR $3 = true)
       GROUP BY p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at, p.owner_id, u.username`,
      [userId, playlistId, isAdmin]
    );

    if (pRows.length === 0) {
      return reply.status(404).send({ error: 'Playlist not found or access denied' });
    }

    const playlist = pRows[0];

    const { rows: trackRows } = await query(
      `SELECT pt.id AS playlist_track_id, pt.track_order,
              t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              COALESCE(t.track_artist_credit, a.name) AS artist,
              a.name AS primary_artist,
              a.id AS artist_id,
              al.title AS album,
              al.id AS album_id,
              COALESCE(t.cover_path, al.cover_path) AS cover_path,
              EXISTS(SELECT 1 FROM user_starred_tracks ust WHERE ust.track_id = t.id AND ust.user_id = $1) AS is_starred
       FROM playlist_tracks pt
       JOIN tracks t ON pt.track_id = t.id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE pt.playlist_id = $2
       ORDER BY pt.track_order ASC, pt.id ASC`,
      [userId, playlistId]
    );

    playlist.tracks = trackRows;
    playlist.sample_covers = trackRows
      .map((t) => t.cover_path)
      .filter(Boolean)
      .slice(0, 4);
    playlist.cover_path = playlist.sample_covers[0] || null;

    return playlist;
  });

  // POST /api/playlists — create new playlist
  fastify.post('/api/playlists', { preHandler: requireAuth }, async (req, reply) => {
    const { name, comment = null, is_public = false, trackIds = [] } = req.body || {};
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      return reply.status(400).send({ error: 'Playlist name is required' });
    }

    const userId = req.user.id;

    const { rows } = await query(
      `INSERT INTO playlists (name, comment, is_public, owner_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, name, comment, is_public, owner_id, created_at, updated_at`,
      [trimmedName, comment ? String(comment).trim() : null, Boolean(is_public), userId]
    );

    const playlist = rows[0];

    const safeTrackIds = Array.isArray(trackIds)
      ? trackIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id))
      : [];

    for (let i = 0; i < safeTrackIds.length; i++) {
      await query(
        `INSERT INTO playlist_tracks (playlist_id, track_id, track_order, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [playlist.id, safeTrackIds[i], i + 1]
      );
    }

    return reply.status(201).send({
      ...playlist,
      owner_username: req.user.username,
      is_owner: true,
      track_count: safeTrackIds.length,
      tracks: [],
    });
  });

  // PUT /api/playlists/:id — update playlist metadata
  fastify.put('/api/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || isNaN(playlistId)) {
      return reply.status(400).send({ error: 'Invalid playlist ID' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const check = await query(
      'SELECT id, owner_id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, isAdmin]
    );
    if (check.rows.length === 0) {
      return reply.status(403).send({ error: 'Not permitted or playlist not found' });
    }

    const { name, comment, is_public } = req.body || {};
    const updates = [];
    const params = [playlistId];

    if (name !== undefined) {
      const trimmedName = String(name || '').trim();
      if (!trimmedName) {
        return reply.status(400).send({ error: 'Playlist name cannot be empty' });
      }
      params.push(trimmedName);
      updates.push(`name = $${params.length}`);
    }

    if (comment !== undefined) {
      params.push(comment ? String(comment).trim() : null);
      updates.push(`comment = $${params.length}`);
    }

    if (is_public !== undefined) {
      params.push(Boolean(is_public));
      updates.push(`is_public = $${params.length}`);
    }

    updates.push('updated_at = NOW()');

    const { rows } = await query(
      `UPDATE playlists SET ${updates.join(', ')} WHERE id = $1 RETURNING id, name, comment, is_public, updated_at`,
      params
    );

    return rows[0];
  });

  // DELETE /api/playlists/:id — delete playlist
  fastify.delete('/api/playlists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || isNaN(playlistId)) {
      return reply.status(400).send({ error: 'Invalid playlist ID' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const res = await query(
      'DELETE FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, isAdmin]
    );

    if (res.rowCount === 0) {
      return reply.status(404).send({ error: 'Playlist not found or access denied' });
    }

    return { success: true };
  });

  // POST /api/playlists/:id/tracks — add track(s) to playlist
  fastify.post('/api/playlists/:id/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || isNaN(playlistId)) {
      return reply.status(400).send({ error: 'Invalid playlist ID' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const check = await query(
      'SELECT id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, isAdmin]
    );
    if (check.rows.length === 0) {
      return reply.status(403).send({ error: 'Not permitted or playlist not found' });
    }

    const { trackId, trackIds } = req.body || {};
    let toAdd = [];
    if (Array.isArray(trackIds)) {
      toAdd = trackIds.map((id) => parseInt(id, 10)).filter((id) => !isNaN(id));
    } else if (trackId != null) {
      const parsed = parseInt(trackId, 10);
      if (!isNaN(parsed)) toAdd = [parsed];
    }

    if (toAdd.length === 0) {
      return reply.status(400).send({ error: 'No valid track ID provided' });
    }

    const { rows: maxRows } = await query(
      'SELECT COALESCE(MAX(track_order), 0)::int AS max_order FROM playlist_tracks WHERE playlist_id = $1',
      [playlistId]
    );
    let order = maxRows[0].max_order;

    for (const tId of toAdd) {
      order += 1;
      await query(
        `INSERT INTO playlist_tracks (playlist_id, track_id, track_order, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [playlistId, tId, order]
      );
    }

    await query('UPDATE playlists SET updated_at = NOW() WHERE id = $1', [playlistId]);

    return { success: true, added: toAdd.length };
  });

  // DELETE /api/playlists/:id/tracks/:playlistTrackId — remove specific track entry from playlist
  fastify.delete('/api/playlists/:id/tracks/:playlistTrackId', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    const playlistTrackId = parseInt(req.params.playlistTrackId, 10);
    if (!playlistId || !playlistTrackId || isNaN(playlistId) || isNaN(playlistTrackId)) {
      return reply.status(400).send({ error: 'Invalid parameters' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const check = await query(
      'SELECT id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, isAdmin]
    );
    if (check.rows.length === 0) {
      return reply.status(403).send({ error: 'Not permitted or playlist not found' });
    }

    const res = await query(
      'DELETE FROM playlist_tracks WHERE id = $1 AND playlist_id = $2',
      [playlistTrackId, playlistId]
    );

    if (res.rowCount === 0) {
      return reply.status(404).send({ error: 'Track entry not found in playlist' });
    }

    await query('UPDATE playlists SET updated_at = NOW() WHERE id = $1', [playlistId]);

    return { success: true };
  });

  // PUT /api/playlists/:id/reorder — update order of tracks in playlist
  fastify.put('/api/playlists/:id/reorder', { preHandler: requireAuth }, async (req, reply) => {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || isNaN(playlistId)) {
      return reply.status(400).send({ error: 'Invalid playlist ID' });
    }

    const userId = req.user.id;
    const isAdmin = Boolean(req.user.is_admin);

    const check = await query(
      'SELECT id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, isAdmin]
    );
    if (check.rows.length === 0) {
      return reply.status(403).send({ error: 'Not permitted or playlist not found' });
    }

    const { playlistTrackIds } = req.body || {};
    if (!Array.isArray(playlistTrackIds) || playlistTrackIds.length === 0) {
      return reply.status(400).send({ error: 'playlistTrackIds array is required' });
    }

    for (let i = 0; i < playlistTrackIds.length; i++) {
      const ptId = parseInt(playlistTrackIds[i], 10);
      if (!isNaN(ptId)) {
        await query(
          'UPDATE playlist_tracks SET track_order = $1 WHERE id = $2 AND playlist_id = $3',
          [i + 1, ptId, playlistId]
        );
      }
    }

    await query('UPDATE playlists SET updated_at = NOW() WHERE id = $1', [playlistId]);

    return { success: true };
  });
}
