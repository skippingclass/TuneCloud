import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import pkg from 'music-metadata';
const { parseFile } = pkg;
import { query, getClient } from './db.js';
import { extractAllMissingCovers, deleteTrackCover } from './cover.js';

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

function extractLeadingArtist(name) {
  if (!name) return null;
  const m = name.match(/^(.+?)\s*(?:feat\.|ft\.|featuring|vs\.?|&|,\s)/i);
  return m ? m[1].trim() : name.trim();
}

/**
 * Normalizes folder path for multi-disc releases (e.g. CD1, Disc 2)
 * so they merge into the same album folder.
 */
function normalizeAlbumFolder(fp) {
  if (!fp) return '';
  const base = path.basename(fp);
  if (/^(cd|disc|disk)\s*\d+$/i.test(base)) {
    return path.dirname(fp);
  }
  return fp;
}

/**
 * Infers the album artist and compilation flag across a group of tracks from the same folder.
 */
function inferAlbumArtist(tracks) {
  // 1. Any track has an explicit albumartist tag?
  for (const t of tracks) {
    if (t.albumArtistName) return { name: t.albumArtistName, compilation: false };
  }

  // 2. Count frequency of exact artist names
  const counts = new Map();
  for (const t of tracks) {
    if (t.artistName) {
      counts.set(t.artistName, (counts.get(t.artistName) || 0) + 1);
    }
  }

  if (counts.size === 0) return { name: 'Unknown', compilation: false };
  if (counts.size === 1) return { name: [...counts.keys()][0], compilation: false };

  // Find most frequent artist
  let bestArtist = null;
  let maxCount = 0;
  for (const [artist, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestArtist = artist;
    }
  }

  // If dominant artist covers at least 40% of the tracks or appears multiple times, use it
  if (bestArtist && (maxCount >= Math.ceil(tracks.length * 0.4) || maxCount >= 2)) {
    return { name: bestArtist, compilation: false };
  }

  // 3. Check leading artist prefix (e.g. "Sqwore, glaive" -> "Sqwore")
  const leadingCounts = new Map();
  for (const t of tracks) {
    const lead = extractLeadingArtist(t.artistName);
    if (lead) {
      leadingCounts.set(lead, (leadingCounts.get(lead) || 0) + 1);
    }
  }
  let bestLead = null;
  let maxLeadCount = 0;
  for (const [lead, count] of leadingCounts.entries()) {
    if (count > maxLeadCount) {
      maxLeadCount = count;
      bestLead = lead;
    }
  }
  if (bestLead && maxLeadCount >= Math.ceil(tracks.length * 0.5)) {
    return { name: bestLead, compilation: false };
  }

  // 4. Truly diverse artists -> compilation
  return { name: 'Various Artists', compilation: true };
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

/**
 * Upserts a batch of parsed tracks (artists -> albums -> tracks) with one
 * round-trip per table. Must run inside a transaction on `client`.
 * Returns the ids of albums referenced by the batch.
 */
async function flushTrackBatch(client, items) {
  const touchedAlbumIds = new Set();
  if (items.length === 0) return touchedAlbumIds;

  // 1. Group items by album: (normalizedFolder, albumTitle)
  const albumGroups = new Map();
  for (const item of items) {
    const title = item.albumTitle || path.basename(normalizeAlbumFolder(item.folderPath));
    const normFolder = normalizeAlbumFolder(item.folderPath);
    const key = `${normFolder}\u0000${title}`;
    if (!albumGroups.has(key)) {
      albumGroups.set(key, { normFolder, title, tracks: [] });
    }
    albumGroups.get(key).tracks.push(item);
  }

  // Determine album artist and compilation flag for each album group
  const albumMetaList = [];
  for (const [groupKey, group] of albumGroups.entries()) {
    const inferred = inferAlbumArtist(group.tracks);
    const sample = group.tracks[0];
    albumMetaList.push({
      groupKey,
      normFolder: group.normFolder,
      title: group.title,
      albumArtistName: inferred.name,
      compilation: inferred.compilation,
      year: sample.year,
      genre: sample.genre,
    });
  }

  // Pre-calculate canonical artist name and preserve full track artist credit
  for (const item of items) {
    item.canonicalArtistName = extractLeadingArtist(item.artistName) || item.artistName;
    item.trackArtistCredit = item.artistName || null;
  }

  // 2. Artists: collect ONLY canonical artist names + inferred album artists (no comma/feat composites)
  const allArtistNames = [
    ...new Set([
      ...items.map((i) => i.canonicalArtistName).filter(Boolean),
      ...albumMetaList.map((a) => a.albumArtistName).filter(Boolean),
    ]),
  ];

  const artistMap = new Map();
  if (allArtistNames.length > 0) {
    const { rows } = await client.query(
      `INSERT INTO artists (name)
       SELECT n FROM unnest($1::text[]) AS n
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name`,
      [allArtistNames]
    );
    for (const r of rows) artistMap.set(r.name, r.id);
  }

  // 3. Albums: look up existing albums in DB by folder_path OR (title, artist_id)
  for (const a of albumMetaList) {
    a.artistId = a.albumArtistName ? (artistMap.get(a.albumArtistName) ?? null) : null;
  }

  const titles = albumMetaList.map((a) => a.title);
  const folders = albumMetaList.map((a) => a.normFolder);
  const artistIds = albumMetaList.map((a) => a.artistId).filter((id) => id !== null);

  const { rows: existingAlbumRows } = await client.query(
    `SELECT id, title, folder_path, artist_id
     FROM albums
     WHERE folder_path = ANY($1::text[])
        OR (title = ANY($2::text[]) AND artist_id = ANY($3::int[]))`,
    [folders, titles, artistIds]
  );

  const albumMap = new Map();

  for (const a of albumMetaList) {
    // Exact match on folder_path + title first
    let match = existingAlbumRows.find(
      (r) => r.folder_path === a.normFolder && r.title === a.title
    );
    // If not found, match on title + artist_id (album was moved to another folder)
    if (!match && a.artistId != null) {
      match = existingAlbumRows.find(
        (r) => r.title === a.title && r.artist_id === a.artistId
      );
      if (match && match.folder_path !== a.normFolder) {
        // Update album folder_path in DB to the new folder
        await client.query('UPDATE albums SET folder_path = $1 WHERE id = $2', [a.normFolder, match.id]);
        match.folder_path = a.normFolder;
      }
    }
    if (match) {
      albumMap.set(a.groupKey, match.id);
    }
  }

  // Albums that need to be inserted or upserted
  const albumsToUpsert = albumMetaList.filter((a) => !albumMap.has(a.groupKey));

  if (albumsToUpsert.length > 0) {
    const { rows: upsertedRows } = await client.query(
      `INSERT INTO albums (title, artist_id, year, genre, folder_path, compilation)
       SELECT * FROM unnest(
         $1::text[], $2::int[], $3::int[], $4::text[], $5::text[], $6::boolean[]
       )
       ON CONFLICT (title, artist_id) DO UPDATE SET
         year = COALESCE(EXCLUDED.year, albums.year),
         genre = COALESCE(EXCLUDED.genre, albums.genre),
         folder_path = COALESCE(EXCLUDED.folder_path, albums.folder_path),
         compilation = COALESCE(EXCLUDED.compilation, albums.compilation)
       RETURNING id, title, folder_path, artist_id`,
      [
        albumsToUpsert.map((a) => a.title),
        albumsToUpsert.map((a) => a.artistId),
        albumsToUpsert.map((a) => a.year),
        albumsToUpsert.map((a) => a.genre),
        albumsToUpsert.map((a) => a.normFolder),
        albumsToUpsert.map((a) => a.compilation),
      ]
    );

    for (const r of upsertedRows) {
      const meta = albumsToUpsert.find(
        (a) => a.title === r.title && (a.artistId === r.artist_id || a.normFolder === r.folder_path)
      );
      if (meta) {
        albumMap.set(meta.groupKey, r.id);
      } else if (r.folder_path) {
        albumMap.set(`${r.folder_path}\u0000${r.title}`, r.id);
      }
    }
  }

  // 4. Tracks: each track links to canonical artistId, while preserving raw featuring credit
  const cols = Array.from({ length: 16 }, () => []);
  for (const i of items) {
    const title = i.albumTitle || path.basename(normalizeAlbumFolder(i.folderPath));
    const normFolder = normalizeAlbumFolder(i.folderPath);
    const aKey = `${normFolder}\u0000${title}`;
    const albumId = albumMap.get(aKey) ?? null;
    const albumMeta = albumMetaList.find((a) => a.groupKey === aKey);

    // Prefer album artist if track starts with/matches it, else canonical track artist
    const canonicalName = i.canonicalArtistName || albumMeta?.albumArtistName || null;
    const trackArtistId = canonicalName ? (artistMap.get(canonicalName) ?? null) : null;

    if (albumId) touchedAlbumIds.add(albumId);
    [
      i.filePath, i.fileName, i.fileSize, i.duration, i.title,
      trackArtistId, albumId, i.trackNumber, i.discNumber, i.genre,
      i.year, i.bitrate, i.sampleRate, i.format, i.mtime, i.trackArtistCredit,
    ].forEach((v, idx) => cols[idx].push(v));
  }

  await client.query(
    `INSERT INTO tracks (
       file_path, file_name, file_size, duration, title,
       artist_id, album_id, track_number, disc_number, genre,
       year, bitrate, sample_rate, format, mtime, track_artist_credit
     )
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::bigint[], $4::real[], $5::text[],
       $6::int[], $7::int[], $8::int[], $9::int[], $10::text[],
       $11::int[], $12::int[], $13::int[], $14::text[], $15::timestamptz[], $16::text[]
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
       track_artist_credit = EXCLUDED.track_artist_credit,
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
      albumArtistName: cleanStr(common.albumartist) || null,
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
export async function scanDirectory(musicDir, { full = false, reextractCovers = false } = {}) {
  const root = path.resolve(musicDir);
  const startedAt = Date.now();

  const files = await listAudioFiles(root);
  console.log(`Found ${files.length} audio files (${full ? 'full' : 'incremental'} scan)`);

  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const { rows: known } = await query(
    'SELECT id, file_path, album_id, mtime FROM tracks WHERE starts_with(file_path, $1)',
    [prefix]
  );
  const knownByPath = new Map(known.map((r) => [r.file_path, r]));

  const onDisk = new Set();
  const toProcess = [];
  const touchedAlbumIds = new Set();

  for (const f of files) {
    onDisk.add(f.path);
    const k = knownByPath.get(f.path);
    if (full || !k || !k.mtime || k.mtime.getTime() !== f.mtime.getTime() || k.album_id == null) {
      toProcess.push(f);
      if (k?.album_id) touchedAlbumIds.add(k.album_id);
    }
  }
  const unchanged = files.length - toProcess.length;
  console.log(`Unchanged: ${unchanged}, to process: ${toProcess.length}`);

  const staleRows = known.filter((r) => !onDisk.has(r.file_path));
  const staleIds = staleRows.map((r) => r.id);
  for (const r of staleRows) {
    if (r.album_id) touchedAlbumIds.add(r.album_id);
  }

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
      const chunk = staleIds.slice(i, i + DELETE_CHUNK);
      const res = await client.query('DELETE FROM tracks WHERE id = ANY($1::int[])', [chunk]);
      removed += res.rowCount;
      for (const id of chunk) deleteTrackCover(id).catch(() => {});
    }
    if (removed > 0) console.log(`Removed ${removed} stale track(s) from DB`);

    // Clean up empty albums/artists
    await removeOrphans(client);
  } finally {
    client.release();
  }

  let coversExtracted = 0;
  let coversTotal = 0;

  if (full || reextractCovers) {
    const covers = await extractAllMissingCovers({ force: true });
    coversExtracted = covers.extracted;
    coversTotal = covers.total;
  } else {
    // 1. Force re-extract for touched albums so retagged/moved tracks update the cover
    if (touchedAlbumIds.size > 0) {
      const touchedCovers = await extractAllMissingCovers({
        albumIds: [...touchedAlbumIds],
        force: true,
      });
      coversExtracted += touchedCovers.extracted;
      coversTotal += touchedCovers.total;
    }
    // 2. Extract for any other albums still missing covers
    const missingCovers = await extractAllMissingCovers({ force: false });
    coversExtracted += missingCovers.extracted;
    coversTotal += missingCovers.total;
  }

  console.log(`Covers extracted: ${coversExtracted}/${coversTotal}`);

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`Scan complete in ${durationSeconds}s. Processed ${processed} files.`);
  return { total: files.length, processed, unchanged, removed, covers: coversExtracted, durationSeconds };
}

export async function scanSingleFile(filePath) {
  try {
    const { size, mtime } = await fs.stat(filePath);
    const item = await parseTrackFile({ path: filePath, size, mtime });
    const touched = new Set();
    const { rows: prev } = await query('SELECT album_id FROM tracks WHERE file_path = $1', [filePath]);
    if (prev[0]?.album_id) touched.add(prev[0].album_id);

    const client = await getClient();
    let written;
    try {
      written = await writeBatch(client, [item], touched);
    } finally {
      client.release();
    }
    if (written > 0 && touched.size > 0) {
      await extractAllMissingCovers({ albumIds: [...touched], force: true });
    }
    return written > 0;
  } catch (err) {
    console.error(`Failed to process ${filePath}: ${err.message}`);
    return false;
  }
}
