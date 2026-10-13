import { query } from '../db.js';
import { requireAuth } from '../auth.js';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import {
  cleanTrackTitle,
  readLocalLyrics,
  readEmbeddedLyrics,
  fetchLrclibLyrics,
} from '../lyrics.js';

export default async function trackRoutes(fastify) {
  fastify.get('/api/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = 50, offset = 0, sort = 'title', order = 'asc', artist_id, artist, album_id } = req.query;

    const isFiltered = artist_id || artist || album_id;
    const maxLimit = isFiltered ? 10000 : 200;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), maxLimit);
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

    const conditions = [];
    const params = [];

    if (artist_id) {
      params.push(parseInt(artist_id, 10));
      conditions.push(`t.artist_id = $${params.length}`);
    } else if (artist) {
      params.push(artist);
      conditions.push(`a.name ILIKE $${params.length}`);
    }

    if (album_id) {
      params.push(parseInt(album_id, 10));
      conditions.push(`t.album_id = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;
    params.push(safeLimit, safeOffset);

    const { rows } = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              a.name as artist, a.id as artist_id, al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       ${whereClause}`,
      params.slice(0, conditions.length)
    );
    const total = parseInt(countResult.rows[0].count, 10);

    return { tracks: rows, total };
  });

  fastify.get('/api/tracks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT t.*, a.name as artist, a.id as artist_id, al.title as album,
              COALESCE(t.cover_path, al.cover_path) as cover_path
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
      `SELECT al.*, a.name as artist, a.id as artist_id,
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
      `SELECT t.*, a.name as artist, a.id as artist_id, al.title as album,
              COALESCE(t.cover_path, al.cover_path) as cover_path
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

  fastify.get('/api/artists/by-name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.query;
    if (!name || typeof name !== 'string') {
      return reply.status(400).send({ error: 'Artist name required' });
    }

    const trimmed = name.trim();
    let artistRes = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
       FROM artists a
       WHERE a.name ILIKE $1
       LIMIT 1`,
      [trimmed]
    );

    let artist = artistRes.rows[0];

    if (!artist) {
      const fallbackRes = await query(
        `SELECT a.*,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
                (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
         FROM tracks t
         JOIN artists a ON t.artist_id = a.id
         WHERE a.name ILIKE $1 OR t.track_artist_credit ILIKE $1
         LIMIT 1`,
        [`%${trimmed}%`]
      );
      artist = fallbackRes.rows[0];
    }

    if (!artist) {
      return reply.status(404).send({ error: 'Artist not found' });
    }

    const [albumsRes, tracksRes] = await Promise.all([
      query(
        `SELECT al.*, a.name as artist, a.id as artist_id,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
                (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration
         FROM albums al
         LEFT JOIN artists a ON al.artist_id = a.id
         WHERE al.artist_id = $1
         ORDER BY al.year DESC NULLS LAST, al.title ASC`,
        [artist.id]
      ),
      query(
        `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
                t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
                a.name as artist, a.id as artist_id,
                al.title as album, al.id as album_id,
                COALESCE(t.cover_path, al.cover_path) as cover_path
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE t.artist_id = $1
         ORDER BY al.year DESC NULLS LAST, al.title ASC, t.disc_number ASC, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
        [artist.id]
      ),
    ]);

    return {
      artist,
      albums: albumsRes.rows,
      tracks: tracksRes.rows,
    };
  });

  fastify.get('/api/artists/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const artistId = parseInt(id, 10);
    if (isNaN(artistId)) {
      return reply.status(400).send({ error: 'Invalid artist ID' });
    }

    const artistRes = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
       FROM artists a
       WHERE a.id = $1`,
      [artistId]
    );

    const artist = artistRes.rows[0];
    if (!artist) {
      return reply.status(404).send({ error: 'Artist not found' });
    }

    const [albumsRes, tracksRes] = await Promise.all([
      query(
        `SELECT al.*, a.name as artist, a.id as artist_id,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
                (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration
         FROM albums al
         LEFT JOIN artists a ON al.artist_id = a.id
         WHERE al.artist_id = $1
         ORDER BY al.year DESC NULLS LAST, al.title ASC`,
        [artistId]
      ),
      query(
        `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
                t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
                a.name as artist, a.id as artist_id,
                al.title as album, al.id as album_id,
                COALESCE(t.cover_path, al.cover_path) as cover_path
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE t.artist_id = $1
         ORDER BY al.year DESC NULLS LAST, al.title ASC, t.disc_number ASC, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
        [artistId]
      ),
    ]);

    return {
      artist,
      albums: albumsRes.rows,
      tracks: tracksRes.rows,
    };
  });

  fastify.get('/api/search', { preHandler: requireAuth }, async (req, reply) => {
    const { q, limit = 30 } = req.query;
    const cleanQ = String(q || '').trim().slice(0, 100);
    if (!cleanQ) return { tracks: [], albums: [], artists: [] };

    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 30), 100);
    const searchTerm = `%${cleanQ}%`;

    const tracks = await query(
      `SELECT t.id, t.title, t.file_name, t.duration, t.track_number, t.format,
              a.name as artist, a.id as artist_id, al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.title ILIKE $1 OR a.name ILIKE $1 OR al.title ILIKE $1
       LIMIT $2`,
      [searchTerm, safeLimit]
    );

    const albums = await query(
      `SELECT al.*, a.name as artist, al.artist_id
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
              a.name as artist, a.id as artist_id, al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path,
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
      `SELECT al.*, a.name as artist, al.artist_id,
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

  // ---- Lyrics (Cache in DB -> Local .lrc -> Embedded tags -> LRCLIB multi-tier fallback) ----
  fastify.get('/api/lyrics', { preHandler: requireAuth }, async (req, reply) => {
    const { id, title, artist, duration } = req.query;
    let trackId = id ? parseInt(id, 10) : null;
    if (isNaN(trackId)) trackId = null;

    let trackPath = null;
    let trackTitle = typeof title === 'string' ? title.slice(0, 200) : null;
    let trackArtist = typeof artist === 'string' ? artist.slice(0, 200) : null;
    let trackDuration = duration ? parseFloat(duration) : null;
    let trackAlbum = null;

    // 1. If trackId provided, check DB cache
    let cachedPlain = null;
    if (trackId) {
      try {
        const cached = await query(
          'SELECT synced, type, lyrics, source FROM track_lyrics WHERE track_id = $1',
          [trackId]
        );
        if (cached.rows[0]) {
          if (cached.rows[0].synced) {
            return cached.rows[0];
          }
          cachedPlain = cached.rows[0];
        }
      } catch {}

      // Get track metadata from DB
      const { rows } = await query(
        `SELECT t.file_path, t.title, t.file_name, t.duration,
                a.name as artist, al.title as album
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE t.id = $1`,
        [trackId]
      );
      if (rows[0]) {
        trackPath = rows[0].file_path;
        trackTitle = trackTitle || rows[0].title || rows[0].file_name;
        trackArtist = trackArtist || rows[0].artist;
        trackDuration = trackDuration || rows[0].duration;
        trackAlbum = rows[0].album;
      }
    }

    const cleanTitle = cleanTrackTitle(trackTitle);

    // 2. Try local .lrc or .txt file next to trackPath
    let localResult = null;
    if (trackPath) {
      localResult = readLocalLyrics(trackPath, cleanTitle);
      if (localResult && localResult.synced) {
        if (trackId) {
          saveLyricsToDb(trackId, localResult).catch(() => {});
        }
        return localResult;
      }
    }

    // 3. Try embedded tags inside audio file
    let embeddedResult = null;
    if (trackPath) {
      embeddedResult = await readEmbeddedLyrics(trackPath);
      if (embeddedResult && embeddedResult.synced) {
        if (trackId) {
          saveLyricsToDb(trackId, embeddedResult).catch(() => {});
        }
        return embeddedResult;
      }
    }

    // 4. Try LRCLIB: if LRCLIB has synced lyrics, it takes precedence over plain embedded/local
    let lrclibResult = null;
    if (trackTitle) {
      lrclibResult = await fetchLrclibLyrics({
        title: trackTitle,
        artist: trackArtist,
        album: trackAlbum,
        duration: trackDuration,
      });

      if (lrclibResult && lrclibResult.synced) {
        if (trackId) {
          saveLyricsToDb(trackId, lrclibResult).catch(() => {});
        }
        return lrclibResult;
      }
    }

    // 5. Fall back to plain lyrics: prefer embedded tags, then local files, then LRCLIB plain, then cached plain
    const bestPlain = embeddedResult || localResult || lrclibResult || cachedPlain;
    if (bestPlain) {
      if (trackId) {
        saveLyricsToDb(trackId, bestPlain).catch(() => {});
      }
      return bestPlain;
    }

    return reply.status(404).send({ error: 'Lyrics not found' });
  });

  async function saveLyricsToDb(trackId, result) {
    try {
      await query(
        `INSERT INTO track_lyrics (track_id, synced, type, lyrics, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (track_id) DO UPDATE SET
           synced = EXCLUDED.synced,
           type = EXCLUDED.type,
           lyrics = EXCLUDED.lyrics,
           source = EXCLUDED.source,
           updated_at = NOW()`,
        [trackId, !!result.synced, result.type || 'plain', result.lyrics, result.source || 'lrclib']
      );
    } catch {}
  }
}
