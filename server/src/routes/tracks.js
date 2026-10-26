import { query, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import fs from 'fs';
import path from 'path';
import {
  cleanTrackTitle,
  readLocalLyrics,
  readEmbeddedLyrics,
  fetchLrclibLyrics,
} from '../lyrics.js';

export default async function trackRoutes(fastify) {
  fastify.get('/api/tracks', { preHandler: requireAuth }, async (req, reply) => {
    const { limit = 50, offset = 0, sort = 'title', order = 'asc', artist_id, artist, album_id, genre, q } = req.query;

    const maxLimit = 200;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), maxLimit);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);
    const userId = req.user?.id || 0;

    const dir = order === 'desc' ? 'DESC' : 'ASC';
    const sortMap = {
      title: `t.title ${dir}`,
      artist: `a.name ${dir}, al.title, t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      album: `al.title ${dir}, t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      duration: `t.duration ${dir}`,
      created_at: `t.created_at ${dir}`,
      track_number: `t.disc_number, COALESCE(t.track_number, 999) ${dir}, t.file_name`,
      play_count: `COALESCE(uph.user_play_count, 0) ${dir}, COALESCE(t.play_count, 0) ${dir}, t.title ASC`,
      last_played_at: `uph.user_last_played_at ${dir} NULLS LAST, t.last_played_at ${dir} NULLS LAST`,
      global_play_count: `COALESCE(t.play_count, 0) ${dir}, t.title ASC`,
      random: `RANDOM()`,
    };
    const orderClause = `${sortMap[sort] || 't.title ASC'}, t.id ASC`;

    const conditions = [];
    if (typeof q === 'string' && q.trim()) {
      if (q.length > 500) return reply.status(400).send({ error: 'Search query too long' });
    }
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

    if (genre) {
      params.push(`%${genre}%`);
      conditions.push(`t.genre ILIKE $${params.length}`);
    }

    if (typeof q === 'string' && q.trim()) {
      params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
      const n = params.length;
      conditions.push(`(t.title ILIKE $${n} OR COALESCE(t.track_artist_credit, a.name) ILIKE $${n} OR al.title ILIKE $${n})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitParamIndex = params.length + 1;
    const offsetParamIndex = params.length + 2;
    const userParamIndex = params.length + 3;
    params.push(safeLimit, safeOffset, userId);

    const { rows } = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              (t.missing_since IS NULL) AS available,
              COALESCE(uph.user_play_count, 0)::int as play_count,
              uph.user_last_played_at as last_played_at,
              COALESCE(t.play_count, 0)::int as global_play_count,
              t.last_played_at as global_last_played_at,
              COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id,
              al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN (
         SELECT track_id, COUNT(*)::int as user_play_count, MAX(played_at) as user_last_played_at
         FROM play_history WHERE user_id = $${userParamIndex} GROUP BY track_id
       ) uph ON uph.track_id = t.id
       ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       ${whereClause}`,
      params.slice(0, -3)
    );
    const total = parseInt(countResult.rows[0].count, 10);

    return { tracks: rows, total };
  });

  fastify.get('/api/tracks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const userId = req.user?.id || 0;
    const { rows } = await query(
      `SELECT t.*,
              (t.missing_since IS NULL) AS available,
              COALESCE(uph.user_play_count, 0)::int as play_count,
              uph.user_last_played_at as last_played_at,
              COALESCE(t.play_count, 0)::int as global_play_count,
              t.last_played_at as global_last_played_at,
              COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id, al.title as album,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN (
         SELECT track_id, COUNT(*)::int as user_play_count, MAX(played_at) as user_last_played_at
         FROM play_history WHERE user_id = $2 GROUP BY track_id
       ) uph ON uph.track_id = t.id
       WHERE t.id = $1`,
      [id, userId]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    return rows[0];
  });

  fastify.get('/api/albums', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user?.id || 0;
    const { limit, offset, sort, order, q, genre, year, all } = req.query;
    const isAll = all === 'true' || all === '1';
    const safeLimit = isAll ? 5000 : Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const safeOffset = isAll ? 0 : Math.max(0, parseInt(offset, 10) || 0);

    const conditions = [];
    const params = [];

    if (typeof q === 'string' && q.trim()) {
      params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
      const n = params.length;
      conditions.push(`(al.title ILIKE $${n} OR a.name ILIKE $${n})`);
    }

    if (typeof genre === 'string' && genre.trim() && genre !== 'all') {
      params.push(`%${genre.trim().replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`al.genre ILIKE $${params.length}`);
    }

    if (year && year !== 'all') {
      const yVal = parseInt(year, 10);
      if (!isNaN(yVal)) {
        params.push(yVal);
        conditions.push(`al.year = $${params.length}`);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    let sortClause = 'al.title ASC, al.id ASC';
    const sortDir = (order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    if (sort === 'title_asc' || (sort === 'title' && sortDir === 'ASC')) {
      sortClause = 'al.title ASC, al.id ASC';
    } else if (sort === 'title_desc' || (sort === 'title' && sortDir === 'DESC')) {
      sortClause = 'al.title DESC, al.id ASC';
    } else if (sort === 'year_desc' || (sort === 'year' && sortDir === 'DESC')) {
      sortClause = 'al.year DESC NULLS LAST, al.title ASC, al.id ASC';
    } else if (sort === 'year_asc' || (sort === 'year' && sortDir === 'ASC')) {
      sortClause = 'al.year ASC NULLS LAST, al.title ASC, al.id ASC';
    } else if (sort === 'duration') {
      sortClause = `ts.duration ${sortDir} NULLS LAST, al.id ASC`;
    } else if (sort === 'play_count') {
      sortClause = `ups.play_count ${sortDir} NULLS LAST, ts.global_play_count ${sortDir} NULLS LAST, al.id ASC`;
    } else if (sort === 'recent') {
      sortClause = 'ups.last_played_at DESC NULLS LAST, ts.global_last_played_at DESC NULLS LAST, al.id DESC';
    }

    const userParamIndex = params.length + 1;
    const limitParamIndex = params.length + 2;
    const offsetParamIndex = params.length + 3;
    params.push(userId, safeLimit, safeOffset);

    const { rows } = await query(
      `SELECT al.*, a.name as artist, a.id as artist_id,
              COALESCE(ts.track_count, 0)::int as track_count,
              COALESCE(ts.duration, 0)::real as duration,
              ups.last_played_at,
              COALESCE(ups.play_count, 0)::int as play_count,
              ts.global_last_played_at,
              COALESCE(ts.global_play_count, 0)::int as global_play_count
       FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       LEFT JOIN (
         SELECT album_id,
                COUNT(*) as track_count,
                SUM(duration) as duration,
                MAX(last_played_at) as global_last_played_at,
                SUM(play_count) as global_play_count
         FROM tracks
         WHERE album_id IS NOT NULL
         GROUP BY album_id
       ) ts ON ts.album_id = al.id
       LEFT JOIN (
         SELECT t.album_id,
                COUNT(ph.id)::int as play_count,
                MAX(ph.played_at) as last_played_at
         FROM play_history ph
         JOIN tracks t ON ph.track_id = t.id
         WHERE ph.user_id = $${userParamIndex} AND t.album_id IS NOT NULL
         GROUP BY t.album_id
       ) ups ON ups.album_id = al.id
       ${whereClause}
       ORDER BY ${sortClause}
       LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
      params
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       ${whereClause}`,
      params.slice(0, -3)
    );
    const total = parseInt(countResult.rows[0].count, 10);

    return { albums: rows, total };
  });

  fastify.get('/api/albums/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query(
      `SELECT t.*,
              (t.missing_since IS NULL) AS available,
              COALESCE(t.track_artist_credit, a.name) as artist,
              a.name as primary_artist,
              a.id as artist_id,
              al.title as album,
              al.artist_id as album_artist_id,
              al_a.name as album_artist,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN artists al_a ON al.artist_id = al_a.id
       WHERE t.album_id = $1
       ORDER BY t.disc_number, COALESCE(t.track_number, 999), t.file_name`,
      [id]
    );
    return rows;
  });

  fastify.get('/api/artists', { preHandler: requireAuth }, async (req, reply) => {
    const { limit, offset, sort, order, q, all } = req.query;
    const isAll = all === 'true' || all === '1';
    const safeLimit = isAll ? 5000 : Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const safeOffset = isAll ? 0 : Math.max(0, parseInt(offset, 10) || 0);

    const conditions = ["a.name NOT LIKE '%,%'"];
    const params = [];

    if (typeof q === 'string' && q.trim()) {
      params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`a.name ILIKE $${params.length}`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sortDir = (order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    let sortCol = 'a.name';
    if (sort === 'track_count') sortCol = 'track_count';
    else if (sort === 'album_count') sortCol = 'album_count';

    params.push(safeLimit, safeOffset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const { rows } = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
              (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count
       FROM artists a
       ${whereClause}
       ORDER BY ${sortCol} ${sortDir}, a.id ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countRes = await query(
      `SELECT COUNT(*) FROM artists a ${whereClause}`,
      params.slice(0, -2)
    );
    const total = parseInt(countRes.rows[0].count, 10);

    return { artists: rows, total };
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

    const tracksRes = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              (t.missing_since IS NULL) AS available,
              COALESCE(t.play_count, 0) as play_count, t.last_played_at,
              COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id,
              al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE (a.name ILIKE $1) OR (t.track_artist_credit ILIKE $2)
       ORDER BY al.year DESC NULLS LAST, al.title ASC, t.disc_number ASC, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [trimmed, `%${trimmed}%`]
    );

    if (!artist && tracksRes.rows.length === 0) {
      return reply.status(404).send({ error: 'Artist not found' });
    }

    if (!artist) {
      const ins = await query(
        `INSERT INTO artists (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id, name`,
        [trimmed]
      );
      artist = {
        id: ins.rows[0].id,
        name: ins.rows[0].name,
        track_count: tracksRes.rows.length,
        album_count: new Set(tracksRes.rows.map((r) => r.album_id).filter(Boolean)).size,
      };
    }

    const trackAlbumIds = [...new Set(tracksRes.rows.map((r) => r.album_id).filter(Boolean))];
    const albumsRes = await query(
      `SELECT al.*, a.name as artist, a.id as artist_id,
              (al.artist_id = $1) as is_primary_album,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
              (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration
       FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       WHERE al.artist_id = $1 OR al.id = ANY($2::int[])
       ORDER BY (al.artist_id = $1) DESC, al.year DESC NULLS LAST, al.title ASC`,
      [artist.id, trackAlbumIds.length > 0 ? trackAlbumIds : [-1]]
    );

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

    const tracksRes = await query(
      `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
              t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format, t.file_size,
              (t.missing_since IS NULL) AS available,
              COALESCE(t.play_count, 0) as play_count, t.last_played_at,
              COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id,
              al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.artist_id = $1 OR t.track_artist_credit ILIKE $2
       ORDER BY al.year DESC NULLS LAST, al.title ASC, t.disc_number ASC, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [artistId, `%${artist.name}%`]
    );

    const trackAlbumIds = [...new Set(tracksRes.rows.map((r) => r.album_id).filter(Boolean))];
    const albumsRes = await query(
      `SELECT al.*, a.name as artist, a.id as artist_id,
              (al.artist_id = $1) as is_primary_album,
              (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
              (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration
       FROM albums al
       LEFT JOIN artists a ON al.artist_id = a.id
       WHERE al.artist_id = $1 OR al.id = ANY($2::int[])
       ORDER BY (al.artist_id = $1) DESC, al.year DESC NULLS LAST, al.title ASC`,
      [artistId, trackAlbumIds.length > 0 ? trackAlbumIds : [-1]]
    );

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
              (t.missing_since IS NULL) AS available,
              COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id, al.title as album, al.id as album_id,
              COALESCE(t.cover_path, al.cover_path) as cover_path
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN albums al ON t.album_id = al.id
       WHERE t.title ILIKE $1 OR a.name ILIKE $1 OR t.track_artist_credit ILIKE $1 OR al.title ILIKE $1
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

  // ---- Favorites IDs (Fast lookup for starred indicators) ----
  fastify.get('/api/favorites/ids', { preHandler: requireAuth }, async (req) => {
    const userId = req.user.id;
    const [tracks, albums, artists] = await Promise.all([
      query('SELECT track_id FROM user_starred_tracks WHERE user_id = $1 ORDER BY track_id ASC', [userId]),
      query('SELECT album_id FROM user_starred_albums WHERE user_id = $1 ORDER BY album_id ASC', [userId]),
      query('SELECT artist_id FROM user_starred_artists WHERE user_id = $1 ORDER BY artist_id ASC', [userId]),
    ]);
    return {
      track_ids: tracks.rows.map((r) => r.track_id),
      album_ids: albums.rows.map((r) => r.album_id),
      artist_ids: artists.rows.map((r) => r.artist_id),
    };
  });

  // ---- Favorites ----
  fastify.get('/api/favorites', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user.id;
    const { type = 'all', limit, offset, sort, order, q, all, ids_only } = req.query;

    if (ids_only === 'true' || ids_only === '1') {
      const [trIds, alIds, arIds] = await Promise.all([
        query('SELECT track_id FROM user_starred_tracks WHERE user_id = $1', [userId]),
        query('SELECT album_id FROM user_starred_albums WHERE user_id = $1', [userId]),
        query('SELECT artist_id FROM user_starred_artists WHERE user_id = $1', [userId]),
      ]);
      return {
        track_ids: trIds.rows.map((r) => r.track_id),
        album_ids: alIds.rows.map((r) => r.album_id),
        artist_ids: arIds.rows.map((r) => r.artist_id),
      };
    }

    const isAll = all === 'true' || all === '1';
    const safeLimit = isAll ? 10000 : Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const safeOffset = isAll ? 0 : Math.max(0, parseInt(offset, 10) || 0);
    const sortDir = (order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    // Tracks only
    if (type === 'tracks') {
      const conditions = ['st.user_id = $1'];
      const params = [userId];
      if (typeof q === 'string' && q.trim()) {
        params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
        const n = params.length;
        conditions.push(`(t.title ILIKE $${n} OR COALESCE(t.track_artist_credit, a.name) ILIKE $${n} OR al.title ILIKE $${n})`);
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const sortCol = sort === 'title' ? `t.title ${sortDir}, t.id ASC` : `st.created_at ${sortDir}, t.id ASC`;

      params.push(safeLimit, safeOffset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;

      const { rows } = await query(
        `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
                t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format,
                (t.missing_since IS NULL) AS available,
                COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id,
                al.title as album, al.id as album_id,
                COALESCE(t.cover_path, al.cover_path) as cover_path,
                true as is_favorite
         FROM user_starred_tracks st
         JOIN tracks t ON st.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         ${whereClause}
         ORDER BY ${sortCol}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );

      const countRes = await query(
        `SELECT COUNT(*) FROM user_starred_tracks st
         JOIN tracks t ON st.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         ${whereClause}`,
        params.slice(0, -2)
      );
      const total = parseInt(countRes.rows[0].count, 10);
      return { tracks: rows, total, limit: safeLimit, offset: safeOffset };
    }

    // Albums only
    if (type === 'albums') {
      const conditions = ['sa.user_id = $1'];
      const params = [userId];
      if (typeof q === 'string' && q.trim()) {
        params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
        const n = params.length;
        conditions.push(`(al.title ILIKE $${n} OR a.name ILIKE $${n})`);
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const sortCol = sort === 'title' ? `al.title ${sortDir}, al.id ASC` : `sa.created_at ${sortDir}, al.id ASC`;

      params.push(safeLimit, safeOffset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;

      const { rows } = await query(
        `SELECT al.*, a.name as artist, al.artist_id,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
                (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration,
                true as is_favorite
         FROM user_starred_albums sa
         JOIN albums al ON sa.album_id = al.id
         LEFT JOIN artists a ON al.artist_id = a.id
         ${whereClause}
         ORDER BY ${sortCol}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );

      const countRes = await query(
        `SELECT COUNT(*) FROM user_starred_albums sa
         JOIN albums al ON sa.album_id = al.id
         LEFT JOIN artists a ON al.artist_id = a.id
         ${whereClause}`,
        params.slice(0, -2)
      );
      const total = parseInt(countRes.rows[0].count, 10);
      return { albums: rows, total, limit: safeLimit, offset: safeOffset };
    }

    // Artists only
    if (type === 'artists') {
      const conditions = ['sa.user_id = $1'];
      const params = [userId];
      if (typeof q === 'string' && q.trim()) {
        params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`);
        conditions.push(`a.name ILIKE $${params.length}`);
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const sortCol = sort === 'name' ? `a.name ${sortDir}, a.id ASC` : `sa.created_at ${sortDir}, a.id ASC`;

      params.push(safeLimit, safeOffset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;

      const { rows } = await query(
        `SELECT a.*,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
                (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count,
                true as is_favorite
         FROM user_starred_artists sa
         JOIN artists a ON sa.artist_id = a.id
         ${whereClause}
         ORDER BY ${sortCol}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );

      const countRes = await query(
        `SELECT COUNT(*) FROM user_starred_artists sa
         JOIN artists a ON sa.artist_id = a.id
         ${whereClause}`,
        params.slice(0, -2)
      );
      const total = parseInt(countRes.rows[0].count, 10);
      return { artists: rows, total, limit: safeLimit, offset: safeOffset };
    }

    // type === 'all' (default)
    const [tracksCountRes, albumsCountRes, artistsCountRes] = await Promise.all([
      query('SELECT COUNT(*) FROM user_starred_tracks WHERE user_id = $1', [userId]),
      query('SELECT COUNT(*) FROM user_starred_albums WHERE user_id = $1', [userId]),
      query('SELECT COUNT(*) FROM user_starred_artists WHERE user_id = $1', [userId]),
    ]);
    const totalTracks = parseInt(tracksCountRes.rows[0].count, 10);
    const totalAlbums = parseInt(albumsCountRes.rows[0].count, 10);
    const totalArtists = parseInt(artistsCountRes.rows[0].count, 10);

    const tracksLimitClause = isAll ? '' : `LIMIT ${safeLimit} OFFSET ${safeOffset}`;
    const albumsLimitClause = isAll ? '' : `LIMIT ${safeLimit} OFFSET ${safeOffset}`;
    const artistsLimitClause = isAll ? '' : `LIMIT ${safeLimit} OFFSET ${safeOffset}`;

    const [tracksRes, albumsRes, artistsRes] = await Promise.all([
      query(
        `SELECT t.id, t.file_name, t.file_path, t.duration, t.title, t.track_number,
                t.disc_number, t.genre, t.year, t.bitrate, t.sample_rate, t.format,
                (t.missing_since IS NULL) AS available,
                COALESCE(t.track_artist_credit, a.name) as artist, a.name as primary_artist, a.id as artist_id,
                al.title as album, al.id as album_id,
                COALESCE(t.cover_path, al.cover_path) as cover_path,
                true as is_favorite
         FROM user_starred_tracks st
         JOIN tracks t ON st.track_id = t.id
         LEFT JOIN artists a ON t.artist_id = a.id
         LEFT JOIN albums al ON t.album_id = al.id
         WHERE st.user_id = $1
         ORDER BY st.created_at DESC, t.id ASC
         ${tracksLimitClause}`,
        [userId]
      ),
      query(
        `SELECT al.*, a.name as artist, al.artist_id,
                (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) as track_count,
                (SELECT SUM(t.duration) FROM tracks t WHERE t.album_id = al.id) as duration,
                true as is_favorite
         FROM user_starred_albums sa
         JOIN albums al ON sa.album_id = al.id
         LEFT JOIN artists a ON al.artist_id = a.id
         WHERE sa.user_id = $1
         ORDER BY sa.created_at DESC, al.id ASC
         ${albumsLimitClause}`,
        [userId]
      ),
      query(
        `SELECT a.*,
                (SELECT COUNT(*) FROM tracks t WHERE t.artist_id = a.id) as track_count,
                (SELECT COUNT(*) FROM albums al WHERE al.artist_id = a.id) as album_count,
                true as is_favorite
         FROM user_starred_artists sa
         JOIN artists a ON sa.artist_id = a.id
         WHERE sa.user_id = $1
         ORDER BY sa.created_at DESC, a.id ASC
         ${artistsLimitClause}`,
        [userId]
      ),
    ]);

    return {
      tracks: tracksRes.rows,
      albums: albumsRes.rows,
      artists: artistsRes.rows,
      total_tracks: totalTracks,
      total_albums: totalAlbums,
      total_artists: totalArtists,
      limit: safeLimit,
      offset: safeOffset,
    };
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

  fastify.post('/api/favorites/artist/:id', { preHandler: requireAuth }, async (req) => {
    const userId = req.user.id;
    const artistId = parseInt(req.params.id, 10);
    const { rows } = await query(
      'SELECT 1 FROM user_starred_artists WHERE user_id = $1 AND artist_id = $2',
      [userId, artistId]
    );
    let starred = false;
    if (rows.length > 0) {
      await query('DELETE FROM user_starred_artists WHERE user_id = $1 AND artist_id = $2', [userId, artistId]);
    } else {
      await query(
        'INSERT INTO user_starred_artists (user_id, artist_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, artistId]
      );
      starred = true;
    }
    return { starred, artistId };
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
  fastify.post('/api/scrobble/:id', { preHandler: requireAuth }, async (req, reply) => {
    const trackId = parseInt(req.params.id, 10);
    if (!Number.isFinite(trackId) || trackId <= 0) {
      return reply.status(400).send({ error: 'Invalid track ID' });
    }
    const userId = req.user?.id || null;

    try {
      await transaction(async (client) => {
        const updateRes = await client.query(
          'UPDATE tracks SET play_count = play_count + 1, last_played_at = NOW() WHERE id = $1 RETURNING id',
          [trackId]
        );
        if (updateRes.rowCount === 0) {
          const err = new Error('Track not found');
          err.statusCode = 404;
          throw err;
        }
        if (userId) {
          await client.query(
            'INSERT INTO play_history (user_id, track_id, played_at) VALUES ($1, $2, NOW())',
            [userId, trackId]
          );
        }
      });
      return { success: true };
    } catch (err) {
      if (err.statusCode === 404) {
        return reply.status(404).send({ error: 'Track not found' });
      }
      throw err;
    }
  });

  // ---- Lyrics (Cache in DB -> Local .lrc -> Embedded tags -> LRCLIB multi-tier fallback) ----
  fastify.get('/api/lyrics', { preHandler: requireAuth }, async (req, reply) => {
    const { id, title, artist, duration } = req.query || {};
    let trackId = id ? parseInt(id, 10) : null;
    if (isNaN(trackId) || trackId <= 0) trackId = null;

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
      if (!rows[0]) {
        return reply.status(404).send({ error: 'Track not found' });
      }

      // Strictly use DB metadata when id is provided
      trackPath = rows[0].file_path;
      trackTitle = rows[0].title || rows[0].file_name;
      trackArtist = rows[0].artist || null;
      trackDuration = rows[0].duration || null;
      trackAlbum = rows[0].album || null;
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
