import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';

export default async function trackRoutes(fastify) {
  fastify.get('/api/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = 50, offset = 0, sort = 'title', order = 'asc' } = req.query;

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const sortMap = {
      title: `t.title ${dir}`,
      artist: `a.name ${dir}, al.title, t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      album: `al.title ${dir}, t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      duration: `t.duration ${dir}`,
      created_at: `t.created_at ${dir}`,
      track_number: `t.disc_number, COALESCE(t.track_number, 999) ${dir}, t.file_name`,
    };
    const orderClause = sortMap[sort] || 't.title ASC';

    const { rows } = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              a.name as artist, al.title as album, al.id as album_id, al.cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       ORDER BY ${orderClause}
       LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset]
    );

    const countResult = await query('SELECT COUNT(*) FROM tracks');
    const total = parseInt(countResult.rows[0].count, 10);

    return { tracks: rows, total };
  });

  fastify.get('/api/tracks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT t.*, a.name as artist, al.title as album
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    return rows[0];
  });

  fastify.get('/api/albums', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT al.*, a.name as artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
              (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration
       FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       ORDER BY al.title`
    );
    return rows;
  });

  fastify.get('/api/albums/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT t.*, a.name as artist, al.title as album, al.cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
        WHERE t.album_id = $1
        ORDER BY t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      [id]
    );
    return rows;
  });

  fastify.get('/api/artists', { preHandler: requireAuth }, async (req, reply) => {
    const { rows } = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
       FROM artists a
       ORDER BY a.name`
    );
    return rows;
  });

  fastify.get('/api/search', { preHandler: requireAuth }, async (req, reply) => {
    const { q, limit = 30 } = req.query;
    const cleanQ = String(q || '').trim().slice(0, 100);
    if (!cleanQ) return { tracks: [], albums: [], artists: [] };

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 30), 100);
    const searchTerm = `%${cleanQ}%`;

    const tracks = await query(
      `SELECT t.id, t.title, t.file_name, t.duration, t.track_number, t.format,
              a.name as artist, al.title as album, al.id as album_id, al.cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.title ILIKE $1 OR a.name ILIKE $1 OR al.title ILIKE $1
       LIMIT $2`,
      [searchTerm, safeLimit]
    );

    const albums = await query(
      `SELECT al.*, a.name as artist
       FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       WHERE al.title ILIKE $1
       LIMIT $2`,
      [searchTerm, safeLimit]
    );

    const artists = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
       FROM artists a
       WHERE a.name ILIKE $1
       LIMIT $2`,
      [searchTerm, safeLimit]
    );

    return {
      tracks: tracks.rows,
      albums: albums.rows,
      artists: artists.rows,
    };
  });

  // ---- Favorites ----
  fastify.get('/api/favorites', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user.id;
    const { rows: tracks } = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format,
              a.name as artist, al.title as album, al.id as album_id, al.cover_path,
              true as is_favorite
       FROM user_starred_tracks st
       JOIN tracks t ON st.track_id = t.id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE st.user_id = $1
       ORDER BY st.created_at DESC`,
      [userId]
    );

    const { rows: albums } = await query(
      `SELECT al.*, a.name as artist,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
              (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration,
              true as is_favorite
       FROM user_starred_albums sa
       JOIN albums al ON sa.album_id = al.id
       LEFT JOIN artists a ON al.artist_id = a.id
       WHERE sa.user_id = $1
       ORDER BY sa.created_at DESC`,
      [userId]
    );

    return { tracks, albums };
  });

  fastify.post('/api/favorites/track/:id', { preHandler: requireAuth }, async (req) => {
    const userId = req.user.id;
    const trackId = parseInt(req.params.id, 10);
    const { rows } = await query(
      'SELECT 1 FROM user_starred_tracks WHERE user_id = $1 AND track_id = $2',
      [userId, trackId]
    );
    let starred = false;
    if (rows.length > 0) {
      await query('DELETE FROM user_starred_tracks WHERE user_id = $1 AND track_id = $2', [userId, trackId]);
    } else {
      await query(
        'INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, trackId]
      );
      starred = true;
    }
    return { starred, trackId };
  });

  fastify.post('/api/favorites/album/:id', { preHandler: requireAuth }, async (req) => {
    const userId = req.user.id;
    const albumId = parseInt(req.params.id, 10);
    const { rows } = await query(
      'SELECT 1 FROM user_starred_albums WHERE user_id = $1 AND album_id = $2',
      [userId, albumId]
    );
    let starred = false;
    if (rows.length > 0) {
      await query('DELETE FROM user_starred_albums WHERE user_id = $1 AND album_id = $2', [userId, albumId]);
    } else {
      await query(
        'INSERT INTO user_starred_albums (user_id, album_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, albumId]
      );
      starred = true;
    }
    return { starred, albumId };
  });

  // ---- Genres ----
  fastify.get('/api/genres', { preHandler: requireAuth }, async () => {
    const { rows } = await query(
      `SELECT genre as name, COUNT(*)::int as track_count
       FROM tracks
       WHERE genre IS NOT NULL AND TRIM(genre) <> ''
       GROUP BY genre
       ORDER BY track_count DESC, genre ASC
       LIMIT 50`
    );
    return rows;
  });

  // ---- Scrobble ----
  fastify.post('/api/scrobble/:id', { preHandler: requireAuth }, async (req) => {
    const trackId = parseInt(req.params.id, 10);
    if (!Number.isFinite(trackId)) return { success: false };
    const userId = req.user?.id || null;
    await query('UPDATE tracks SET play_count = play_count + 1, last_played_at = NOW() WHERE id = $1', [trackId]);
    if (userId) {
      await query('INSERT INTO play_history (user_id, track_id) VALUES ($1, $2)', [userId, trackId]);
    }
    return { success: true };
  });

  // ---- Lyrics (Local .lrc + LRCLIB fallback) ----
  fastify.get('/api/lyrics', { preHandler: requireAuth }, async (req, reply) => {
    const { id, title, artist } = req.query;
    let trackPath = null;
    let trackTitle = typeof title === 'string' ? title.slice(0, 200) : null;
    let trackArtist = typeof artist === 'string' ? artist.slice(0, 200) : null;

    if (id) {
      const { rows } = await query(
        `SELECT t.file_path, t.title, t.file_name, a.name as artist
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         WHERE t.id = $1`,
        [id]
      );
      if (rows[0]) {
        trackPath = rows[0].file_path;
        trackTitle = trackTitle || rows[0].title || rows[0].file_name;
        trackArtist = trackArtist || rows[0].artist;
      }
    }

    // 1. Try local .lrc file next to trackPath
    if (trackPath) {
      const dir = path.dirname(trackPath);
      const base = path.basename(trackPath, path.extname(trackPath));
      const lrcCandidates = [
        path.join(dir, `${base}.lrc`),
        path.join(dir, `${base}.txt`),
      ];
      for (const p of lrcCandidates) {
        try {
          if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8');
            return { synced: content.includes('['), lyrics: content, source: 'local' };
          }
        } catch {}
      }
    }

    // 2. Fetch from LRCLIB
    if (trackTitle && trackArtist) {
      try {
        const cleanTitle = trackTitle.replace(/\(.*?\)|\[.*?\]/g, '').trim();
        const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle || trackTitle)}&artist_name=${encodeURIComponent(trackArtist)}`;
        const res = await fetch(url, { headers: { 'User-Agent': 'TuneCloud/1.0 (https://github.com/skippingclass/TuneCloud)' } });
        if (res.ok) {
          const data = await res.json();
          if (data.syncedLyrics) {
            return { synced: true, lyrics: data.syncedLyrics, source: 'lrclib' };
          }
          if (data.plainLyrics) {
            return { synced: false, lyrics: data.plainLyrics, source: 'lrclib' };
          }
        }
      } catch {}
    }

    return reply.status(404).send({ error: 'Lyrics not found' });
  });
}
