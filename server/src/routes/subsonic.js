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
