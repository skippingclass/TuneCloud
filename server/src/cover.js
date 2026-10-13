import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import pkg from 'music-metadata';
const { parseFile } = pkg;
import { query } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.resolve(__dirname, '../covers');
const COVER_NAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'Cover.jpg', 'Cover.png',
  'folder.jpg', 'folder.png', 'Folder.jpg', 'Folder.png',
  'front.jpg', 'front.png', 'Front.jpg',
  'album.jpg', 'album.png', 'Album.jpg',
  'artwork.jpg', 'Artwork.jpg',
];
const COVER_CONCURRENCY = 4;

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function initCoversDir() {
  await fsp.mkdir(COVERS_DIR, { recursive: true });
}

async function saveCoverBuffer(buffer, format, prefix) {
  const ext = format?.split('/')[1] || 'jpg';
  const filename = `${prefix}.${ext}`;
  const targetPath = path.join(COVERS_DIR, filename);
  await fsp.writeFile(targetPath, buffer);

  for (const altExt of ['jpg', 'jpeg', 'png', 'webp']) {
    if (altExt !== ext) {
      try { await fsp.unlink(path.join(COVERS_DIR, `${prefix}.${altExt}`)); } catch {}
    }
  }

  return `/api/cover/${filename}`;
}

async function deleteCoverFile(prefix) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
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

/**
 * Extracts and resolves covers for an album and all of its tracks:
 * 1. Checks folder image files (cover.jpg, folder.jpg, etc.)
 * 2. Reads embedded pictures from all album tracks and computes hashes
 * 3. The majority consensus picture (or folder image) becomes the Album Cover
 * 4. Tracks whose embedded picture matches the album cover inherit it (tracks.cover_path = NULL)
 * 5. Tracks with unique artwork get their own file (track_${trackId}.${ext}) and tracks.cover_path
 */
export async function extractCoversForAlbum(albumId) {
  if (!albumId) return null;
  const { rows: tracks } = await query(
    'SELECT id, file_path FROM tracks WHERE album_id = $1 ORDER BY track_number ASC, file_path ASC',
    [albumId]
  );
  if (tracks.length === 0) return null;

  // 1. Check folder-level well-known cover images first
  const albumDir = path.dirname(tracks[0].file_path);
  let folderCoverBuffer = null;
  let folderCoverFormat = null;
  let folderCoverHash = null;

  for (const name of COVER_NAMES) {
    const coverFile = path.join(albumDir, name);
    if (await fileExists(coverFile)) {
      try {
        const buf = await fsp.readFile(coverFile);
        if (buf && buf.length > 0) {
          folderCoverBuffer = buf;
          folderCoverFormat = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
          folderCoverHash = crypto.createHash('md5').update(buf).digest('hex');
          break;
        }
      } catch {}
    }
  }

  // 2. Scan tracks for embedded artwork
  const trackPictures = new Map(); // trackId -> { buffer, format, hash }
  const hashCounts = new Map();   // hash -> { count, buffer, format }

  for (const t of tracks) {
    try {
      const meta = await parseFile(t.file_path, { skipCovers: false });
      const pic = meta.common?.picture?.[0];
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
  }

  // 4. Classify track-level covers:
  for (const t of tracks) {
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
    const pic = meta.common?.picture?.[0];
    if (pic && pic.data?.length > 0) {
      const url = await saveCoverBuffer(pic.data, pic.format, `track_${t.id}`);
      await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [url, t.id]);
      return url;
    }
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

  if (Array.isArray(optionsOrIds)) {
    albumIds = optionsOrIds;
  } else if (optionsOrIds && typeof optionsOrIds === 'object') {
    albumIds = optionsOrIds.albumIds || null;
    force = Boolean(optionsOrIds.force);
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
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, albums.length) }, worker));

  // Also handle loose tracks without an album
  if (force || !albumIds) {
    try {
      const { rows: orphanTracks } = await query(
        'SELECT id, file_path FROM tracks WHERE album_id IS NULL AND cover_path IS NULL'
      );
      for (const ot of orphanTracks) {
        try {
          const meta = await parseFile(ot.file_path, { skipCovers: false });
          const pic = meta.common?.picture?.[0];
          if (pic && pic.data?.length > 0) {
            const url = await saveCoverBuffer(pic.data, pic.format, `track_${ot.id}`);
            await query('UPDATE tracks SET cover_path = $1 WHERE id = $2', [url, ot.id]);
            extracted++;
          }
        } catch {}
      }
    } catch {}
  }

  return { total: albums.length, extracted };
}

export function coverUrl(filename) {
  const filepath = path.join(COVERS_DIR, path.basename(filename));
  return fs.existsSync(filepath) ? filepath : null;
}
