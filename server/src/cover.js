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
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'];
const COVER_CONCURRENCY = 2;
const MAX_SCANNED_BLOB_BYTES = 64 * 1024 * 1024;
const coverJobs = new Map();

// Ephemeral cache populated ONLY while `scanDirectory` is actively running so the
// cover phase never re-opens or re-parses thousands of audio files on spinning HDDs.
let scanCoverSessionActive = false;
const scannedTrackMeta = new Map(); // filePath -> { readable, hash, format }
const scannedCoverBlobs = new Map(); // hash -> { buffer, format, samplePath }
let scannedBlobBytes = 0;

export function beginScanCoverSession() {
  scanCoverSessionActive = true;
  scannedTrackMeta.clear();
  scannedCoverBlobs.clear();
  scannedBlobBytes = 0;
}

export function recordScannedTrackCover(filePath, { readable, pic }) {
  if (!scanCoverSessionActive) return;
  if (!readable) {
    scannedTrackMeta.set(filePath, { readable: false, hash: null, format: null });
    return;
  }
  if (!pic || !pic.data || pic.data.length === 0) {
    scannedTrackMeta.set(filePath, { readable: true, hash: null, format: null });
    return;
  }
  const hash = crypto.createHash('md5').update(pic.data).digest('hex');
  const format = pic.format || 'image/jpeg';
  scannedTrackMeta.set(filePath, { readable: true, hash, format });
  if (!scannedCoverBlobs.has(hash)) {
    if (scannedBlobBytes + pic.data.length <= MAX_SCANNED_BLOB_BYTES) {
      scannedCoverBlobs.set(hash, { buffer: pic.data, format, samplePath: filePath });
      scannedBlobBytes += pic.data.length;
    } else {
      scannedCoverBlobs.set(hash, { buffer: null, format, samplePath: filePath });
    }
  }
}

export function endScanCoverSession() {
  scanCoverSessionActive = false;
  scannedTrackMeta.clear();
  scannedCoverBlobs.clear();
  scannedBlobBytes = 0;
}

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
export async function resolveCoverFile(filePath, { allowMusic = false, realRoots = null } = {}) {
  try {
    const physical = await fsp.realpath(filePath);
    if (!(await fsp.stat(physical)).isFile()) return null;
    if (realRoots) {
      for (const realRoot of realRoots) {
        const rel = path.relative(realRoot, physical);
        if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) return physical;
      }
      return null;
    }
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

async function resolveAllowedRoots(allowMusic) {
  const roots = [COVERS_DIR, ...(allowMusic && process.env.MUSIC_DIR ? [process.env.MUSIC_DIR] : [])];
  const resolved = [];
  for (const dir of roots) {
    try { resolved.push(await fsp.realpath(dir)); } catch {}
  }
  return resolved;
}

export async function initCoversDir() {
  await fsp.mkdir(COVERS_DIR, { recursive: true });
}

async function readExistingCoversSet() {
  try {
    return new Set(await fsp.readdir(COVERS_DIR));
  } catch {
    return null;
  }
}

async function saveCoverBuffer(buffer, format, prefix, existingSet = null) {
  const ext = format?.split('/')[1] || 'jpg';
  const filename = `${prefix}.${ext}`;
  const targetPath = path.join(COVERS_DIR, filename);
  const staged = `${targetPath}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(staged, buffer); await fsp.rename(staged, targetPath); }
  finally { await fsp.unlink(staged).catch(() => {}); }
  existingSet?.add(filename);

  for (const altExt of COVER_EXTENSIONS) {
    if (altExt !== ext) {
      const altName = `${prefix}.${altExt}`;
      if (!existingSet || existingSet.has(altName)) {
        try { await fsp.unlink(path.join(COVERS_DIR, altName)); } catch {}
        existingSet?.delete(altName);
      }
    }
  }

  const version = crypto.createHash('sha256').update(buffer).digest('hex');
  return `/api/cover/${filename}?v=${version}`;
}

async function deleteCoverFile(prefix, existingSet = null) {
  for (const ext of COVER_EXTENSIONS) {
    const name = `${prefix}.${ext}`;
    if (!existingSet || existingSet.has(name)) {
      try { await fsp.unlink(path.join(COVERS_DIR, name)); } catch {}
      existingSet?.delete(name);
    }
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

async function getDirectoryNames(dir, dirEntriesCache) {
  if (dirEntriesCache?.has(dir)) return dirEntriesCache.get(dir);
  let set;
  try {
    set = new Set(await fsp.readdir(dir));
  } catch {
    set = new Set();
  }
  dirEntriesCache?.set(dir, set);
  return set;
}

async function readFolderCover(tracks, { dirEntriesCache = null, realRoots = null } = {}) {
  const allowedRoots = realRoots || await resolveAllowedRoots(true);
  for (const dir of coverDirectories(tracks)) {
    const entries = await getDirectoryNames(dir, dirEntriesCache);
    if (entries.size === 0) continue;
    for (const name of COVER_NAMES) {
      if (!entries.has(name)) continue;
      const file = await resolveCoverFile(path.join(dir, name), { allowMusic: true, realRoots: allowedRoots });
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
  const dirEntriesCache = new Map();
  const realRoots = await resolveAllowedRoots(true);
  const existingSet = await readExistingCoversSet();
  const changed = [];
  for (const [id, tracks] of albums) {
    const stateName = `album_${id}.folder.json`;
    if (existingSet && !existingSet.has(stateName)) {
      changed.push(id);
      continue;
    }
    try {
      const [folder, rawState] = await Promise.all([
        readFolderCover(tracks, { dirEntriesCache, realRoots }),
        fsp.readFile(folderStatePath(id), 'utf8'),
      ]);
      const state = JSON.parse(rawState);
      if (state.hash !== (folder?.hash ?? null)) changed.push(id);
    } catch {
      changed.push(id);
    }
  }
  return changed;
}

async function resolveBlobForHash(hash, localAlbumBlobs) {
  if (localAlbumBlobs.has(hash)) return localAlbumBlobs.get(hash);
  const entry = scannedCoverBlobs.get(hash);
  if (!entry) return null;
  if (entry.buffer) {
    localAlbumBlobs.set(hash, entry);
    return entry;
  }
  if (entry.samplePath) {
    try {
      const meta = await parseFile(entry.samplePath, { skipCovers: false });
      const pic = selectCover(meta.common?.picture);
      if (pic && pic.data?.length > 0) {
        const loaded = { buffer: pic.data, format: pic.format || entry.format };
        localAlbumBlobs.set(hash, loaded);
        return loaded;
      }
    } catch {}
  }
  return null;
}

/**
 * Extracts and resolves covers for an album and all of its tracks:
 * 1. Checks folder image files (cover.jpg, folder.jpg, etc.) via cached `readdir`
 * 2. Reuses embedded picture hashes/buffers captured during Stage 1 scan when available
 * 3. Writes consensus Album Cover and batches DB updates only for changed `tracks.cover_path`
 */
export async function extractCoversForAlbum(albumId, context = null) {
  const previous = coverJobs.get(albumId) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => extractAlbumArtwork(albumId, context));
  coverJobs.set(albumId, job);
  try { return await job; }
  finally { if (coverJobs.get(albumId) === job) coverJobs.delete(albumId); }
}

async function extractAlbumArtwork(albumId, context = null) {
  if (!albumId) return null;
  const { rows: tracks } = await query(
    'SELECT id, file_path, cover_path FROM tracks WHERE album_id = $1 AND missing_since IS NULL ORDER BY track_number ASC, file_path ASC',
    [albumId]
  );
  if (tracks.length === 0) return null;

  const existingSet = context?.existingSet ?? await readExistingCoversSet();
  const folderCover = await readFolderCover(tracks, {
    dirEntriesCache: context?.dirEntriesCache ?? null,
    realRoots: context?.realRoots ?? null,
  });
  const folderCoverBuffer = folderCover?.buffer;
  const folderCoverFormat = folderCover?.format;
  const folderCoverHash = folderCover?.hash;

  const readableTracks = new Set();
  const trackPictures = new Map(); // trackId -> { hash, format, buffer? }
  const hashCounts = new Map();    // hash -> { count, buffer?, format }
  const localAlbumBlobs = new Map();

  for (const t of tracks) {
    const preScanned = scanCoverSessionActive ? scannedTrackMeta.get(t.file_path) : undefined;
    if (preScanned !== undefined) {
      if (preScanned.readable) {
        readableTracks.add(t.id);
        if (preScanned.hash) {
          const blob = await resolveBlobForHash(preScanned.hash, localAlbumBlobs);
          if (blob?.buffer) {
            trackPictures.set(t.id, { buffer: blob.buffer, format: blob.format, hash: preScanned.hash });
            const existing = hashCounts.get(preScanned.hash);
            if (existing) existing.count++;
            else hashCounts.set(preScanned.hash, { count: 1, buffer: blob.buffer, format: blob.format });
          }
        }
      }
      continue;
    }

    try {
      const meta = await parseFile(t.file_path, { skipCovers: false });
      readableTracks.add(t.id);
      const pic = selectCover(meta.common?.picture);
      if (pic && pic.data && pic.data.length > 0) {
        const hash = crypto.createHash('md5').update(pic.data).digest('hex');
        trackPictures.set(t.id, { buffer: pic.data, format: pic.format, hash });
        const existing = hashCounts.get(hash);
        if (existing) existing.count++;
        else hashCounts.set(hash, { count: 1, buffer: pic.data, format: pic.format });
      }
    } catch {}
  }

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

  if (albumCoverBuffer) {
    const albumCoverUrl = await saveCoverBuffer(albumCoverBuffer, albumCoverFormat, `album_${albumId}`, existingSet);
    await setAlbumCover(albumId, albumCoverUrl);
  } else if (readableTracks.size === tracks.length) {
    await setAlbumCover(albumId, null);
    await deleteCoverFile(`album_${albumId}`, existingSet);
  }

  // Batch NULL updates only for tracks whose `cover_path` was previously non-NULL,
  // avoiding thousands of autocommit no-op UPDATEs and cold unlink() syscalls on first scan.
  const idsToClearInDb = [];
  const uniqueUpdates = []; // { id, url }

  for (const t of tracks) {
    if (!readableTracks.has(t.id)) continue;
    const pic = trackPictures.get(t.id);
    if (!pic || (albumCoverHash && pic.hash === albumCoverHash)) {
      if (t.cover_path !== null) idsToClearInDb.push(t.id);
      await deleteCoverFile(`track_${t.id}`, existingSet);
    } else {
      const trackCoverUrl = await saveCoverBuffer(pic.buffer, pic.format, `track_${t.id}`, existingSet);
      if (t.cover_path !== trackCoverUrl) {
        uniqueUpdates.push({ id: t.id, url: trackCoverUrl });
      }
    }
  }

  if (idsToClearInDb.length > 0) {
    await query('UPDATE tracks SET cover_path = NULL WHERE id = ANY($1::int[])', [idsToClearInDb]);
  }
  if (uniqueUpdates.length === 1) {
    await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [uniqueUpdates[0].url, uniqueUpdates[0].id]);
  } else if (uniqueUpdates.length > 1) {
    await query(
      `UPDATE tracks AS t
       SET cover_path = u.url
       FROM unnest($1::int[], $2::text[]) AS u(id, url)
       WHERE t.id = u.id`,
      [uniqueUpdates.map(u => u.id), uniqueUpdates.map(u => u.url)]
    );
  }

  if (readableTracks.size === tracks.length) {
    const stateName = `album_${albumId}.folder.json`;
    await fsp.writeFile(folderStatePath(albumId), JSON.stringify({ hash: folderCoverHash ?? null }));
    existingSet?.add(stateName);
  }
  return Boolean(albumCoverBuffer);
}

export async function extractCoverForAlbum(albumId) {
  return extractCoversForAlbum(albumId);
}

export async function extractAlbumCover(albumId) {
  return extractCoversForAlbum(albumId);
}

export async function extractCoverFromTrack(filePath, albumId) {
  if (albumId) return extractCoversForAlbum(albumId);
  return null;
}

export async function extractCoverForTrack(trackId, context = null) {
  const { rows } = await query('SELECT id, file_path, album_id, cover_path FROM tracks WHERE id = $1', [trackId]);
  if (!rows[0]) return null;
  const t = rows[0];
  if (t.album_id) {
    await extractCoversForAlbum(t.album_id, context);
    const updated = await query('SELECT cover_path FROM tracks WHERE id = $1', [trackId]);
    return updated.rows[0]?.cover_path || null;
  }
  const existingSet = context?.existingSet ?? await readExistingCoversSet();
  try {
    const meta = await parseFile(t.file_path, { skipCovers: false });
    const pic = selectCover(meta.common?.picture);
    if (pic && pic.data?.length > 0) {
      const url = await saveCoverBuffer(pic.data, pic.format, `track_${t.id}`, existingSet);
      if (t.cover_path !== url) {
        await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [url, t.id]);
      }
      return url;
    }
    if (t.cover_path !== null) {
      await query('UPDATE tracks SET cover_path = NULL WHERE id = $1', [t.id]);
    }
    await deleteCoverFile(`track_${t.id}`, existingSet);
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
    ORDER BY al.id ASC
  `;

  const { rows: albums } = await query(sql, albumIds ? [albumIds] : []);
  const context = {
    existingSet: await readExistingCoversSet(),
    dirEntriesCache: new Map(),
    realRoots: await resolveAllowedRoots(true),
  };

  let extracted = 0;
  let next = 0;
  const worker = async () => {
    while (next < albums.length) {
      const album = albums[next++];
      try {
        if (await extractCoversForAlbum(album.id, context)) extracted++;
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
        `SELECT id FROM tracks WHERE album_id IS NULL AND missing_since IS NULL ${force ? '' : 'AND cover_path IS NULL'}`
      );
      for (const ot of orphanTracks) {
        try {
          if (await extractCoverForTrack(ot.id, context)) extracted++;
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
