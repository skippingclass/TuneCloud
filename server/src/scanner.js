import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import pkg from 'music-metadata';
const { parseFile } = pkg;
import { query, getClient } from './db.js';
import { extractAllMissingCovers } from './cover.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
const BATCH_SIZE = 300;
const PARSE_CONCURRENCY = 12;
const DELETE_CHUNK = 500;
const PG_INT_MAX = 2147483647;

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function toInt(v) {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && Math.abs(n) <= PG_INT_MAX ? n : null;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const albumKey = (title, artistId) => `${title}\u0000${artistId ?? ''}`;

/**
 * Upserts a batch of parsed tracks (artists -> albums -> tracks) with one
 * round-trip per table. Must run inside a transaction on `client`.
 * Returns the ids of albums referenced by the batch.
 */
async function flushTrackBatch(client, items) {
  const touchedAlbumIds = new Set();
  if (items.length === 0) return touchedAlbumIds;

  // 1. Artists
  const artistNames = [...new Set(items.flatMap((i) => [i.artistName, i.albumArtistName]).filter(Boolean))];
  const artistMap = new Map();
  if (artistNames.length > 0) {
    const { rows } = await client.query(
      `INSERT INTO artists (name)
       SELECT n FROM unnest($1::text[]) AS n
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [artistNames]
    );
    for (const r of rows) artistMap.set(r.name, r.id);
  }

  // 2. Albums (deduplicated in JS: ON CONFLICT can't touch the same row twice per statement)
  const resolveIds = (i) => {
    const artistId = i.artistName ? artistMap.get(i.artistName) ?? null : null;
    const albumArtistId = i.albumArtistName ? artistMap.get(i.albumArtistName) ?? artistId : artistId;
    return { artistId, albumArtistId };
  };

  const albums = new Map();
  for (const i of items) {
    if (!i.albumTitle) continue;
    const { albumArtistId } = resolveIds(i);
    const key = albumKey(i.albumTitle, albumArtistId);
    if (!albums.has(key)) {
      albums.set(key, { title: i.albumTitle, artistId: albumArtistId, year: i.year, genre: i.genre, folderPath: i.folderPath });
    }
  }

  const albumMap = new Map();
  if (albums.size > 0) {
    const list = [...albums.values()];
    const { rows } = await client.query(
      `INSERT INTO albums (title, artist_id, year, genre, folder_path)
       SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::text[])
       ON CONFLICT (title, artist_id) DO UPDATE SET
         year = COALESCE(EXCLUDED.year, albums.year),
         genre = COALESCE(EXCLUDED.genre, albums.genre),
         folder_path = COALESCE(EXCLUDED.folder_path, albums.folder_path)
       RETURNING id, title, artist_id`,
      [
        list.map((a) => a.title),
        list.map((a) => a.artistId),
        list.map((a) => a.year),
        list.map((a) => a.genre),
        list.map((a) => a.folderPath),
      ]
    );
    for (const r of rows) albumMap.set(albumKey(r.title, r.artist_id), r.id);
  }

  // 3. Tracks
  const cols = Array.from({ length: 15 }, () => []);
  for (const i of items) {
    const { artistId, albumArtistId } = resolveIds(i);
    const albumId = i.albumTitle ? albumMap.get(albumKey(i.albumTitle, albumArtistId)) ?? null : null;
    if (albumId) touchedAlbumIds.add(albumId);
    [
      i.filePath, i.fileName, i.fileSize, i.duration, i.title,
      artistId, albumId, i.trackNumber, i.discNumber, i.genre,
      i.year, i.bitrate, i.sampleRate, i.format, i.mtime,
    ].forEach((v, idx) => cols[idx].push(v));
  }

  await client.query(
    `INSERT INTO tracks (
       file_path, file_name, file_size, duration, title,
       artist_id, album_id, track_number, disc_number, genre,
       year, bitrate, sample_rate, format, mtime
     )
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::bigint[], $4::real[], $5::text[],
       $6::int[], $7::int[], $8::int[], $9::int[], $10::text[],
       $11::int[], $12::int[], $13::int[], $14::text[], $15::timestamptz[]
     )
     ON CONFLICT (file_path) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       file_size = EXCLUDED.file_size,
       duration = EXCLUDED.duration,
       title = COALESCE(EXCLUDED.title, tracks.title),
       artist_id = COALESCE(EXCLUDED.artist_id, tracks.artist_id),
       album_id = COALESCE(EXCLUDED.album_id, tracks.album_id),
       track_number = COALESCE(EXCLUDED.track_number, tracks.track_number),
       disc_number = COALESCE(EXCLUDED.disc_number, tracks.disc_number),
       genre = COALESCE(EXCLUDED.genre, tracks.genre),
       year = COALESCE(EXCLUDED.year, tracks.year),
       bitrate = EXCLUDED.bitrate,
       sample_rate = EXCLUDED.sample_rate,
       format = EXCLUDED.format,
       mtime = EXCLUDED.mtime,
       updated_at = NOW()`,
    cols
  );

  return touchedAlbumIds;
}

async function inTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  }
}

/**
 * Writes a batch in one transaction; if that fails (e.g. one bad row),
 * falls back to per-track transactions so a single file can't abort the scan.
 */
async function writeBatch(client, items, touchedAlbumIds) {
  try {
    const ids = await inTransaction(client, () => flushTrackBatch(client, items));
    ids.forEach((id) => touchedAlbumIds.add(id));
    return items.length;
  } catch (err) {
    console.error(`Batch write failed (${err.message}), retrying per track`);
  }
  let written = 0;
  for (const item of items) {
    try {
      const ids = await inTransaction(client, () => flushTrackBatch(client, [item]));
      ids.forEach((id) => touchedAlbumIds.add(id));
      written++;
    } catch (err) {
      console.error(`Could not write ${item.filePath}: ${err.message}`);
    }
  }
  return written;
}

/** Parses tags into a flat record. Never throws: unreadable tags fall back to a basic entry. */
async function parseTrackFile({ path: filePath, size, mtime }) {
  const fileName = path.basename(filePath);
  const base = {
    filePath,
    fileName,
    fileSize: size,
    duration: 0,
    title: fileName.replace(/\.[^.]+$/, ''),
    artistName: null,
    albumArtistName: null,
    albumTitle: null,
    trackNumber: null,
    discNumber: 1,
    genre: null,
    year: null,
    bitrate: null,
    sampleRate: null,
    format: path.extname(filePath).toLowerCase().slice(1),
    folderPath: path.dirname(filePath),
    mtime,
  };

  try {
    const meta = await parseFile(filePath, { skipCovers: true });
    const common = meta.common || {};
    const format = meta.format || {};
    const artistName = cleanStr(common.artist);
    const genre = Array.isArray(common.genre)
      ? cleanStr(common.genre.map(cleanStr).filter(Boolean).join(', '))
      : cleanStr(common.genre);

    return {
      ...base,
      duration: Number.isFinite(format.duration) ? format.duration : 0,
      title: cleanStr(common.title) || base.title,
      artistName,
      albumArtistName: cleanStr(common.albumartist) || artistName,
      albumTitle: cleanStr(common.album),
      trackNumber: toInt(common.track?.no),
      discNumber: toInt(common.disk?.no) || 1,
      genre,
      year: toInt(common.year),
      bitrate: toInt(format.bitrate),
      sampleRate: toInt(format.sampleRate),
    };
  } catch (err) {
    console.error(`Failed to parse metadata for ${filePath}: ${err.message}`);
    return base;
  }
}

/** Lists audio files with size/mtime in a single directory walk (stat follows symlinks). */
async function listAudioFiles(musicDir) {
  const pattern = path.join(musicDir, '**/*').replace(/\\/g, '/');
  const entries = await glob(pattern, { withFileTypes: true, stat: true, nodir: true, nocase: true });

  const files = [];
  for (const e of entries) {
    if (!isAudioFile(e.name)) continue;
    let { size, mtime } = e;
    if (e.isSymbolicLink() || !mtime) {
      try {
        ({ size, mtime } = await fs.stat(e.fullpath()));
      } catch {
        continue; // dangling symlink
      }
    }
    files.push({ path: e.fullpath(), size, mtime });
  }
  return files;
}

async function removeOrphans(client) {
  await client.query(
    `DELETE FROM albums al WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)`
  );
  await client.query(
    `DELETE FROM artists a
     WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = a.id)`
  );
}

/**
 * Scans musicDir. Incremental by default: only files whose mtime differs from
 * the stored one (or that are new) are parsed. `full: true` re-parses everything.
 */
export async function scanDirectory(musicDir, { full = false } = {}) {
  const root = path.resolve(musicDir);
  const startedAt = Date.now();

  const files = await listAudioFiles(root);
  console.log(`Found ${files.length} audio files (${full ? 'full' : 'incremental'} scan)`);

  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const { rows: known } = await query(
    'SELECT id, file_path, mtime FROM tracks WHERE starts_with(file_path, $1)',
    [prefix]
  );
  const knownByPath = new Map(known.map((r) => [r.file_path, r]));

  const onDisk = new Set();
  const toProcess = [];
  for (const f of files) {
    onDisk.add(f.path);
    const k = knownByPath.get(f.path);
    if (full || !k || !k.mtime || k.mtime.getTime() !== f.mtime.getTime()) toProcess.push(f);
  }
  const unchanged = files.length - toProcess.length;
  console.log(`Unchanged: ${unchanged}, to process: ${toProcess.length}`);

  const staleIds = known.filter((r) => !onDisk.has(r.file_path)).map((r) => r.id);
  const touchedAlbumIds = new Set();
  let processed = 0;
  let removed = 0;

  const client = await getClient();
  try {
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const parsed = await mapLimit(toProcess.slice(i, i + BATCH_SIZE), PARSE_CONCURRENCY, parseTrackFile);
      processed += await writeBatch(client, parsed, touchedAlbumIds);
      console.log(`Processed ${processed}/${toProcess.length}`);
    }

    for (let i = 0; i < staleIds.length; i += DELETE_CHUNK) {
      const res = await client.query('DELETE FROM tracks WHERE id = ANY($1::int[])', [staleIds.slice(i, i + DELETE_CHUNK)]);
      removed += res.rowCount;
    }
    if (removed > 0) console.log(`Removed ${removed} stale track(s) from DB`);

    // Re-tagged tracks may have moved to another album/artist, so always clean up.
    await removeOrphans(client);
  } finally {
    client.release();
  }

  const covers = await extractAllMissingCovers(full ? null : [...touchedAlbumIds]);
  console.log(`Covers extracted: ${covers.extracted}/${covers.total}`);

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`Scan complete in ${durationSeconds}s. Processed ${processed} files.`);
  return { total: files.length, processed, unchanged, removed, covers: covers.extracted, durationSeconds };
}

export async function scanSingleFile(filePath) {
  try {
    const { size, mtime } = await fs.stat(filePath);
    const item = await parseTrackFile({ path: filePath, size, mtime });
    const touched = new Set();
    const client = await getClient();
    let written;
    try {
      written = await writeBatch(client, [item], touched);
    } finally {
      client.release();
    }
    if (written > 0) await extractAllMissingCovers([...touched]);
    return written > 0;
  } catch (err) {
    console.error(`Failed to process ${filePath}: ${err.message}`);
    return false;
  }
}
