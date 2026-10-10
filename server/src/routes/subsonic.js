import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { authenticate } from '../subsonic/auth.js';
import { sendOk, sendError, ErrorCode } from '../subsonic/response.js';
import {
  formatArtist,
  formatAlbum,
  formatSong,
  formatPlaylist,
  buildIndexes,
  songSelectSql,
  albumSelectSql,
  artistSelectSql,
  IGNORED_ARTICLES_STR,
} from '../subsonic/formatters.js';
import { sendAudioFile } from '../streaming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.resolve(__dirname, '../../covers');

const MUSIC_FOLDER_ID = 1;

function parseId(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

function parseIdList(v) {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) {
    return v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  }
  return String(v)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function missing(reply, req, name) {
  return sendError(reply, req, ErrorCode.MISSING_PARAM, `Required parameter is missing: ${name}`);
}

function notFound(reply, req, what) {
  return sendError(reply, req, ErrorCode.NOT_FOUND, `${what} not found`);
}

function requireId(reply, req, params, what) {
  const id = parseId(params.id);
  if (id === null) {
    missing(reply, req, 'id');
    return null;
  }
  if (Number.isNaN(id)) {
    notFound(reply, req, what);
    return null;
  }
  return id;
}

const ALBUM_GROUP = `GROUP BY al.id, al.title, al.year, al.genre, al.cover_path, al.created_at, a.id, a.name`;

const GENRES_SQL = `
  SELECT
    g.genre AS value,
    COALESCE(t.song_count, 0)::int AS "songCount",
    COALESCE(al.album_count, 0)::int AS "albumCount"
  FROM (
    SELECT DISTINCT genre FROM (
      SELECT genre FROM tracks WHERE genre IS NOT NULL AND TRIM(genre) != ''
      UNION
      SELECT genre FROM albums WHERE genre IS NOT NULL AND TRIM(genre) != ''
    ) s
  ) g
  LEFT JOIN (
    SELECT genre, COUNT(*)::int AS song_count
    FROM tracks
    WHERE genre IS NOT NULL AND TRIM(genre) != ''
    GROUP BY genre
  ) t ON t.genre = g.genre
  LEFT JOIN (
    SELECT genre, COUNT(DISTINCT id)::int AS album_count
    FROM (
      SELECT genre, id FROM albums WHERE genre IS NOT NULL AND TRIM(genre) != ''
      UNION
      SELECT t.genre, t.album_id AS id FROM tracks t WHERE t.genre IS NOT NULL AND TRIM(t.genre) != '' AND t.album_id IS NOT NULL
    ) a_union
    GROUP BY genre
  ) al ON al.genre = g.genre
  ORDER BY g.genre ASC`;

function coverFileFromPath(coverPath) {
  if (!coverPath) return null;
  const file = path.join(COVERS_DIR, path.basename(coverPath));
  return fs.existsSync(file) ? file : null;
}

async function resolveCoverPath(rawId) {
  const id = String(rawId);
  let m;
  if ((m = id.match(/^al-(\d+)$/))) {
    const { rows } = await query('SELECT cover_path FROM albums WHERE id = $1', [m[1]]);
    return rows[0]?.cover_path || null;
  }
  if ((m = id.match(/^tr-(\d+)$/))) {
    const { rows } = await query(
      'SELECT COALESCE(t.cover_path, al.cover_path) AS cover_path FROM tracks t LEFT JOIN albums al ON t.album_id = al.id WHERE t.id = $1',
      [m[1]]
    );
    return rows[0]?.cover_path || null;
  }
  if ((m = id.match(/^ar-(\d+)$/))) {
    const { rows } = await query(
      'SELECT cover_path FROM albums WHERE artist_id = $1 AND cover_path IS NOT NULL ORDER BY id LIMIT 1',
      [m[1]]
    );
    return rows[0]?.cover_path || null;
  }
  if (/^\d+$/.test(id)) {
    const al = await query('SELECT cover_path FROM albums WHERE id = $1', [id]);
    if (al.rows[0]?.cover_path) return al.rows[0].cover_path;
    const tr = await query(
      'SELECT COALESCE(t.cover_path, al.cover_path) AS cover_path FROM tracks t LEFT JOIN albums al ON t.album_id = al.id WHERE t.id = $1',
      [id]
    );
    return tr.rows[0]?.cover_path || null;
  }
  return null;
}

export default async function subsonicRoutes(fastify) {
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body)))
    );
  }

  function endpoint(name, handler) {
    const run = async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const params = { ...body, ...req.query };
      try {
        const auth = await authenticate(params);
        if (auth.error) return sendError(reply, req, auth.error.code, auth.error.message);
        req.subsonicUser = auth.user;
        return await handler(req, reply, params);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) return sendError(reply, req, ErrorCode.GENERIC, 'Internal server error');
      }
    };
    for (const url of [`/rest/${name}`, `/rest/${name}.view`]) {
      fastify.route({ method: ['GET', 'POST'], url, handler: run });
    }
  }

  // ---- System ----

  endpoint('ping', async (req, reply) => sendOk(reply, req));

  endpoint('getLicense', async (req, reply) =>
    sendOk(reply, req, {
      license: { valid: true, email: 'admin@tunecloud', licenseExpires: '2099-01-01T00:00:00.000Z' },
    })
  );

  endpoint('getOpenSubsonicExtensions', async (req, reply) =>
    sendOk(reply, req, {
      openSubsonicExtensions: [
        { name: 'formPost', versions: [1] },
        { name: 'songLyrics', versions: [1] },
        { name: 'transcodeOffset', versions: [1] },
        { name: 'playQueue', versions: [1] },
      ],
    })
  );

  // ---- User management ----

  endpoint('getUser', async (req, reply, params) => {
    const me = req.subsonicUser;
    const username = params.username || me.username;

    if (username !== me.username && !me.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User is not authorized for the given operation.');
    }

    const { rows } = await query('SELECT username, is_admin FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user) return notFound(reply, req, 'User');

    return sendOk(reply, req, {
      user: {
        username: user.username,
        email: `${user.username}@tunecloud.local`,
        scrobblingEnabled: true,
        adminRole: !!user.is_admin,
        settingsRole: true,
        downloadRole: true,
        uploadRole: true,
        playlistRole: true,
        coverArtRole: true,
        commentRole: true,
        podcastRole: true,
        streamRole: true,
        jukeboxRole: true,
        shareRole: true,
        folder: [MUSIC_FOLDER_ID],
      },
    });
  });

  // ---- Browsing ----

  endpoint('getMusicFolders', async (req, reply) =>
    sendOk(reply, req, { musicFolders: { musicFolder: [{ id: MUSIC_FOLDER_ID, name: 'Music Library' }] } })
  );

  endpoint('getIndexes', async (req, reply) => {
    const { rows } = await query(artistSelectSql(req.subsonicUser.id));
    return sendOk(reply, req, {
      indexes: {
        lastModified: Date.now(),
        ignoredArticles: IGNORED_ARTICLES_STR,
        index: buildIndexes(rows),
      },
    });
  });

  endpoint('getArtists', async (req, reply) => {
    const { rows } = await query(artistSelectSql(req.subsonicUser.id));
    return sendOk(reply, req, {
      artists: { ignoredArticles: IGNORED_ARTICLES_STR, index: buildIndexes(rows) },
    });
  });

  endpoint('getArtist', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Artist');
    if (id === null) return;

    const artistRes = await query(
      `SELECT a.id, a.name, sar.created_at AS starred_at, ur.rating AS user_rating
       FROM artists a
       LEFT JOIN user_starred_artists sar ON sar.artist_id = a.id AND sar.user_id = $2
       LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $2
       WHERE a.id = $1`,
      [id, req.subsonicUser.id]
    );
    const artist = artistRes.rows[0];
    if (!artist) return notFound(reply, req, 'Artist');

    const albumSql = `${albumSelectSql(req.subsonicUser.id)} WHERE al.artist_id = $1 ${ALBUM_GROUP}, sa.created_at, ur.rating
       ORDER BY al.year DESC NULLS LAST, al.title ASC`;
    const { rows } = await query(albumSql, [id]);
    const albums = rows.map(formatAlbum);
    const withCover = rows.find((r) => r.cover_path);

    return sendOk(reply, req, {
      artist: {
        id: String(artist.id),
        name: artist.name,
        albumCount: albums.length,
        starred: artist.starred_at ? new Date(artist.starred_at).toISOString() : undefined,
        userRating: artist.user_rating != null ? Number(artist.user_rating) : undefined,
        ...(withCover ? { coverArt: `al-${withCover.id}`, artistImageUrl: `/rest/getCoverArt.view?id=ar-${artist.id}` } : {}),
        album: albums,
      },
    });
  });

  endpoint('getAlbum', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Album');
    if (id === null) return;

    const albumRes = await query(
      `${albumSelectSql(req.subsonicUser.id)} WHERE al.id = $1 ${ALBUM_GROUP}, sa.created_at, ur.rating`,
      [id]
    );
    const album = albumRes.rows[0];
    if (!album) return notFound(reply, req, 'Album');

    const { rows } = await query(
      `${songSelectSql(req.subsonicUser.id)} WHERE t.album_id = $1
       ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [id]
    );

    return sendOk(reply, req, { album: { ...formatAlbum(album), song: rows.map(formatSong) } });
  });

  endpoint('getSong', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const { rows } = await query(`${songSelectSql(req.subsonicUser.id)} WHERE t.id = $1`, [id]);
    if (!rows[0]) return notFound(reply, req, 'Song');
    return sendOk(reply, req, { song: formatSong(rows[0]) });
  });

  endpoint('getMusicDirectory', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Directory');
    if (id === null) return;

    if (id === MUSIC_FOLDER_ID) {
      // Top level: return albums as directories
      const { rows } = await query(
        `${albumSelectSql(req.subsonicUser.id)} ${ALBUM_GROUP}, sa.created_at, ur.rating ORDER BY al.title ASC LIMIT 500`
      );
      return sendOk(reply, req, {
        directory: {
          id: String(MUSIC_FOLDER_ID),
          name: 'Music Library',
          child: rows.map((r) => ({ ...formatAlbum(r), isDir: true })),
        },
      });
    }

    // Album directory: return songs
    const albumRes = await query(
      `${albumSelectSql(req.subsonicUser.id)} WHERE al.id = $1 ${ALBUM_GROUP}, sa.created_at, ur.rating`,
      [id]
    );
    const album = albumRes.rows[0];
    if (!album) return notFound(reply, req, 'Directory');

    const { rows } = await query(
      `${songSelectSql(req.subsonicUser.id)} WHERE t.album_id = $1
       ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [id]
    );

    return sendOk(reply, req, {
      directory: {
        id: String(id),
        name: album.title,
        parent: String(MUSIC_FOLDER_ID),
        child: rows.map(formatSong),
      },
    });
  });

  const handleAlbumList = async (req, reply, params, listKey = 'albumList2') => {
    if (!params.type) {
      return missing(reply, req, 'type');
    }

    const type = String(params.type).trim();
    let size = parseInt(params.size, 10);
    if (Number.isNaN(size) || size < 1) size = 10;
    if (size > 500) size = 500;

    let offset = parseInt(params.offset, 10);
    if (Number.isNaN(offset) || offset < 0) offset = 0;

    const normType = type.toLowerCase();
    const whereClauses = [];
    const queryParams = [];
    let pIdx = 1;

    if (normType === 'starred') {
      whereClauses.push('sa.created_at IS NOT NULL');
    }

    if (params.genre || normType === 'bygenre') {
      const genre = params.genre || '';
      if (genre) {
        whereClauses.push(`(al.genre ILIKE $${pIdx} OR EXISTS (SELECT 1 FROM tracks gt WHERE gt.album_id = al.id AND gt.genre ILIKE $${pIdx}))`);
        queryParams.push(genre);
        pIdx++;
      }
    }

    if (params.fromYear) {
      const fromYear = parseInt(params.fromYear, 10);
      if (!Number.isNaN(fromYear)) {
        whereClauses.push(`al.year >= $${pIdx++}`);
        queryParams.push(fromYear);
      }
    }

    if (params.toYear) {
      const toYear = parseInt(params.toYear, 10);
      if (!Number.isNaN(toYear)) {
        whereClauses.push(`al.year <= $${pIdx++}`);
        queryParams.push(toYear);
      }
    }

    let orderBy;
    if (normType === 'alphabeticalbyname') {
      orderBy = 'ORDER BY al.title ASC';
    } else if (normType === 'alphabeticalbyartist') {
      orderBy = 'ORDER BY a.name ASC NULLS LAST, al.title ASC';
    } else if (normType === 'random') {
      orderBy = 'ORDER BY RANDOM()';
    } else if (normType === 'byyear') {
      orderBy = 'ORDER BY al.year DESC NULLS LAST, al.title ASC';
    } else if (normType === 'bygenre') {
      orderBy = 'ORDER BY al.title ASC';
    } else if (normType === 'starred') {
      orderBy = 'ORDER BY sa.created_at DESC';
    } else {
      orderBy = 'ORDER BY al.created_at DESC NULLS LAST, al.id DESC';
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      ${albumSelectSql(req.subsonicUser.id)}
      ${whereSql}
      ${ALBUM_GROUP}, sa.created_at, ur.rating
      ${orderBy}
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;
    queryParams.push(size, offset);

    const { rows } = await query(sql, queryParams);
    return sendOk(reply, req, {
      [listKey]: {
        album: rows.map(formatAlbum),
      },
    });
  };

  endpoint('getAlbumList2', (req, reply, params) => handleAlbumList(req, reply, params, 'albumList2'));
  endpoint('getAlbumList', (req, reply, params) => handleAlbumList(req, reply, params, 'albumList'));

  endpoint('getGenres', async (req, reply) => {
    const { rows } = await query(GENRES_SQL);
    return sendOk(reply, req, {
      genres: {
        genre: rows,
      },
    });
  });

  endpoint('getSongsByGenre', async (req, reply, params) => {
    if (!params.genre || String(params.genre).trim() === '') {
      return missing(reply, req, 'genre');
    }

    const genre = String(params.genre).trim();
    let count = parseInt(params.count ?? params.size, 10);
    if (Number.isNaN(count) || count < 1) count = 50;
    if (count > 500) count = 500;

    let offset = parseInt(params.offset, 10);
    if (Number.isNaN(offset) || offset < 0) offset = 0;

    const sql = `
      ${songSelectSql(req.subsonicUser.id)}
      WHERE (t.genre ILIKE $1 OR al.genre ILIKE $1)
      ORDER BY a.name ASC NULLS LAST, al.title ASC NULLS LAST, t.disc_number ASC, COALESCE(t.track_number, 999) ASC, t.file_name ASC
      LIMIT $2 OFFSET $3
    `;

    const { rows } = await query(sql, [genre, count, offset]);
    return sendOk(reply, req, {
      songsByGenre: {
        song: rows.map(formatSong),
      },
    });
  });

  // ---- Favorites (Star / Unstar) ----

  endpoint('star', async (req, reply, params) => {
    const userId = req.subsonicUser.id;
    const trackIds = parseIdList(params.id);
    const albumIds = parseIdList(params.albumId);
    const artistIds = parseIdList(params.artistId);

    for (const id of trackIds) {
      await query(
        'INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, id]
      );
    }
    for (const id of albumIds) {
      await query(
        'INSERT INTO user_starred_albums (user_id, album_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, id]
      );
    }
    for (const id of artistIds) {
      await query(
        'INSERT INTO user_starred_artists (user_id, artist_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, id]
      );
    }

    return sendOk(reply, req);
  });

  endpoint('unstar', async (req, reply, params) => {
    const userId = req.subsonicUser.id;
    const trackIds = parseIdList(params.id);
    const albumIds = parseIdList(params.albumId);
    const artistIds = parseIdList(params.artistId);

    if (trackIds.length > 0) {
      await query('DELETE FROM user_starred_tracks WHERE user_id = $1 AND track_id = ANY($2::int[])', [userId, trackIds]);
    }
    if (albumIds.length > 0) {
      await query('DELETE FROM user_starred_albums WHERE user_id = $1 AND album_id = ANY($2::int[])', [userId, albumIds]);
    }
    if (artistIds.length > 0) {
      await query('DELETE FROM user_starred_artists WHERE user_id = $1 AND artist_id = ANY($2::int[])', [userId, artistIds]);
    }

    return sendOk(reply, req);
  });

  const handleGetStarred = async (req, reply, key) => {
    const userId = req.subsonicUser.id;

    const artistRows = await query(
      `SELECT a.id, a.name,
              COUNT(DISTINCT al.id)::int AS album_count,
              MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
              sa.created_at AS starred_at,
              ur.rating AS user_rating
       FROM user_starred_artists sa
       JOIN artists a ON a.id = sa.artist_id
       LEFT JOIN albums al ON al.artist_id = a.id
       LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $1
       WHERE sa.user_id = $1
       GROUP BY a.id, a.name, sa.created_at, ur.rating
       ORDER BY sa.created_at DESC`,
      [userId]
    );

    const albumRows = await query(
      `${albumSelectSql(userId)}
       WHERE sa.created_at IS NOT NULL
       ${ALBUM_GROUP}, sa.created_at, ur.rating
       ORDER BY sa.created_at DESC`,
      []
    );

    const songRows = await query(
      `${songSelectSql(userId)}
       WHERE st.created_at IS NOT NULL
       ORDER BY st.created_at DESC`,
      []
    );

    return sendOk(reply, req, {
      [key]: {
        artist: artistRows.rows.map(formatArtist),
        album: albumRows.rows.map(formatAlbum),
        song: songRows.rows.map(formatSong),
      },
    });
  };

  endpoint('getStarred', (req, reply) => handleGetStarred(req, reply, 'starred'));
  endpoint('getStarred2', (req, reply) => handleGetStarred(req, reply, 'starred2'));

  // ---- Search (search2 and search3) ----

  const handleSearch = async (req, reply, params, key) => {
    const q = String(params.query || '').trim();
    if (!q) {
      return sendOk(reply, req, { [key]: { artist: [], album: [], song: [] } });
    }

    const pattern = `%${q}%`;
    const artistCount = Math.min(Math.max(parseInt(params.artistCount, 10) || 20, 0), 100);
    const albumCount = Math.min(Math.max(parseInt(params.albumCount, 10) || 20, 0), 100);
    const songCount = Math.min(Math.max(parseInt(params.songCount, 10) || 20, 0), 100);
    const artistOffset = Math.max(parseInt(params.artistOffset, 10) || 0, 0);
    const albumOffset = Math.max(parseInt(params.albumOffset, 10) || 0, 0);
    const songOffset = Math.max(parseInt(params.songOffset, 10) || 0, 0);

    const artistPromise = artistCount > 0
      ? query(
          `SELECT a.id, a.name,
                  COUNT(DISTINCT al.id)::int AS album_count,
                  MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
                  sa.created_at AS starred_at,
                  ur.rating AS user_rating
           FROM artists a
           LEFT JOIN albums al ON al.artist_id = a.id
           LEFT JOIN user_starred_artists sa ON sa.artist_id = a.id AND sa.user_id = $2
           LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $2
           WHERE a.name ILIKE $1
           GROUP BY a.id, a.name, sa.created_at, ur.rating
           ORDER BY a.name ASC
           LIMIT $3 OFFSET $4`,
          [pattern, req.subsonicUser.id, artistCount, artistOffset]
        )
      : Promise.resolve({ rows: [] });

    const albumPromise = albumCount > 0
      ? query(
          `${albumSelectSql(req.subsonicUser.id)}
           WHERE al.title ILIKE $1 OR a.name ILIKE $1
           ${ALBUM_GROUP}, sa.created_at, ur.rating
           ORDER BY al.title ASC
           LIMIT $2 OFFSET $3`,
          [pattern, albumCount, albumOffset]
        )
      : Promise.resolve({ rows: [] });

    const songPromise = songCount > 0
      ? query(
          `${songSelectSql(req.subsonicUser.id)}
           WHERE t.title ILIKE $1 OR al.title ILIKE $1 OR a.name ILIKE $1
           ORDER BY t.title ASC
           LIMIT $2 OFFSET $3`,
          [pattern, songCount, songOffset]
        )
      : Promise.resolve({ rows: [] });

    const [artistsRes, albumsRes, songsRes] = await Promise.all([artistPromise, albumPromise, songPromise]);

    return sendOk(reply, req, {
      [key]: {
        artist: artistsRes.rows.map(formatArtist),
        album: albumsRes.rows.map(formatAlbum),
        song: songsRes.rows.map(formatSong),
      },
    });
  };

  endpoint('search2', (req, reply, params) => handleSearch(req, reply, params, 'searchResult2'));
  endpoint('search3', (req, reply, params) => handleSearch(req, reply, params, 'searchResult3'));

  // ---- Playlists ----

  endpoint('getPlaylists', async (req, reply) => {
    const userId = req.subsonicUser.id;
    const { rows } = await query(
      `SELECT p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at,
              u.username AS owner_username,
              COUNT(pt.id)::int AS song_count,
              COALESCE(SUM(t.duration), 0)::int AS duration,
              MIN(t.album_id) FILTER (WHERE t.album_id IS NOT NULL) AS cover_art
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       WHERE p.owner_id = $1 OR p.is_public = true
       GROUP BY p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at, u.username
       ORDER BY p.name ASC`,
      [userId]
    );

    return sendOk(reply, req, {
      playlists: {
        playlist: rows.map((r) => formatPlaylist(r)),
      },
    });
  });

  endpoint('getPlaylist', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Playlist');
    if (id === null) return;

    const userId = req.subsonicUser.id;
    const { rows: pRows } = await query(
      `SELECT p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at,
              u.username AS owner_username,
              COUNT(pt.id)::int AS song_count,
              COALESCE(SUM(t.duration), 0)::int AS duration,
              MIN(t.album_id) FILTER (WHERE t.album_id IS NOT NULL) AS cover_art
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       WHERE p.id = $1 AND (p.owner_id = $2 OR p.is_public = true)
       GROUP BY p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at, u.username`,
      [id, userId]
    );

    const playlist = pRows[0];
    if (!playlist) return notFound(reply, req, 'Playlist');

    const { rows: songRows } = await query(
      `${songSelectSql(userId)}
       JOIN playlist_tracks pt ON pt.track_id = t.id
       WHERE pt.playlist_id = $1
       ORDER BY pt.track_order ASC`,
      [id]
    );

    return sendOk(reply, req, {
      playlist: formatPlaylist(playlist, songRows),
    });
  });

  endpoint('createPlaylist', async (req, reply, params) => {
    const name = String(params.name || '').trim();
    if (!name) return missing(reply, req, 'name');

    const userId = req.subsonicUser.id;
    const songIds = parseIdList(params.songId);

    const { rows } = await query(
      'INSERT INTO playlists (name, owner_id, is_public) VALUES ($1, $2, $3) RETURNING id, name, comment, is_public, created_at, updated_at',
      [name, userId, Boolean(params.public)]
    );
    const pl = rows[0];

    for (let idx = 0; idx < songIds.length; idx++) {
      await query(
        'INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES ($1, $2, $3)',
        [pl.id, songIds[idx], idx + 1]
      );
    }

    const { rows: songRows } = await query(
      `${songSelectSql(userId)}
       JOIN playlist_tracks pt ON pt.track_id = t.id
       WHERE pt.playlist_id = $1
       ORDER BY pt.track_order ASC`,
      [pl.id]
    );

    return sendOk(reply, req, {
      playlist: formatPlaylist({ ...pl, owner_username: req.subsonicUser.username }, songRows),
    });
  });

  endpoint('updatePlaylist', async (req, reply, params) => {
    const playlistId = parseId(params.playlistId);
    if (!playlistId) return missing(reply, req, 'playlistId');

    const userId = req.subsonicUser.id;
    const check = await query(
      'SELECT id, owner_id FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [playlistId, userId, Boolean(req.subsonicUser.is_admin)]
    );
    if (check.rows.length === 0) return notFound(reply, req, 'Playlist');

    if (params.name) {
      await query('UPDATE playlists SET name = $1, updated_at = NOW() WHERE id = $2', [params.name.trim(), playlistId]);
    }
    if (params.comment !== undefined) {
      await query('UPDATE playlists SET comment = $1, updated_at = NOW() WHERE id = $2', [params.comment, playlistId]);
    }
    if (params.public !== undefined) {
      await query('UPDATE playlists SET is_public = $1, updated_at = NOW() WHERE id = $2', [Boolean(params.public), playlistId]);
    }

    const toRemove = parseIdList(params.songIndexToRemove);
    if (toRemove.length > 0) {
      const { rows: currentTracks } = await query(
        'SELECT id, track_order FROM playlist_tracks WHERE playlist_id = $1 ORDER BY track_order ASC',
        [playlistId]
      );
      const removeSet = new Set(toRemove);
      const idsToDelete = currentTracks.filter((_, idx) => removeSet.has(idx)).map((r) => r.id);
      if (idsToDelete.length > 0) {
        await query('DELETE FROM playlist_tracks WHERE id = ANY($1::int[])', [idsToDelete]);
      }
    }

    const toAdd = parseIdList(params.songIdToAdd);
    if (toAdd.length > 0) {
      const { rows: maxRows } = await query(
        'SELECT COALESCE(MAX(track_order), 0)::int AS max_order FROM playlist_tracks WHERE playlist_id = $1',
        [playlistId]
      );
      let order = maxRows[0].max_order;
      for (const trackId of toAdd) {
        await query(
          'INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES ($1, $2, $3)',
          [playlistId, trackId, ++order]
        );
      }
      await query('UPDATE playlists SET updated_at = NOW() WHERE id = $1', [playlistId]);
    }

    return sendOk(reply, req);
  });

  endpoint('deletePlaylist', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Playlist');
    if (id === null) return;

    const userId = req.subsonicUser.id;
    const res = await query(
      'DELETE FROM playlists WHERE id = $1 AND (owner_id = $2 OR $3 = true)',
      [id, userId, Boolean(req.subsonicUser.is_admin)]
    );
    if (res.rowCount === 0) return notFound(reply, req, 'Playlist');
    return sendOk(reply, req);
  });

  // ---- Scrobbles & Ratings ----

  endpoint('scrobble', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const submission = params.submission !== 'false' && params.submission !== false;
    if (submission) {
      await query(
        'UPDATE tracks SET play_count = play_count + 1, last_played_at = NOW() WHERE id = $1',
        [id]
      );
      await query(
        'INSERT INTO play_history (user_id, track_id, played_at) VALUES ($1, $2, NOW())',
        [req.subsonicUser.id, id]
      );
    }

    return sendOk(reply, req);
  });

  endpoint('setRating', async (req, reply, params) => {
    const userId = req.subsonicUser.id;
    const rating = Math.max(0, Math.min(5, parseInt(params.rating, 10) || 0));

    const trackId = parseId(params.id);
    const albumId = parseId(params.albumId);
    const artistId = parseId(params.artistId);

    const updateRating = async (type, entityId) => {
      if (!entityId) return;
      if (rating === 0) {
        await query(
          'DELETE FROM user_ratings WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3',
          [userId, type, entityId]
        );
      } else {
        await query(
          `INSERT INTO user_ratings (user_id, entity_type, entity_id, rating)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET rating = EXCLUDED.rating`,
          [userId, type, entityId, rating]
        );
      }
    };

    if (trackId) await updateRating('track', trackId);
    if (albumId) await updateRating('album', albumId);
    if (artistId) await updateRating('artist', artistId);

    return sendOk(reply, req);
  });

  // ---- Media retrieval ----

  const streamHandler = async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const { rows } = await query('SELECT file_path, format FROM tracks WHERE id = $1', [id]);
    if (!rows[0] || !fs.existsSync(rows[0].file_path)) {
      return reply.status(404).send('Not found');
    }
    sendAudioFile(req, reply, rows[0].file_path, rows[0].format);
  };

  endpoint('stream', streamHandler);
  endpoint('download', streamHandler);

  endpoint('getCoverArt', async (req, reply, params) => {
    if (!params.id) return missing(reply, req, 'id');

    const file = coverFileFromPath(await resolveCoverPath(params.id));
    if (!file) return reply.status(404).send('Not found');

    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(file).pipe(reply.raw);
  });

  // ---- Unknown endpoints ----

  fastify.route({
    method: ['GET', 'POST'],
    url: '/rest/*',
    handler: async (req, reply) => {
      const name = req.url.split('?')[0].replace(/^\/rest\//, '');
      return sendError(reply, req, ErrorCode.GENERIC, `Unknown method: ${name}`);
    },
  });
}
