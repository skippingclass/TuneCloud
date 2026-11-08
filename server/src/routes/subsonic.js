import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, transaction } from '../db.js';
import { appendTracks, checkTracks, lockPlaylist, ids, badRequest } from '../services/playlists.js';
import { authenticate } from '../subsonic/auth.js';
import { sendOk, sendError, ErrorCode } from '../subsonic/response.js';
import {
  formatArtist,
  formatAlbum,
  formatSong,
  formatPlaylist,
  formatPlayQueue,
  formatBookmark,
  formatInternetRadioStation,
  formatPodcast,
  formatPodcastEpisode,
  buildIndexes,
  buildFolderIndexes,
  songSelectSql,
  albumSelectSql,
  artistSelectSql,
  IGNORED_ARTICLES_STR,
} from '../subsonic/formatters.js';
import { sendAudioFile } from '../streaming.js';
import { resolveCoverFile, sendCoverFile } from '../cover.js';
import { readEmbeddedLyrics } from '../lyrics.js';
import { getScanState, startScanInBackground } from './scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || path.join(__dirname, '../../covers'));

const MUSIC_FOLDER_ID = 1;

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);

function isAudioFile(fileName) {
  return AUDIO_EXTS.has(path.extname(fileName).toLowerCase());
}

function encodeDirId(relPath) {
  if (!relPath || relPath === '.' || relPath === '') return String(MUSIC_FOLDER_ID);
  return `dir:${Buffer.from(relPath, 'utf8').toString('base64url')}`;
}

function decodeDirId(id) {
  if (id === undefined || id === null || id === '' || id === String(MUSIC_FOLDER_ID) || id === MUSIC_FOLDER_ID) {
    return '';
  }
  const s = String(id);
  if (s.startsWith('dir:')) {
    try {
      return Buffer.from(s.slice(4), 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

function resolveMusicDirPath(relPath) {
  const musicDir = process.env.MUSIC_DIR;
  if (!musicDir) return null;
  const resolvedRoot = path.resolve(musicDir);
  const target = path.resolve(resolvedRoot, relPath || '');
  const rel = path.relative(resolvedRoot, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    const physicalRel = path.relative(fs.realpathSync(resolvedRoot), fs.realpathSync(target));
    if (physicalRel.startsWith('..') || path.isAbsolute(physicalRel)) return null;
  } catch { return null; }
  return target;
}

function parseId(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  return /^[1-9]\d*$/.test(s) && Number(s) <= 2147483647 ? Number(s) : NaN;
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

function playlistSongIds(value) {
  return ids(value == null || value === '' ? [] : Array.isArray(value) ? value : String(value).split(','));
}

function parseLrc(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
  let hasTime = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match;
    let lastIndex = 0;
    const timestamps = [];
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const msPart = match[3] || '0';
      const ms = msPart.length === 2 ? parseInt(msPart, 10) * 10 : parseInt(msPart, 10);
      timestamps.push(min * 60000 + sec * 1000 + ms);
      lastIndex = timeRegex.lastIndex;
    }
    const text = trimmed.slice(lastIndex).trim();
    if (timestamps.length > 0) {
      hasTime = true;
      for (const t of timestamps) {
        result.push({ start: t, value: text });
      }
    } else if (text) {
      result.push({ value: text });
    }
  }

  if (hasTime) {
    result.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }
  return { synced: hasTime, lines: result };
}

function getSafeLyricsCandidate(filePath, ext) {
  if (!filePath || typeof filePath !== 'string') return null;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const candidatePath = path.join(dir, `${base}${ext}`);
  try {
    if (!fs.existsSync(candidatePath)) return null;
    const realCandidate = fs.realpathSync(candidatePath);
    if (process.env.MUSIC_DIR) {
      const realMusicDir = fs.realpathSync(process.env.MUSIC_DIR);
      const rel = path.relative(realMusicDir, realCandidate);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    } else {
      const realTrackDir = fs.realpathSync(dir);
      const rel = path.relative(realTrackDir, realCandidate);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    }
    const stat = fs.statSync(realCandidate);
    if (!stat.isFile() || stat.size > 128 * 1024) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

async function loadTrackLyrics(filePath) {
  if (!filePath) return null;
  const safeLrc = getSafeLyricsCandidate(filePath, '.lrc');
  if (safeLrc) {
    try {
      const content = await fs.promises.readFile(safeLrc, 'utf8');
      return parseLrc(content);
    } catch {}
  }
  const safeTxt = getSafeLyricsCandidate(filePath, '.txt');
  if (safeTxt) {
    try {
      const content = await fs.promises.readFile(safeTxt, 'utf8');
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((v) => ({ value: v }));
      return { synced: false, lines };
    } catch {}
  }
  const embedded = await readEmbeddedLyrics(filePath);
  return embedded ? (embedded.synced ? parseLrc(embedded.lyrics) : { synced: false, lines: embedded.lyrics.split(/\r?\n/).map(value => ({ value })) }) : null;
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
  WITH song_genres AS (
    SELECT DISTINCT t.id, t.album_id, g.genre
    FROM tracks t CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_array_length(COALESCE(t.metadata->'genres','[]'::jsonb)) > 0 THEN t.metadata->'genres'
           WHEN NULLIF(TRIM(t.genre),'') IS NOT NULL THEN jsonb_build_array(t.genre) ELSE '[]'::jsonb END
    ) g(genre) WHERE t.missing_since IS NULL
  ), album_genres AS (
    SELECT DISTINCT album_id, genre FROM song_genres WHERE album_id IS NOT NULL
    UNION
    SELECT al.id, al.genre FROM albums al WHERE NULLIF(TRIM(al.genre),'') IS NOT NULL
      AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=al.id AND t.missing_since IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=al.id AND t.missing_since IS NULL AND jsonb_array_length(COALESCE(t.metadata->'genres','[]'::jsonb)) > 0)
  )
  SELECT g.genre AS value,
    (SELECT COUNT(*)::int FROM song_genres sg WHERE sg.genre=g.genre) AS "songCount",
    (SELECT COUNT(*)::int FROM album_genres ag WHERE ag.genre=g.genre) AS "albumCount"
  FROM (SELECT genre FROM song_genres UNION SELECT genre FROM album_genres) g ORDER BY g.genre`;

async function coverFileFromPath(coverPath) {
  if (!coverPath) return null;
  if (path.isAbsolute(coverPath) && fs.existsSync(coverPath)) {
    return resolveCoverFile(coverPath, { allowMusic: true });
  }
  const file = path.join(COVERS_DIR, path.basename(coverPath.split('?')[0]));
  return resolveCoverFile(file);
}

async function resolveCoverPath(rawId) {
  const id = String(rawId);
  let m;
  if (id.startsWith('dir:')) {
    const rel = decodeDirId(id);
    if (rel !== null) {
      const fullDir = resolveMusicDirPath(rel);
      if (fullDir && fs.existsSync(fullDir)) {
        const alb = await query(
          'SELECT cover_path FROM albums WHERE folder_path = $1 AND cover_path IS NOT NULL LIMIT 1',
          [fullDir]
        );
        if (alb.rows[0]?.cover_path) {
          const cached = await coverFileFromPath(alb.rows[0].cover_path);
          if (cached) return cached;
        }
        const prefix = fullDir.endsWith(path.sep) ? fullDir : fullDir + path.sep;
        const tr = await query(
          `SELECT COALESCE(t.cover_path, al.cover_path) AS cover_path
           FROM tracks t
           LEFT JOIN albums al ON t.album_id = al.id
           WHERE starts_with(t.file_path, $1) AND t.missing_since IS NULL AND (t.cover_path IS NOT NULL OR al.cover_path IS NOT NULL)
           LIMIT 1`,
          [prefix]
        );
        if (tr.rows[0]?.cover_path) {
          const cached = await coverFileFromPath(tr.rows[0].cover_path);
          if (cached) return cached;
        }
        for (const name of [
          'cover.jpg', 'cover.jpeg', 'cover.png', 'Cover.jpg', 'Cover.png',
          'folder.jpg', 'folder.png', 'Folder.jpg', 'Folder.png',
          'front.jpg', 'front.png', 'Front.jpg',
        ]) {
          const directFile = await resolveCoverFile(path.join(fullDir, name), { allowMusic: true });
          if (directFile) return directFile;
        }
      }
    }
  }
  if ((m = id.match(/^al-(\d+)$/))) {
    const { rows } = await query('SELECT cover_path FROM albums WHERE id = $1', [m[1]]);
    return rows[0]?.cover_path || null;
  }
  if ((m = id.match(/^tr-(\d+)$/))) {
    const { rows } = await query(
      'SELECT COALESCE(t.cover_path, al.cover_path) AS cover_path FROM tracks t LEFT JOIN albums al ON t.album_id = al.id WHERE t.id = $1 AND t.missing_since IS NULL',
      [m[1]]
    );
    return rows[0]?.cover_path || null;
  }
  if ((m = id.match(/^ar-(\d+)$/))) {
    const artistId = m[1];
    const artistCover = `artist_${artistId}.jpg`;
    if (fs.existsSync(path.join(COVERS_DIR, artistCover))) {
      return artistCover;
    }
    const { rows } = await query(
      `SELECT cover_path FROM albums al WHERE (artist_id=$1 OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks t ON t.id=c.track_id WHERE c.artist_id=$1 AND t.album_id=al.id AND t.missing_since IS NULL)) AND cover_path IS NOT NULL ORDER BY id LIMIT 1`,
      [artistId]
    );
    return rows[0]?.cover_path || null;
  }
  if (/^\d+$/.test(id)) {
    const al = await query('SELECT cover_path FROM albums WHERE id = $1', [id]);
    if (al.rows[0]?.cover_path) return al.rows[0].cover_path;
    const tr = await query(
      'SELECT COALESCE(t.cover_path, al.cover_path) AS cover_path FROM tracks t LEFT JOIN albums al ON t.album_id = al.id WHERE t.id = $1 AND t.missing_since IS NULL',
      [id]
    );
    return tr.rows[0]?.cover_path || null;
  }
  return null;
}

export function parseSubsonicFormData(body) {
  if (typeof body !== 'string' || !body) return {};
  const params = {};
  const searchParams = new URLSearchParams(body);
  for (const [key, value] of searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      if (Array.isArray(params[key])) {
        params[key].push(value);
      } else {
        params[key] = [params[key], value];
      }
    } else {
      params[key] = value;
    }
  }
  return params;
}

export function mergeSubsonicParams(query, body) {
  const q = query && typeof query === 'object' ? query : {};
  const b = body && typeof body === 'object' ? body : {};
  const keys = new Set([...Object.keys(q), ...Object.keys(b)]);
  const merged = {};
  for (const key of keys) {
    const hasQ = Object.prototype.hasOwnProperty.call(q, key);
    const hasB = Object.prototype.hasOwnProperty.call(b, key);
    if (hasQ && !hasB) {
      merged[key] = q[key];
    } else if (!hasQ && hasB) {
      merged[key] = b[key];
    } else {
      const qVal = q[key];
      const bVal = b[key];
      if (qVal === bVal) {
        merged[key] = bVal;
      } else {
        const qArr = Array.isArray(qVal) ? qVal : [qVal];
        const bArr = Array.isArray(bVal) ? bVal : [bVal];
        if (['songId', 'songIdToAdd', 'songIndexToRemove', 'id', 'albumId', 'artistId'].includes(key)) {
          merged[key] = [...qArr, ...bArr];
        } else {
          merged[key] = bVal;
        }
      }
    }
  }
  return merged;
}

export default async function subsonicRoutes(fastify) {
  if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (req, body, done) => done(null, parseSubsonicFormData(body))
    );
  }

  function endpoint(name, handler) {
    const run = async (req, reply) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const params = mergeSubsonicParams(req.query, body);
      try {
        const auth = await authenticate(params);
        if (auth.error) return sendError(reply, req, auth.error.code, auth.error.message);
        req.subsonicUser = auth.user;
        return await handler(req, reply, params);
      } catch (err) {
        req.log.error(err);
        if (!reply.sent) return sendError(reply, req, err.statusCode === 404 ? ErrorCode.NOT_FOUND : ErrorCode.GENERIC,
          err.statusCode && err.statusCode < 500 ? err.message : 'Internal server error');
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
        { name: 'topSongsByArtistId', versions: [1] },
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

  endpoint('getIndexes', async (req, reply, params) => {
    if (params.musicFolderId && parseId(params.musicFolderId) !== MUSIC_FOLDER_ID) {
      return sendOk(reply, req, {
        indexes: {
          lastModified: Date.now(),
          ignoredArticles: IGNORED_ARTICLES_STR,
          index: [],
        },
      });
    }

    const rootPath = resolveMusicDirPath('');
    if (!rootPath || !fs.existsSync(rootPath)) {
      return sendOk(reply, req, {
        indexes: {
          lastModified: Date.now(),
          ignoredArticles: IGNORED_ARTICLES_STR,
          index: [],
        },
      });
    }

    try {
      const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
      const visible = entries.filter((e) => !e.name.startsWith('.'));
      const subdirs = visible.filter((e) => e.isDirectory());
      const audioFiles = visible.filter((e) => e.isFile() && isAudioFile(e.name));

      const dirItems = subdirs.map((d) => ({
        id: encodeDirId(d.name),
        name: d.name,
        coverArt: encodeDirId(d.name),
      }));

      let rootSongs = [];
      if (audioFiles.length > 0) {
        const filePaths = audioFiles.map((f) => path.join(rootPath, f.name));
        const { rows } = await query(
          `${songSelectSql(req.subsonicUser.id)} WHERE t.file_path = ANY($1::text[]) AND t.missing_since IS NULL ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
          [filePaths]
        );
        rootSongs = rows.map((r) => ({ ...formatSong(r), parent: String(MUSIC_FOLDER_ID) }));
      }

      return sendOk(reply, req, {
        indexes: {
          lastModified: Date.now(),
          ignoredArticles: IGNORED_ARTICLES_STR,
          index: buildFolderIndexes(dirItems),
          ...(rootSongs.length > 0 ? { child: rootSongs } : {}),
        },
      });
    } catch (err) {
      req.log.error(err, 'Failed to read root music directory for getIndexes');
      return sendOk(reply, req, {
        indexes: {
          lastModified: Date.now(),
          ignoredArticles: IGNORED_ARTICLES_STR,
          index: [],
        },
      });
    }
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
      `SELECT a.id, a.name, a.musicbrainz_id, sar.created_at AS starred_at, ur.rating AS user_rating
       FROM artists a
       LEFT JOIN user_starred_artists sar ON sar.artist_id = a.id AND sar.user_id = $2
       LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $2
       WHERE a.id = $1`,
      [id, req.subsonicUser.id]
    );
    const artist = artistRes.rows[0];
    if (!artist) return notFound(reply, req, 'Artist');

    const albumSql = `${albumSelectSql(req.subsonicUser.id)} WHERE (al.artist_id = $1 OR EXISTS (SELECT 1 FROM tracks tr JOIN track_credits c ON c.track_id=tr.id WHERE tr.album_id=al.id AND c.artist_id=$1 AND tr.missing_since IS NULL)) AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL) ${ALBUM_GROUP}, sa.created_at, ur.rating
       ORDER BY al.year DESC NULLS LAST, al.title ASC`;
    const { rows } = await query(albumSql, [id]);
    const albums = rows.map(formatAlbum);
    const withCover = rows.find((r) => r.cover_path);

    return sendOk(reply, req, {
      artist: {
        id: String(artist.id),
        name: artist.name,
        albumCount: albums.length,
        musicBrainzId: artist.musicbrainz_id || undefined,
        starred: artist.starred_at ? new Date(artist.starred_at).toISOString() : undefined,
        userRating: artist.user_rating != null ? Number(artist.user_rating) : undefined,
        ...(withCover ? { coverArt: `al-${withCover.id}`, artistImageUrl: `/api/cover/artist/${artist.id}` } : {}),
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
      `${songSelectSql(req.subsonicUser.id)} WHERE t.album_id = $1 AND t.missing_since IS NULL
       ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [id]
    );

    return sendOk(reply, req, { album: { ...formatAlbum(album), song: rows.map(formatSong) } });
  });

  endpoint('getSong', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Song');
    if (id === null) return;

    const { rows } = await query(`${songSelectSql(req.subsonicUser.id)} WHERE t.id = $1 AND t.missing_since IS NULL`, [id]);
    if (!rows[0]) return notFound(reply, req, 'Song');
    return sendOk(reply, req, { song: formatSong(rows[0]) });
  });

  endpoint('getMusicDirectory', async (req, reply, params) => {
    if (!params.id) {
      return missing(reply, req, 'id');
    }

    const rawId = String(params.id).trim();

    // 1. Directory ID navigation ('1' or 'dir:...')
    const relPath = decodeDirId(rawId);
    if (relPath !== null) {
      const targetDir = resolveMusicDirPath(relPath);
      if (!targetDir || !fs.existsSync(targetDir)) {
        return notFound(reply, req, 'Directory');
      }

      let stat;
      try {
        stat = await fs.promises.stat(targetDir);
      } catch {
        return notFound(reply, req, 'Directory');
      }
      if (!stat.isDirectory()) {
        return notFound(reply, req, 'Directory');
      }

      let entries;
      try {
        entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
      } catch (err) {
        req.log.error(err, `Failed to read directory: ${targetDir}`);
        return notFound(reply, req, 'Directory');
      }

      const isRoot = relPath === '';
      const currentDirId = isRoot ? String(MUSIC_FOLDER_ID) : encodeDirId(relPath);
      const dirName = isRoot ? 'Music Library' : path.basename(relPath);

      let parentId;
      if (!isRoot) {
        const parentRel = path.dirname(relPath);
        parentId = (!parentRel || parentRel === '.') ? String(MUSIC_FOLDER_ID) : encodeDirId(parentRel);
      }

      const visible = entries.filter((e) => !e.name.startsWith('.'));
      const subdirs = visible.filter((e) => e.isDirectory());
      const audioFiles = visible.filter((e) => e.isFile() && isAudioFile(e.name));

      subdirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      const childDirs = subdirs.map((d) => {
        const childRel = isRoot ? d.name : `${relPath}/${d.name}`;
        const childId = encodeDirId(childRel);
        return {
          id: childId,
          parent: currentDirId,
          isDir: true,
          title: d.name,
          name: d.name,
          album: d.name,
          coverArt: childId,
        };
      });

      let childSongs = [];
      if (audioFiles.length > 0) {
        const filePaths = audioFiles.map((f) => path.join(targetDir, f.name));
        const { rows } = await query(
          `${songSelectSql(req.subsonicUser.id)} WHERE t.file_path = ANY($1::text[]) AND t.missing_since IS NULL`,
          [filePaths]
        );
        const songsByPath = new Map(rows.map((r) => [r.file_path, r]));

        for (const f of audioFiles) {
          const fp = path.join(targetDir, f.name);
          const row = songsByPath.get(fp);
          if (row) {
            childSongs.push({
              ...formatSong(row),
              parent: currentDirId,
            });
          }
        }

        childSongs.sort((a, b) => {
          const d1 = a.discNumber ?? 1;
          const d2 = b.discNumber ?? 1;
          if (d1 !== d2) return d1 - d2;
          const t1 = a.track ?? 999;
          const t2 = b.track ?? 999;
          if (t1 !== t2) return t1 - t2;
          return (a.title || '').localeCompare(b.title || '');
        });
      }

      return sendOk(reply, req, {
        directory: {
          id: currentDirId,
          name: dirName,
          ...(parentId ? { parent: parentId } : {}),
          child: [...childDirs, ...childSongs],
        },
      });
    }

    // 2. Legacy fallback for numeric album ID
    const numId = parseId(rawId);
    if (Number.isNaN(numId) || numId <= 0) {
      return notFound(reply, req, 'Directory');
    }

    const albumRes = await query(
      `${albumSelectSql(req.subsonicUser.id)} WHERE al.id = $1 ${ALBUM_GROUP}, sa.created_at, ur.rating`,
      [numId]
    );
    const album = albumRes.rows[0];
    if (!album) return notFound(reply, req, 'Directory');

    const { rows } = await query(
      `${songSelectSql(req.subsonicUser.id)} WHERE t.album_id = $1 AND t.missing_since IS NULL
       ORDER BY t.disc_number ASC NULLS FIRST, COALESCE(t.track_number, 999) ASC, t.file_name ASC`,
      [numId]
    );

    return sendOk(reply, req, {
      directory: {
        id: String(numId),
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
    const whereClauses = [
      'EXISTS (SELECT 1 FROM tracks avt WHERE avt.album_id = al.id AND avt.missing_since IS NULL)',
    ];
    const queryParams = [];
    let pIdx = 1;

    if (normType === 'starred') {
      whereClauses.push('sa.created_at IS NOT NULL');
    }

    if (params.genre || normType === 'bygenre') {
      const genre = params.genre || '';
      if (genre) {
        whereClauses.push(`(al.genre ILIKE $${pIdx} OR EXISTS (SELECT 1 FROM tracks gt WHERE gt.album_id = al.id AND gt.missing_since IS NULL AND gt.genre ILIKE $${pIdx}))`);
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
    } else if (normType === 'frequent' || normType === 'recent') {
      const uid = Number(req.subsonicUser.id);
      const metric = normType === 'frequent' ? 'COUNT(*)' : 'MAX(ph.played_at)';
      whereClauses.push(`EXISTS (SELECT 1 FROM play_history ph JOIN tracks pt ON pt.id = ph.track_id
        WHERE ph.user_id = ${uid} AND pt.album_id = al.id)`);
      orderBy = `ORDER BY (SELECT ${metric} FROM play_history ph JOIN tracks pt ON pt.id = ph.track_id
        WHERE ph.user_id = ${uid} AND pt.album_id = al.id) DESC NULLS LAST, al.id ASC`;
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
      WHERE (t.genre ILIKE $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.metadata->'genres','[]'::jsonb)) g WHERE g ILIKE $1) OR (t.genre IS NULL AND al.genre ILIKE $1)) AND t.missing_since IS NULL
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
      `SELECT a.id, a.name, a.musicbrainz_id,
              COUNT(DISTINCT al.id)::int AS album_count,
              MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
              sa.created_at AS starred_at,
              ur.rating AS user_rating
       FROM user_starred_artists sa
       JOIN artists a ON a.id = sa.artist_id
       LEFT JOIN albums al ON (al.artist_id = a.id OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks member ON member.id=c.track_id WHERE c.artist_id=a.id AND member.album_id=al.id AND member.missing_since IS NULL)) AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL)
       LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $1
       WHERE sa.user_id = $1
       GROUP BY a.id, a.name, sa.created_at, ur.rating
       ORDER BY sa.created_at DESC`,
      [userId]
    );

    const albumRows = await query(
      `${albumSelectSql(userId)}
       WHERE sa.created_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL)
       ${ALBUM_GROUP}, sa.created_at, ur.rating
       ORDER BY sa.created_at DESC`,
      []
    );

    const songRows = await query(
      `${songSelectSql(userId)}
       WHERE st.created_at IS NOT NULL AND t.missing_since IS NULL
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
    const rawQuery = String(params.query ?? '').trim();
    const q = rawQuery === '""' ? '' : rawQuery;
    const pattern = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : '%';
    const count = name => {
      const value = params[name] === undefined ? 20 : Number(params[name]);
      if (!Number.isInteger(value) || value < 0 || value > 10000) throw badRequest(`${name} must be an integer between 0 and 10000`);
      return value;
    };
    const artistCount = count('artistCount');
    const albumCount = count('albumCount');
    const songCount = count('songCount');
    const artistOffset = Math.max(parseInt(params.artistOffset, 10) || 0, 0);
    const albumOffset = Math.max(parseInt(params.albumOffset, 10) || 0, 0);
    const songOffset = Math.max(parseInt(params.songOffset, 10) || 0, 0);

    const artistPromise = artistCount > 0
      ? query(
          `SELECT a.id, a.name, a.musicbrainz_id,
                  COUNT(DISTINCT al.id)::int AS album_count,
                  MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
                  sa.created_at AS starred_at,
                  ur.rating AS user_rating
           FROM artists a
           LEFT JOIN albums al ON (al.artist_id = a.id OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks member ON member.id=c.track_id WHERE c.artist_id=a.id AND member.album_id=al.id AND member.missing_since IS NULL)) AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL)
           LEFT JOIN user_starred_artists sa ON sa.artist_id = a.id AND sa.user_id = $2
           LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = $2
           WHERE ($1 = '%' OR a.name ILIKE $1)
             AND (
               EXISTS (SELECT 1 FROM tracks tr WHERE tr.artist_id = a.id AND tr.missing_since IS NULL)
               OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks tr ON tr.id=c.track_id WHERE c.artist_id=a.id AND tr.missing_since IS NULL)
               OR EXISTS (SELECT 1 FROM albums al2 WHERE al2.artist_id = a.id AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al2.id AND tr.missing_since IS NULL))
             )
           GROUP BY a.id, a.name, sa.created_at, ur.rating
           ORDER BY a.name ASC, a.id ASC
           LIMIT $3 OFFSET $4`,
          [pattern, req.subsonicUser.id, artistCount, artistOffset]
        )
      : Promise.resolve({ rows: [] });

    const albumPromise = albumCount > 0
      ? query(
          `${albumSelectSql(req.subsonicUser.id)}
           WHERE ($1 = '%' OR al.title ILIKE $1 OR a.name ILIKE $1)
             AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL)
           ${ALBUM_GROUP}, sa.created_at, ur.rating
           ORDER BY al.title ASC, al.id ASC
           LIMIT $2 OFFSET $3`,
          [pattern, albumCount, albumOffset]
        )
      : Promise.resolve({ rows: [] });

    const songPromise = songCount > 0
      ? query(
          `${songSelectSql(req.subsonicUser.id)}
           WHERE ($1 = '%' OR t.title ILIKE $1 OR al.title ILIKE $1 OR a.name ILIKE $1 OR t.track_artist_credit ILIKE $1)
             AND t.missing_since IS NULL
           ORDER BY t.title ASC, t.id ASC
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
              COUNT(t.id)::int AS song_count,
              COALESCE(SUM(t.duration), 0)::int AS duration,
              MIN(CASE WHEN t.cover_path IS NOT NULL THEN 'tr-' || t.id::text WHEN al.cover_path IS NOT NULL THEN 'al-' || al.id::text END) AS cover_art
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id AND t.missing_since IS NULL
       LEFT JOIN albums al ON al.id = t.album_id
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
              COUNT(t.id)::int AS song_count,
              COALESCE(SUM(t.duration), 0)::int AS duration,
              MIN(CASE WHEN t.cover_path IS NOT NULL THEN 'tr-' || t.id::text WHEN al.cover_path IS NOT NULL THEN 'al-' || al.id::text END) AS cover_art
       FROM playlists p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id AND t.missing_since IS NULL
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE p.id = $1 AND (p.owner_id = $2 OR p.is_public = true OR $3 = true)
       GROUP BY p.id, p.name, p.comment, p.is_public, p.created_at, p.updated_at, u.username`,
      [id, userId, Boolean(req.subsonicUser.is_admin)]
    );

    const playlist = pRows[0];
    if (!playlist) return notFound(reply, req, 'Playlist');

    const { rows: songRows } = await query(
      `${songSelectSql(userId)}
       JOIN playlist_tracks pt ON pt.track_id = t.id
       WHERE pt.playlist_id = $1 AND t.missing_since IS NULL
       ORDER BY pt.track_order ASC, pt.id ASC`,
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
    const songIds = playlistSongIds(params.songId);

    if (name.length > 200) return sendError(reply, req, ErrorCode.GENERIC, 'Playlist name too long');
    const pl = await transaction(async client => {
      ids(songIds);
      await checkTracks(client, songIds);
      const { rows } = await client.query(
        'INSERT INTO playlists (name, owner_id, is_public) VALUES ($1, $2, $3) RETURNING *',
        [name, userId, params.public === true || params.public === 'true']);
      await appendTracks(client, rows[0].id, songIds);
      return rows[0];
    });

    const { rows: songRows } = await query(
      `${songSelectSql(userId)}
       JOIN playlist_tracks pt ON pt.track_id = t.id
       WHERE pt.playlist_id = $1 AND t.missing_since IS NULL
       ORDER BY pt.track_order ASC, pt.id ASC`,
      [pl.id]
    );

    return sendOk(reply, req, {
      playlist: formatPlaylist({ ...pl, owner_username: req.subsonicUser.username }, songRows),
    });
  });

  endpoint('updatePlaylist', async (req, reply, params) => {
    const playlistId = parseId(params.playlistId);
    if (!playlistId) return missing(reply, req, 'playlistId');

    await transaction(async client => {
      await lockPlaylist(client, playlistId, req.subsonicUser);
      if (params.name !== undefined && params.name !== '') {
        if (typeof params.name !== 'string' || !params.name.trim() || params.name.length > 200) {
          throw Object.assign(new Error('Invalid playlist name'), { statusCode: 400 });
        }
        await client.query('UPDATE playlists SET name = $1 WHERE id = $2', [params.name.trim(), playlistId]);
      }
      if (params.comment !== undefined) {
        if (typeof params.comment !== 'string' || params.comment.length > 5000) throw badRequest('Invalid comment');
        await client.query('UPDATE playlists SET comment = $1 WHERE id = $2', [params.comment, playlistId]);
      }
      if (params.public !== undefined) {
        if (![true, false, 'true', 'false'].includes(params.public)) throw badRequest('Invalid public flag');
        await client.query('UPDATE playlists SET is_public = $1 WHERE id = $2', [params.public === true || params.public === 'true', playlistId]);
      }
      // Subsonic indices are zero-based, unlike entity IDs.
      const raw = params.songIndexToRemove;
      const toRemove = raw == null || raw === '' ? [] : (Array.isArray(raw) ? raw : String(raw).split(',')).map(Number);
      if (toRemove.some(i => !Number.isSafeInteger(i) || i < 0)) throw badRequest('Invalid track index');
      if (toRemove.length) {
        const { rows } = await client.query('SELECT id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY track_order, id', [playlistId]);
        if (toRemove.some(i => i >= rows.length)) throw badRequest('Invalid track index');
        await client.query('DELETE FROM playlist_tracks WHERE id = ANY($1::int[])', [toRemove.map(i => rows[i].id)]);
      }
      const toAdd = playlistSongIds(params.songIdToAdd);
      await appendTracks(client, playlistId, toAdd);
      await client.query('UPDATE playlists SET updated_at = NOW() WHERE id = $1', [playlistId]);
    });

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
      await transaction(async (client) => {
        const res = await client.query(
          'UPDATE tracks SET play_count = play_count + 1, last_played_at = NOW() WHERE id = $1 RETURNING id',
          [id]
        );
        if (res.rowCount === 0) {
          const err = new Error('Song not found');
          err.statusCode = 404;
          throw err;
        }
        await client.query(
          'INSERT INTO play_history (user_id, track_id, played_at) VALUES ($1, $2, NOW())',
          [req.subsonicUser.id, id]
        );
      });
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

    const { rows } = await query('SELECT file_path, format, missing_since FROM tracks WHERE id = $1', [id]);
    if (!rows[0] || rows[0].missing_since || !fs.existsSync(rows[0].file_path)) {
      return reply.status(404).send('Not found');
    }
    return sendAudioFile(req, reply, rows[0].file_path, rows[0].format);
  };

  endpoint('stream', streamHandler);
  endpoint('download', streamHandler);

  endpoint('getCoverArt', async (req, reply, params) => {
    if (!params.id) return missing(reply, req, 'id');

    const file = await coverFileFromPath(await resolveCoverPath(params.id));
    if (!file) return reply.status(404).send('Not found');

    return sendCoverFile(req, reply, file, params.size);
  });

  // ---- Play Queue ----

  endpoint('savePlayQueue', async (req, reply, params) => {
    const rawIds = params.id;
    const trackIds = parseIdList(rawIds);
    if (trackIds.length === 0) return missing(reply, req, 'id');

    const currentTrackId = parseId(params.current);
    const position = params.position != null ? parseInt(params.position, 10) : 0;
    const client = params.c || req.subsonicUser.username || '';

    await query(
      `INSERT INTO play_queues (user_id, current_track_id, position_ms, track_ids, changed_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         current_track_id = EXCLUDED.current_track_id,
         position_ms = EXCLUDED.position_ms,
         track_ids = EXCLUDED.track_ids,
         changed_by = EXCLUDED.changed_by,
         updated_at = NOW()`,
      [req.subsonicUser.id, Number.isFinite(currentTrackId) ? currentTrackId : null, Math.max(0, position), trackIds, client]
    );

    return sendOk(reply, req);
  });

  endpoint('getPlayQueue', async (req, reply) => {
    const qRes = await query('SELECT * FROM play_queues WHERE user_id = $1', [req.subsonicUser.id]);
    const queue = qRes.rows[0];
    if (!queue || !queue.track_ids || queue.track_ids.length === 0) {
      return sendOk(reply, req, {
        playQueue: {
          username: req.subsonicUser.username,
          current: queue?.current_track_id != null ? String(queue.current_track_id) : undefined,
          position: queue?.position_ms != null ? Number(queue.position_ms) : 0,
          changed: queue?.updated_at ? new Date(queue.updated_at).toISOString() : new Date().toISOString(),
          changedBy: queue?.changed_by || undefined,
          entry: [],
        },
      });
    }

    const { rows: songs } = await query(
      `${songSelectSql(req.subsonicUser.id)} WHERE t.id = ANY($1::int[]) AND t.missing_since IS NULL`,
      [queue.track_ids]
    );

    const songMap = new Map(songs.map((s) => [Number(s.id), s]));
    const orderedSongs = queue.track_ids.map((id) => songMap.get(Number(id))).filter(Boolean);
    const activeCurrent =
      queue.current_track_id != null && songMap.has(Number(queue.current_track_id))
        ? queue.current_track_id
        : orderedSongs[0]?.id ?? null;

    return sendOk(reply, req, {
      playQueue: formatPlayQueue({ ...queue, current_track_id: activeCurrent, username: req.subsonicUser.username }, orderedSongs),
    });
  });

  // ---- Bookmarks ----

  endpoint('getBookmarks', async (req, reply) => {
    const { rows } = await query(
      `SELECT b.position_ms, b.comment, b.created_at, b.updated_at, u.username,
              t.id, t.title, t.file_name, t.file_path, t.file_size, t.duration,
              t.track_number, t.disc_number, t.year, t.genre, t.bitrate, t.sample_rate,
              t.format, t.cover_path, t.created_at AS track_created_at, t.album_id, t.artist_id, t.play_count,
              al.title AS album_title, al.year AS album_year, al.genre AS album_genre,
              al.cover_path AS album_cover, a.name AS artist_name,
              st.created_at AS starred_at, ur.rating AS user_rating
       FROM bookmarks b
       JOIN users u ON u.id = b.user_id
       JOIN tracks t ON t.id = b.track_id AND t.missing_since IS NULL
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN user_starred_tracks st ON st.track_id = t.id AND st.user_id = $1
       LEFT JOIN user_ratings ur ON ur.entity_type = 'track' AND ur.entity_id = t.id AND ur.user_id = $1
       WHERE b.user_id = $1
       ORDER BY b.updated_at DESC`,
      [req.subsonicUser.id]
    );

    return sendOk(reply, req, {
      bookmarks: {
        bookmark: rows.map((r) => formatBookmark(r, r)),
      },
    });
  });

  endpoint('createBookmark', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Track');
    if (id === null) return;

    const position = params.position != null ? parseInt(params.position, 10) : 0;
    const comment = params.comment ? String(params.comment) : null;

    const { rows: trackRows } = await query('SELECT id FROM tracks WHERE id = $1 AND missing_since IS NULL', [id]);
    if (!trackRows[0]) return notFound(reply, req, 'Track');

    await query(
      `INSERT INTO bookmarks (user_id, track_id, position_ms, comment, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (user_id, track_id) DO UPDATE SET
         position_ms = EXCLUDED.position_ms,
         comment = EXCLUDED.comment,
         updated_at = NOW()`,
      [req.subsonicUser.id, id, Math.max(0, position), comment]
    );

    return sendOk(reply, req);
  });

  endpoint('deleteBookmark', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Track');
    if (id === null) return;

    await query('DELETE FROM bookmarks WHERE user_id = $1 AND track_id = $2', [req.subsonicUser.id, id]);
    return sendOk(reply, req);
  });

  // ---- Discovery & Recommendations (Random, Top, Similar, Now Playing) ----

  endpoint('getRandomSongs', async (req, reply, params) => {
    const size = Math.min(Math.max(parseInt(params.size, 10) || 10, 1), 500);
    const genre = params.genre ? String(params.genre).trim() : null;
    const fromYear = params.fromYear != null && params.fromYear !== '' ? parseInt(params.fromYear, 10) : null;
    const toYear = params.toYear != null && params.toYear !== '' ? parseInt(params.toYear, 10) : null;

    const conds = ['t.missing_since IS NULL'];
    const values = [size];
    let idx = 2;

    if (genre) {
      conds.push(`(LOWER(t.genre) = LOWER($${idx}) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(t.metadata->'genres','[]'::jsonb)) g WHERE LOWER(g)=LOWER($${idx})))`);
      values.push(genre);
      idx++;
    }
    if (fromYear != null && !Number.isNaN(fromYear)) {
      conds.push(`(COALESCE(t.year, al.year) >= $${idx})`);
      values.push(fromYear);
      idx++;
    }
    if (toYear != null && !Number.isNaN(toYear)) {
      conds.push(`(COALESCE(t.year, al.year) <= $${idx})`);
      values.push(toYear);
      idx++;
    }

    const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const sql = `
      ${songSelectSql(req.subsonicUser.id)}
      ${whereClause}
      ORDER BY RANDOM()
      LIMIT $1
    `;

    const { rows } = await query(sql, values);
    return sendOk(reply, req, {
      randomSongs: {
        song: rows.map(formatSong),
      },
    });
  });

  endpoint('getTopSongs', async (req, reply, params) => {
    const count = Math.min(Math.max(parseInt(params.count, 10) || 50, 1), 500);
    let artistId = parseId(params.id);
    const artistName = params.artist ? String(params.artist).trim() : null;

    if ((artistId == null || Number.isNaN(artistId)) && !artistName) {
      return missing(reply, req, 'artist');
    }

    let whereClause = '';
    const values = [count];

    if (Number.isFinite(artistId)) {
      whereClause = 'WHERE t.artist_id = $2 AND t.missing_since IS NULL';
      values.push(artistId);
    } else {
      whereClause = 'WHERE LOWER(a.name) = LOWER($2) AND t.missing_since IS NULL';
      values.push(artistName);
    }

    const sql = `
      ${songSelectSql(req.subsonicUser.id)}
      ${whereClause}
      ORDER BY COALESCE(t.play_count, 0) DESC, t.id ASC
      LIMIT $1
    `;

    const { rows } = await query(sql, values);
    return sendOk(reply, req, {
      topSongs: {
        song: rows.map(formatSong),
      },
    });
  });

  async function handleSimilarSongs(req, reply, params, key) {
    const count = Math.min(Math.max(parseInt(params.count, 10) || 50, 1), 500);
    const id = parseId(params.id);
    if (id == null || Number.isNaN(id)) {
      return sendOk(reply, req, { [key]: { song: [] } });
    }

    const { rows: tRows } = await query('SELECT artist_id, genre FROM tracks WHERE id = $1', [id]);
    let targetArtistId = tRows[0]?.artist_id || null;
    let targetGenre = tRows[0]?.genre || null;

    if (!targetArtistId) {
      const { rows: aRows } = await query('SELECT id FROM artists WHERE id = $1', [id]);
      if (aRows[0]) targetArtistId = aRows[0].id;
    }

    const conds = [`t.id != ${id}`, 't.missing_since IS NULL'];
    if (targetGenre) {
      conds.push(`(LOWER(t.genre) = LOWER('${targetGenre.replace(/'/g, "''")}') OR t.artist_id = ${targetArtistId || 0})`);
    } else if (targetArtistId) {
      conds.push(`t.artist_id = ${targetArtistId}`);
    }

    const sql = `
      ${songSelectSql(req.subsonicUser.id)}
      WHERE ${conds.join(' AND ')}
      ORDER BY RANDOM()
      LIMIT $1
    `;

    const { rows } = await query(sql, [count]);
    return sendOk(reply, req, {
      [key]: {
        song: rows.map(formatSong),
      },
    });
  }

  endpoint('getSimilarSongs', (req, reply, params) => handleSimilarSongs(req, reply, params, 'similarSongs'));
  endpoint('getSimilarSongs2', (req, reply, params) => handleSimilarSongs(req, reply, params, 'similarSongs2'));

  endpoint('getNowPlaying', async (req, reply) => {
    const { rows } = await query(
      `SELECT ph.played_at, u.username, u.id AS player_id,
              t.id, t.title, t.file_name, t.file_path, t.file_size, t.duration,
              t.track_number, t.disc_number, t.year, t.genre, t.bitrate, t.sample_rate,
              t.format, t.cover_path, t.created_at, t.album_id, t.artist_id, t.play_count,
              t.track_artist_credit, t.metadata,
              al.title AS album_title, al.year AS album_year, al.genre AS album_genre,
              al.cover_path AS album_cover, a.name AS artist_name,
              st.created_at AS starred_at, ur.rating AS user_rating
       FROM play_history ph
       JOIN users u ON u.id = ph.user_id
       JOIN tracks t ON t.id = ph.track_id AND t.missing_since IS NULL
       LEFT JOIN albums al ON t.album_id = al.id
       LEFT JOIN artists a ON t.artist_id = a.id
       LEFT JOIN user_starred_tracks st ON st.track_id = t.id AND st.user_id = $1
       LEFT JOIN user_ratings ur ON ur.entity_type = 'track' AND ur.entity_id = t.id AND ur.user_id = $1
       WHERE ph.played_at > NOW() - INTERVAL '1 hour'
       ORDER BY ph.played_at DESC
       LIMIT 50`,
      [req.subsonicUser.id]
    );

    const entries = rows.map((r) => {
      const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(r.played_at).getTime()) / 60000));
      return {
        ...formatSong(r),
        username: r.username,
        minutesAgo,
        playerId: r.player_id,
      };
    });

    return sendOk(reply, req, {
      nowPlaying: {
        entry: entries,
      },
    });
  });

  // ---- Lyrics ----

  endpoint('getLyrics', async (req, reply, params) => {
    const artist = params.artist ? String(params.artist).trim() : '';
    const title = params.title ? String(params.title).trim() : '';

    if (!title && !artist) return missing(reply, req, 'title');

    const { rows } = await query(
      `SELECT t.id, t.title, t.file_path, COALESCE(t.track_artist_credit, a.name) AS artist_name
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE t.missing_since IS NULL
         AND ($1 = '' OR LOWER(t.title) LIKE LOWER($1))
         AND ($2 = '' OR LOWER(a.name) LIKE LOWER($2) OR LOWER(t.track_artist_credit) LIKE LOWER($2))
       LIMIT 1`,
      [title ? `%${title}%` : '', artist ? `%${artist}%` : '']
    );

    const track = rows[0];
    if (!track) return sendOk(reply, req, { lyrics: { artist, title, value: '' } });

    const parsed = await loadTrackLyrics(track.file_path);
    const value = parsed ? parsed.lines.map((l) => l.value).join('\n') : '';

    return sendOk(reply, req, {
      lyrics: {
        artist: track.artist_name || artist,
        title: track.title || title,
        value,
      },
    });
  });

  endpoint('getLyricsBySongId', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Track');
    if (id === null) return;

    const { rows } = await query(
      `SELECT t.id, t.title, t.file_path, COALESCE(t.track_artist_credit, a.name) AS artist_name
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE t.id = $1 AND t.missing_since IS NULL`,
      [id]
    );

    const track = rows[0];
    if (!track) return notFound(reply, req, 'Track');

    const parsed = await loadTrackLyrics(track.file_path);
    if (!parsed || parsed.lines.length === 0) {
      return sendOk(reply, req, {
        lyricsList: {
          structuredLyrics: [],
        },
      });
    }

    return sendOk(reply, req, {
      lyricsList: {
        structuredLyrics: [
          {
            lang: 'xxx',
            synced: parsed.synced,
            displayArtist: track.artist_name || '',
            displayTitle: track.title || '',
            line: parsed.lines,
          },
        ],
      },
    });
  });

  // ---- Artist & Album Info ----

  endpoint('getArtistInfo', async (req, reply) => {
    return sendOk(reply, req, { artistInfo: {} });
  });

  endpoint('getArtistInfo2', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Artist');
    if (id === null) return;

    const count = Math.min(Math.max(parseInt(params.count, 10) || 20, 1), 100);

    const { rows: aRows } = await query(`SELECT a.*, (SELECT MIN(al.id) FROM albums al WHERE (al.artist_id = a.id OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks member ON member.id=c.track_id WHERE c.artist_id=a.id AND member.album_id=al.id AND member.missing_since IS NULL)) AND al.cover_path IS NOT NULL AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id=al.id AND t.missing_since IS NULL)) AS sample_album_id FROM artists a WHERE a.id = $1`, [id]);
    const artist = aRows[0];
    if (!artist) return notFound(reply, req, 'Artist');

    const { rows: simRows } = await query(
      `SELECT a2.id, a2.name,
              COUNT(DISTINCT al.id)::int AS album_count,
              MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
              sar.created_at AS starred_at,
              ur.rating AS user_rating
       FROM artists a2
       LEFT JOIN albums al ON al.artist_id = a2.id AND EXISTS (SELECT 1 FROM tracks tr WHERE tr.album_id = al.id AND tr.missing_since IS NULL)
       LEFT JOIN user_starred_artists sar ON sar.artist_id = a2.id AND sar.user_id = $1
       LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a2.id AND ur.user_id = $1
       WHERE a2.id != $2
         AND a2.id IN (
           SELECT DISTINCT t.artist_id
           FROM tracks t
           WHERE t.missing_since IS NULL
             AND t.genre IN (SELECT DISTINCT genre FROM tracks WHERE artist_id = $2 AND genre IS NOT NULL AND missing_since IS NULL)
         )
       GROUP BY a2.id, a2.name, sar.created_at, ur.rating
       ORDER BY RANDOM()
       LIMIT $3`,
      [req.subsonicUser.id, id, count]
    );

    const similar = simRows.map(formatArtist);

    return sendOk(reply, req, {
      artistInfo2: {
        biography: '',
        musicBrainzId: artist.musicbrainz_id || '',
        lastFmUrl: '',
        smallImageUrl: artist.sample_album_id ? `/api/cover/artist/${artist.id}` : undefined,
        mediumImageUrl: artist.sample_album_id ? `/api/cover/artist/${artist.id}` : undefined,
        largeImageUrl: artist.sample_album_id ? `/api/cover/artist/${artist.id}` : undefined,
        similarArtist: similar,
      },
    });
  });

  endpoint('getAlbumInfo2', async (req, reply, params) => {
    const id = requireId(reply, req, params, 'Album');
    if (id === null) return;

    const { rows } = await query('SELECT * FROM albums WHERE id = $1', [id]);
    if (!rows[0]) return notFound(reply, req, 'Album');

    return sendOk(reply, req, {
      albumInfo: {
        notes: '',
        musicBrainzId: rows[0].musicbrainz_id || '',
        lastFmUrl: '',
        smallImageUrl: rows[0].cover_path ? `/api/cover/album/${id}` : undefined,
        mediumImageUrl: rows[0].cover_path ? `/api/cover/album/${id}` : undefined,
        largeImageUrl: rows[0].cover_path ? `/api/cover/album/${id}` : undefined,
      },
    });
  });

  // ---- Library Scanning & User Profile ----

  endpoint('getScanStatus', async (req, reply) => {
    const state = getScanState();
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM tracks WHERE missing_since IS NULL');
    return sendOk(reply, req, {
      scanStatus: {
        scanning: Boolean(state.isScanning),
        count: Number(rows[0]?.count || 0),
      },
    });
  });

  endpoint('startScan', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const full = params.full === 'true' || params.full === '1';
    startScanInBackground({ full });
    const state = getScanState();
    const { rows } = await query('SELECT COUNT(*)::int AS count FROM tracks WHERE missing_since IS NULL');
    return sendOk(reply, req, {
      scanStatus: {
        scanning: Boolean(state.isScanning),
        count: Number(rows[0]?.count || 0),
      },
    });
  });

  endpoint('getAvatar', async (req, reply, params) => {
    const username = params.username;
    if (!username) return missing(reply, req, 'username');
    const { rows } = await query('SELECT username FROM users WHERE username = $1', [username]);
    if (!rows[0]) return notFound(reply, req, 'User');
    const initial = (rows[0].username || 'U')[0].toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="64" fill="#3b82f6"/><text x="50%" y="54%" text-anchor="middle" dy=".3em" fill="#fff" font-family="sans-serif" font-weight="bold" font-size="64">${initial}</text></svg>`;
    reply.type('image/svg+xml').send(svg);
  });

  // ---- Internet Radio ----

  endpoint('getInternetRadioStations', async (req, reply) => {
    const { rows } = await query('SELECT * FROM internet_radio_stations ORDER BY name ASC');
    return sendOk(reply, req, {
      internetRadioStations: {
        internetRadioStation: rows.map(formatInternetRadioStation),
      },
    });
  });

  endpoint('createInternetRadioStation', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const streamUrl = params.streamUrl;
    const name = params.name;
    const homepageUrl = params.homepageUrl || null;
    if (!streamUrl) return missing(reply, req, 'streamUrl');
    if (!name) return missing(reply, req, 'name');

    await query(
      'INSERT INTO internet_radio_stations (name, stream_url, homepage_url) VALUES ($1, $2, $3)',
      [name, streamUrl, homepageUrl]
    );
    return sendOk(reply, req);
  });

  endpoint('updateInternetRadioStation', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const id = requireId(reply, req, params, 'Station');
    if (id === null) return;
    const streamUrl = params.streamUrl;
    const name = params.name;
    const homepageUrl = params.homepageUrl || null;
    if (!streamUrl) return missing(reply, req, 'streamUrl');
    if (!name) return missing(reply, req, 'name');

    const res = await query(
      'UPDATE internet_radio_stations SET name = $1, stream_url = $2, homepage_url = $3, updated_at = NOW() WHERE id = $4',
      [name, streamUrl, homepageUrl, id]
    );
    if (res.rowCount === 0) return notFound(reply, req, 'Station');
    return sendOk(reply, req);
  });

  endpoint('deleteInternetRadioStation', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const id = requireId(reply, req, params, 'Station');
    if (id === null) return;

    await query('DELETE FROM internet_radio_stations WHERE id = $1', [id]);
    return sendOk(reply, req);
  });

  // ---- Podcasts & Jukebox ----

  endpoint('jukeboxControl', async (req, reply) => {
    return sendError(reply, req, ErrorCode.GENERIC, 'jukebox not enabled');
  });

  endpoint('getPodcasts', async (req, reply, params) => {
    const id = parseId(params.id);
    const includeEpisodes = params.includeEpisodes !== 'false';

    let sql = 'SELECT * FROM podcasts';
    const values = [];
    if (Number.isFinite(id)) {
      sql += ' WHERE id = $1';
      values.push(id);
    }
    sql += ' ORDER BY title ASC';

    const { rows: podcasts } = await query(sql, values);
    if (podcasts.length === 0) {
      return sendOk(reply, req, { podcasts: { channel: [] } });
    }

    let episodesMap = {};
    if (includeEpisodes) {
      const pIds = podcasts.map((p) => p.id);
      const { rows: epRows } = await query(
        'SELECT * FROM podcast_episodes WHERE podcast_id = ANY($1::int[]) ORDER BY publish_date DESC',
        [pIds]
      );
      for (const ep of epRows) {
        if (!episodesMap[ep.podcast_id]) episodesMap[ep.podcast_id] = [];
        episodesMap[ep.podcast_id].push(ep);
      }
    }

    return sendOk(reply, req, {
      podcasts: {
        channel: podcasts.map((p) => formatPodcast(p, episodesMap[p.id] || [])),
      },
    });
  });

  endpoint('getNewestPodcasts', async (req, reply, params) => {
    const count = Math.min(Math.max(parseInt(params.count, 10) || 10, 1), 100);
    const { rows } = await query(
      'SELECT * FROM podcast_episodes ORDER BY COALESCE(publish_date, created_at) DESC LIMIT $1',
      [count]
    );
    return sendOk(reply, req, {
      newestPodcasts: {
        episode: rows.map(formatPodcastEpisode),
      },
    });
  });

  endpoint('createPodcastChannel', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const url = params.url;
    if (!url) return missing(reply, req, 'url');

    await query(
      `INSERT INTO podcasts (url, title, description, cover_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (url) DO NOTHING`,
      [url, url, 'Podcast feed', null]
    );
    return sendOk(reply, req);
  });

  endpoint('deletePodcastChannel', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const id = requireId(reply, req, params, 'Podcast');
    if (id === null) return;

    await query('DELETE FROM podcasts WHERE id = $1', [id]);
    return sendOk(reply, req);
  });

  endpoint('refreshPodcasts', async (req, reply) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    return sendOk(reply, req);
  });

  endpoint('downloadPodcastEpisode', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const id = requireId(reply, req, params, 'Episode');
    if (id === null) return;
    return sendOk(reply, req);
  });

  endpoint('deletePodcastEpisode', async (req, reply, params) => {
    if (!req.subsonicUser.is_admin) {
      return sendError(reply, req, ErrorCode.NOT_AUTHORIZED, 'User not admin');
    }
    const id = requireId(reply, req, params, 'Episode');
    if (id === null) return;
    await query('DELETE FROM podcast_episodes WHERE id = $1', [id]);
    return sendOk(reply, req);
  });

  // ---- Unknown endpoints ----

  fastify.route({
    method: ['GET', 'POST'],
    url: '/rest/*',
    handler: async (req, reply) => {
      const name = req.url.split('?')[0].replace(/^\/rest\//, '');
      return sendError(reply, req, ErrorCode.NOT_FOUND, `View not found: ${name}`);
    },
  });
}
