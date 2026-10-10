import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
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

async function saveCoverBuffer(buffer, format, albumId) {
  const ext = format?.split('/')[1] || 'jpg';
  const filename = `album_${albumId}.${ext}`;
  const targetPath = path.join(COVERS_DIR, filename);
  await fsp.writeFile(targetPath, buffer);

  for (const altExt of ['jpg', 'jpeg', 'png', 'webp']) {
    if (altExt !== ext) {
      try { await fsp.unlink(path.join(COVERS_DIR, `album_${albumId}.${altExt}`)); } catch {}
    }
  }

  return `/api/cover/${filename}`;
}

async function setAlbumCover(albumId, url) {
  await query('UPDATE albums SET cover_path = $1 WHERE id = $2', [url, albumId]);
  return url;
}

export async function extractAlbumCover(albumId, trackDir) {
  for (const name of COVER_NAMES) {
    const coverFile = path.join(trackDir, name);
    if (await fileExists(coverFile)) {
      const buf = await fsp.readFile(coverFile);
      const format = name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      return setAlbumCover(albumId, await saveCoverBuffer(buf, format, albumId));
    }
  }
  return null;
}

// Embedded picture first, then well-known image files in the track's folder.
export async function extractCoverFromTrack(filePath, albumId) {
  if (!albumId) return null;
  try {
    const meta = await parseFile(filePath, { skipCovers: false });
    const pic = meta.common?.picture?.[0];
    if (pic) {
      return setAlbumCover(albumId, await saveCoverBuffer(pic.data, pic.format, albumId));
    }
  } catch {}
  return extractAlbumCover(albumId, path.dirname(filePath));
}

/**
 * Extracts a cover for an album by scanning its tracks in order for embedded artwork.
 */
export async function extractCoverForAlbum(albumId) {
  if (!albumId) return null;
  const { rows: tracks } = await query(
    'SELECT file_path FROM tracks WHERE album_id = $1 ORDER BY track_number ASC, file_path ASC LIMIT 50',
    [albumId]
  );
  for (const t of tracks) {
    try {
      const meta = await parseFile(t.file_path, { skipCovers: false });
      const pic = meta.common?.picture?.[0];
      if (pic) {
        return setAlbumCover(albumId, await saveCoverBuffer(pic.data, pic.format, albumId));
      }
    } catch {}
  }
  if (tracks[0]) {
    return extractAlbumCover(albumId, path.dirname(tracks[0].file_path));
  }
  return null;
}

/**
 * Extracts covers for albums. Supports options object { albumIds, force } or legacy albumIds array.
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
        if (await extractCoverForAlbum(album.id)) extracted++;
      } catch (err) {
        console.error(`Cover extraction failed for album ${album.id}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, albums.length) }, worker));

  return { total: albums.length, extracted };
}

export function coverUrl(filename) {
  const filepath = path.join(COVERS_DIR, path.basename(filename));
  return fs.existsSync(filepath) ? filepath : null;
}
