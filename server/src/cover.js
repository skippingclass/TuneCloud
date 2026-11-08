import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseFile, selectCover } from 'music-metadata';
import sharp from 'sharp';
import { query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || path.join(__dirname, '../covers'));
const COVER_NAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'Cover.jpg', 'Cover.png',
  'folder.jpg', 'folder.png', 'Folder.jpg', 'Folder.png',
  'front.jpg', 'front.png', 'Front.jpg',
  'album.jpg', 'album.png', 'Album.jpg',
  'artwork.jpg', 'Artwork.jpg',
];
const COVER_CONCURRENCY = 4;
const coverJobs = new Map();

export function coverContentType(file) {
  return ({ '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp' })[path.extname(file).toLowerCase()] || 'image/jpeg';
}

export async function sendCoverFile(req, reply, file, size) {
  if (size !== undefined) {
    const pixels = Number(size);
    if (!Number.isInteger(pixels) || pixels < 1 || pixels > 2048) return reply.code(400).send({ error: 'Image size must be between 1 and 2048' });
    try {
      const buffer = await sharp(file, { limitInputPixels: 64000000 }).rotate().resize(pixels, pixels, { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
      return reply.header('Cache-Control', 'no-cache').type('image/jpeg').send(buffer);
    } catch { return reply.code(404).send({ error: 'Image cannot be decoded' }); }
  }
  reply.header('Cache-Control', 'no-cache').header('Cross-Origin-Resource-Policy', 'cross-origin');
  return reply.type(coverContentType(file)).send(fs.createReadStream(file));
}

// Validate the final file, not just its parent: artwork may be a symlink.
export async function resolveCoverFile(filePath, { allowMusic = false } = {}) {
  try {
    const physical = await fsp.realpath(filePath);
    if (!(await fsp.stat(physical)).isFile()) return null;
    const roots = [COVERS_DIR, ...(allowMusic && process.env.MUSIC_DIR ? [process.env.MUSIC_DIR] : [])];
    for (const dir of roots) {
      try {
        const rel = path.relative(await fsp.realpath(dir), physical);
        if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return physical;
      } catch { /* A missing cache directory must not block music-folder artwork. */ }
    }
  } catch { /* Missing, unreadable or dangling artwork: try the next candidate. */ }
  return null;
}

export async function initCoversDir() {
  await fsp.mkdir(COVERS_DIR, { recursive: true });
}

async function saveCoverBuffer(buffer, format, prefix) {
  const ext = format?.split('/')[1] || 'jpg';
  const filename = `${prefix}.${ext}`;
  const targetPath = path.join(COVERS_DIR, filename);
  const staged = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(staged, buffer); await fsp.rename(staged, targetPath); }
  finally { await fsp.unlink(staged).catch(() => {}); }

  for (const altExt of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']) {
    if (altExt !== ext) {
      try { await fsp.unlink(path.join(COVERS_DIR, `${prefix}.${altExt}`)); } catch {}
    }
  }

  const version = crypto.createHash('sha256').update(buffer).digest('hex');
  return `/api/cover/${filename}?v=${version}`;
}

async function deleteCoverFile(prefix) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']) {
    try { await fsp.unlink(path.join(COVERS_DIR, `${prefix}.${ext}`)); } catch {}
  }
}

export async function deleteTrackCover(trackId) {
  return deleteCoverFile(`track_${trackId}`);
}

async function setAlbumCover(albumId, url) {
  await query('UPDATE albums SET cover_path = $1 WHERE id = $2', [url, albumId]);
  return url;
}

// Prefer the shared album directory for multi-disc releases, then each disc.
function coverDirectories(tracks) {
  const dirs = tracks.map(t => path.dirname(t.file_path));
  return [...new Set([
    ...dirs.map(dir => /^(cd|disc|disk)\s*\d+$/i.test(path.basename(dir)) ? path.dirname(dir) : dir),
    ...dirs,
  ])];
}

async function readFolderCover(tracks) {
  for (const dir of coverDirectories(tracks)) {
    for (const name of COVER_NAMES) {
      const file = await resolveCoverFile(path.join(dir, name), { allowMusic: true });
      if (!file) continue;
      const buffer = await fsp.readFile(file);
      if (!buffer.length) continue;
      return {
        buffer,
        format: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        hash: crypto.createHash('md5').update(buffer).digest('hex'),
      };
    }
  }
  return null;
}

function folderStatePath(albumId) {
  return path.join(COVERS_DIR, `album_${albumId}.folder.json`);
}

// Compare sidecar artwork independently of audio mtimes. Older caches are refreshed once.
export async function findAlbumsWithChangedFolderCovers() {
  const { rows } = await query(
    'SELECT album_id, file_path FROM tracks WHERE album_id IS NOT NULL AND missing_since IS NULL ORDER BY track_number ASC, file_path ASC'
  );
  const albums = new Map();
  for (const track of rows) {
    if (!albums.has(track.album_id)) albums.set(track.album_id, []);
    albums.get(track.album_id).push(track);
  }
  const changed = [];
  for (const [id, tracks] of albums) {
    try {
      const folder = await readFolderCover(tracks);
      const state = JSON.parse(await fsp.readFile(folderStatePath(id), 'utf8'));
      if (state.hash !== (folder?.hash ?? null)) changed.push(id);
    } catch {
      changed.push(id);
    }
  }
  return changed;
}

/**
 * Extracts and resolves covers for an album and all of its tracks:
 * 1. Checks folder image files (cover.jpg, folder.jpg, etc.)
 * 2. Reads embedded pictures from all album tracks and computes hashes
 * 3. The majority consensus picture (or folder image) becomes the Album Cover
 * 4. Tracks whose embedded picture matches the album cover inherit it (tracks.cover_path = NULL)
 * 5. Tracks with unique artwork get their own file (track_${trackId}.${ext}) and tracks.cover_path
 */
export async function extractCoversForAlbum(albumId) {
  const previous = coverJobs.get(albumId) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => extractAlbumArtwork(albumId));
  coverJobs.set(albumId, job);
  try { return await job; }
  finally { if (coverJobs.get(albumId) === job) coverJobs.delete(albumId); }
}

async function extractAlbumArtwork(albumId) {
  if (!albumId) return null;
  const { rows: tracks } = await query(
    'SELECT id, file_path FROM tracks WHERE album_id = $1 AND missing_since IS NULL ORDER BY track_number ASC, file_path ASC',
    [albumId]
  );
  if (tracks.length === 0) return null;

  // 1. Check shared album and disc directories for sidecar artwork.
  const folderCover = await readFolderCover(tracks);
  const folderCoverBuffer = folderCover?.buffer;
  const folderCoverFormat = folderCover?.format;
  const folderCoverHash = folderCover?.hash;

  // 2. Scan tracks for embedded artwork
  const readableTracks = new Set();
  const trackPictures = new Map(); // trackId -> { buffer, format, hash }
  const hashCounts = new Map();   // hash -> { count, buffer, format }

  for (const t of tracks) {
    try {
      const meta = await parseFile(t.file_path, { skipCovers: false });
      readableTracks.add(t.id);
      const pic = selectCover(meta.common?.picture);
      if (pic && pic.data && pic.data.length > 0) {
        const hash = crypto.createHash('md5').update(pic.data).digest('hex');
        trackPictures.set(t.id, { buffer: pic.data, format: pic.format, hash });
        const existing = hashCounts.get(hash);
        if (existing) {
          existing.count++;
        } else {
          hashCounts.set(hash, { count: 1, buffer: pic.data, format: pic.format });
        }
      }
    } catch {}
  }

  // 3. Determine consensus Album Cover:
  // - If folder cover exists, it is the primary album cover
  // - Otherwise, the majority hash among track pictures wins
  let albumCoverHash = null;
  let albumCoverBuffer = null;
  let albumCoverFormat = null;

  if (folderCoverHash) {
    albumCoverHash = folderCoverHash;
    albumCoverBuffer = folderCoverBuffer;
    albumCoverFormat = folderCoverFormat;
  } else if (hashCounts.size > 0) {
    let maxCount = -1;
    for (const [hash, entry] of hashCounts.entries()) {
      if (entry.count > maxCount) {
        maxCount = entry.count;
        albumCoverHash = hash;
        albumCoverBuffer = entry.buffer;
        albumCoverFormat = entry.format;
      }
    }
  }

  // Save album cover
  if (albumCoverBuffer) {
    const albumCoverUrl = await saveCoverBuffer(albumCoverBuffer, albumCoverFormat, `album_${albumId}`);
    await setAlbumCover(albumId, albumCoverUrl);
  } else if (readableTracks.size === tracks.length) {
    // Only clear artwork when every live member was read successfully.
    await setAlbumCover(albumId, null);
    await deleteCoverFile(`album_${albumId}`);
  }

  // 4. Classify track-level covers:
  for (const t of tracks) {
    if (!readableTracks.has(t.id)) continue; // Preserve cached artwork for offline/unreadable files.
    const pic = trackPictures.get(t.id);
    if (!pic) {
      // No embedded art -> inherits album cover
      await query('UPDATE tracks SET cover_path = NULL WHERE id = $1', [t.id]);
      await deleteCoverFile(`track_${t.id}`);
    } else if (albumCoverHash && pic.hash === albumCoverHash) {
      // Artwork matches album cover -> inherits album cover, no redundant file
      await query('UPDATE tracks SET cover_path = NULL WHERE id = $1', [t.id]);
      await deleteCoverFile(`track_${t.id}`);
    } else {
      // Artwork is UNIQUE to this track! Save track-level cover
      const trackCoverUrl = await saveCoverBuffer(pic.buffer, pic.format, `track_${t.id}`);
      await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [trackCoverUrl, t.id]);
    }
  }

  if (readableTracks.size === tracks.length) {
    await fsp.writeFile(folderStatePath(albumId), JSON.stringify({ hash: folderCoverHash ?? null }));
  }
  return Boolean(albumCoverBuffer);
}

export async function extractCoverForAlbum(albumId) {
  return extractCoversForAlbum(albumId);
}

export async function extractAlbumCover(albumId, trackDir) {
  return extractCoversForAlbum(albumId);
}

export async function extractCoverFromTrack(filePath, albumId) {
  if (albumId) return extractCoversForAlbum(albumId);
  return null;
}

export async function extractCoverForTrack(trackId) {
  const { rows } = await query('SELECT id, file_path, album_id FROM tracks WHERE id = $1', [trackId]);
  if (!rows[0]) return null;
  const t = rows[0];
  if (t.album_id) {
    await extractCoversForAlbum(t.album_id);
    const updated = await query('SELECT cover_path FROM tracks WHERE id = $1', [trackId]);
    return updated.rows[0]?.cover_path || null;
  }
  try {
    const meta = await parseFile(t.file_path, { skipCovers: false });
    const pic = selectCover(meta.common?.picture);
    if (pic && pic.data?.length > 0) {
      const url = await saveCoverBuffer(pic.data, pic.format, `track_${t.id}`);
      await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [url, t.id]);
      return url;
    }
    await query('UPDATE tracks SET cover_path = NULL WHERE id = $1', [t.id]);
    await deleteTrackCover(t.id);
  } catch {}
  return null;
}

/**
 * Extracts covers for albums and their tracks.
 * Supports options object { albumIds, force } or legacy albumIds array.
 * When force is true, existing covers are refreshed and overwritten.
 */
export async function extractAllMissingCovers(optionsOrIds = null) {
  let albumIds = null;
  let force = false;
  let onProgress = null;

  if (Array.isArray(optionsOrIds)) {
    albumIds = optionsOrIds;
  } else if (optionsOrIds && typeof optionsOrIds === 'object') {
    albumIds = optionsOrIds.albumIds || null;
    force = Boolean(optionsOrIds.force);
    onProgress = typeof optionsOrIds.onProgress === 'function' ? optionsOrIds.onProgress : null;
  }

  if (albumIds && albumIds.length === 0) return { total: 0, extracted: 0 };

  const whereClause = force ? '' : 'WHERE al.cover_path IS NULL';
  const andClause = albumIds
    ? `${force ? 'WHERE' : 'AND'} al.id = ANY($1::int[])`
    : '';

  const sql = `
    SELECT DISTINCT al.id
    FROM albums al
    JOIN tracks t ON t.album_id = al.id
    ${whereClause} ${andClause}
  `;

  const { rows: albums } = await query(sql, albumIds ? [albumIds] : []);

  let extracted = 0;
  let next = 0;
  const worker = async () => {
    while (next < albums.length) {
      const album = albums[next++];
      try {
        if (await extractCoversForAlbum(album.id)) extracted++;
      } catch (err) {
        console.error(`Cover extraction failed for album ${album.id}: ${err.message}`);
      }
      onProgress?.(extracted, albums.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, albums.length) }, worker));

  // Also handle loose tracks without an album
  if (!albumIds) {
    try {
      const { rows: orphanTracks } = await query(
        `SELECT id, file_path FROM tracks WHERE album_id IS NULL AND missing_since IS NULL ${force ? '' : 'AND cover_path IS NULL'}`
      );
      for (const ot of orphanTracks) {
        try {
          if (await extractCoverForTrack(ot.id)) extracted++;
        } catch {}
      }
    } catch {}
  }

  return { total: albums.length, extracted };
}

export function coverUrl(filename) {
  const filepath = path.join(COVERS_DIR, path.basename(filename.split('?')[0]));
  return fs.existsSync(filepath) ? filepath : null;
}
