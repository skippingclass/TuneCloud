import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';
import { authenticate } from '../subsonic/auth.js';
import { sendOk, sendError, ErrorCode } from '../subsonic/response.js';
import {
  formatAlbum,
  formatSong,
  buildIndexes,
  SONG_SELECT,
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

function missing(reply, req, name) {
  return sendError(reply, req, ErrorCode.MISSING_PARAM, `Required parameter is missing: ${name}`);
}

function notFound(reply, req, what) {
  return sendError(reply, req, ErrorCode.NOT_FOUND, `${what} not found`);
}

// Resolves an id param: returns the integer, or sends an error and returns null.
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

const ARTISTS_SQL = `
  SELECT a.id, a.name,
         COUNT(DISTINCT al.id)::int AS album_count,
         MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id
  FROM artists a
  LEFT JOIN albums al ON al.artist_id = a.id
  GROUP BY a.id, a.name
  ORDER BY a.name ASC`;

const ALBUM_SQL = `
  SELECT al.id, al.title, al.year, al.genre, al.cover_path, al.created_at,
         a.id AS artist_id, a.name AS artist_name,
         COUNT(t.id)::int AS song_count,
         COALESCE(SUM(t.duration), 0) AS duration
  FROM albums al
  LEFT JOIN artists a ON al.artist_id = a.id
  LEFT JOIN tracks t ON t.album_id = al.id`;
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
  // Subsonic clients may POST parameters as application/x-www-form-urlencoded.
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
    sendOk(reply, req, { openSubsonicExtensions: [] })
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
    const { rows } = await query(ARTISTS_SQL);
    return sendOk(reply, req, {
      indexes: {
        lastModified: Date.now(),
        ignoredArticles: IGNORED_ARTICLES_STR,
        index: buildIndexes(rows),
      },
    });
  });

  endpoint('getArtists', async (req, reply) => {
    const { rows } = await query(ARTISTS_SQL);
    return sendOk(reply, req, {
      artists: { ignoredArticles: IGNORED_ARTICLES_STR, index: buildIndexes(rows) },
    });
  });

  endpoint('getArtist', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Artist');
    if (id === null) return;

    const artistRes = await query('SELECT id, name FROM artists WHERE id = $1', [id]);
    const artist = artistRes.rows[0];
    if (!artist) return notFound(reply, req, 'Artist');

    const { rows } = await query(
      `${ALBUM_SQL} WHERE al.artist_id = $1 ${ALBUM_GROUP}
       ORDER BY al.year DESC NULLS LAST, al.title ASC`,
      [id]
    );
    const albums = rows.map(formatAlbum);
    const withCover = rows.find((r) => r.cover_path);

    return sendOk(reply, req, {
      artist: {
        id: String(artist.id),
        name: artist.name,
        albumCount: albums.length,
        ...(withCover ? { coverArt: `al-${withCover.id}`, artistImageUrl: `/rest/getCoverArt.view?id=ar-${artist.id}` } : {}),
        album: albums,
      },
    });
  });

  endpoint('getAlbum', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Album');
    if (id === null) return;

    const albumRes = await query(`${ALBUM_SQL} WHERE al.id = $1 ${ALBUM_GROUP}`, [id]);
    const album = albumRes.rows[0];
    if (!album) return notFound(reply, req, 'Album');

    const { rows } = await query(
      `${SONG_SELECT} WHERE t.album_id = $1
       ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [id]
    );

    return sendOk(reply, req, { album: { ...formatAlbum(album), song: rows.map(formatSong) } });
  });

  endpoint('getSong', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const { rows } = await query(`${SONG_SELECT} WHERE t.id = $1`, [id]);
    if (!rows[0]) return notFound(reply, req, 'Song');
    return sendOk(reply, req, { song: formatSong(rows[0]) });
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
    if (normType === 'starred') {
      return sendOk(reply, req, { [listKey]: { album: [] } });
    }

    const whereClauses = [];
    const queryParams = [];
    let pIdx = 1;

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
    } else if (normType === 'recent' || normType === 'newest' || normType === 'frequent') {
      orderBy = 'ORDER BY al.created_at DESC NULLS LAST, al.id DESC';
    } else {
      // Default fallback for unknown type
      orderBy = 'ORDER BY al.created_at DESC NULLS LAST, al.id DESC';
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      ${ALBUM_SQL}
      ${whereSql}
      ${ALBUM_GROUP}
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
      ${SONG_SELECT}
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

  // ---- Media retrieval ----

  const streamHandler = async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const { rows } = await query('SELECT file_path, format FROM tracks WHERE id = $1', [id]);
    if (!rows[0] || !fs.existsSync(rows[0].file_path)) {
      return reply.status(404).send('Not found');
    }
    // No transcoding: maxBitRate / format params are ignored and the original file is served.
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
