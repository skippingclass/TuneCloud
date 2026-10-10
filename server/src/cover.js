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
  await fsp.writeFile(path.join(COVERS_DIR, filename), buffer);
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
 * Extracts covers for albums that have none, reading exactly one file per album.
 * @param {number[]|null} albumIds restrict to these albums (null = all albums without a cover)
 */
export async function extractAllMissingCovers(albumIds = null) {
  if (albumIds && albumIds.length === 0) return { total: 0, extracted: 0 };

  const { rows: albums } = await query(
    `SELECT al.id, MIN(t.file_path) AS sample_path
     FROM albums al
     JOIN tracks t ON t.album_id = al.id
     WHERE al.cover_path IS NULL
       AND ($1::int[] IS NULL OR al.id = ANY($1::int[]))
     GROUP BY al.id`,
    [albumIds]
  );

  let extracted = 0;
  let next = 0;
  const worker = async () => {
    while (next < albums.length) {
      const album = albums[next++];
      try {
        if (await extractCoverFromTrack(album.sample_path, album.id)) extracted++;
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
