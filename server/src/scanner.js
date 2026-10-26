import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { parseFile } from 'music-metadata';
import { query, getClient } from './db.js';
import { extractAllMissingCovers } from './cover.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
const BATCH_SIZE = 300;
const PARSE_CONCURRENCY = 12;
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

export function extractLeadingArtist(name) {
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
  const albumArtistCounts = new Map();
  for (const t of tracks) {
    if (t.albumArtistName) {
      albumArtistCounts.set(t.albumArtistName, (albumArtistCounts.get(t.albumArtistName) || 0) + 1);
    }
  }
  if (albumArtistCounts.size > 0) {
    let bestAlbumArtist = null;
    let maxAACount = 0;
    for (const [name, count] of albumArtistCounts.entries()) {
      if (count > maxAACount) {
        maxAACount = count;
        bestAlbumArtist = name;
      }
    }
    const isVA = /^(various\s*artists|va|various)$/i.test(bestAlbumArtist.trim());
    const canonical = isVA ? 'Various Artists' : (extractLeadingArtist(bestAlbumArtist) || bestAlbumArtist);
    return { name: canonical, compilation: isVA };
  }

  // 2. Count frequency of exact artist names
  const counts = new Map();
  for (const t of tracks) {
    if (t.artistName) {
      counts.set(t.artistName, (counts.get(t.artistName) || 0) + 1);
    }
  }

  if (counts.size === 0) return { name: 'Unknown', compilation: false };
  if (counts.size === 1) {
    const raw = [...counts.keys()][0];
    return { name: extractLeadingArtist(raw) || raw, compilation: false };
  }

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
    return { name: extractLeadingArtist(bestArtist) || bestArtist, compilation: false };
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
    const canonicalAlbumArtist = extractLeadingArtist(inferred.name) || inferred.name;
    albumMetaList.push({
      groupKey,
      normFolder: group.normFolder,
      title: group.title,
      albumArtistName: canonicalAlbumArtist,
      compilation: inferred.compilation,
      year: sample.year,
      genre: sample.genre,
    });
  }

  // Pre-calculate canonical artist name and preserve full track artist credit
  for (const item of items) {
    item.canonicalArtistName = extractLeadingArtist(item.artistName) || item.artistName;
    item.trackArtistCredit = item.artistName || null;
    item.albumArtistCredit = item.albumArtistName || null;
    item.parseError = Boolean(item.parseError);
  }

  // 2. Artists: collect ONLY canonical artist names + inferred album artists (no comma/feat composites)
  const allArtistNames = [
    ...new Set([
      ...items.map((i) => i.canonicalArtistName).filter(Boolean),
      ...albumMetaList.map((a) => extractLeadingArtist(a.albumArtistName) || a.albumArtistName).filter(Boolean),
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
  const cols = Array.from({ length: 18 }, () => []);
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
      i.albumArtistCredit, i.parseError,
    ].forEach((v, idx) => cols[idx].push(v));
  }

  await client.query(
    `INSERT INTO tracks (
       file_path, file_name, file_size, duration, title,
       artist_id, album_id, track_number, disc_number, genre,
       year, bitrate, sample_rate, format, mtime, track_artist_credit,
       album_artist_credit, parse_error
     )
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::bigint[], $4::real[], $5::text[],
       $6::int[], $7::int[], $8::int[], $9::int[], $10::text[],
       $11::int[], $12::int[], $13::int[], $14::text[], $15::timestamptz[], $16::text[],
       $17::text[], $18::boolean[]
     )
     ON CONFLICT (file_path) DO UPDATE SET
       file_name = EXCLUDED.file_name,
       file_size = EXCLUDED.file_size,
       duration = CASE WHEN EXCLUDED.parse_error THEN tracks.duration ELSE EXCLUDED.duration END,
       title = CASE WHEN EXCLUDED.parse_error THEN tracks.title ELSE EXCLUDED.title END,
       artist_id = CASE WHEN EXCLUDED.parse_error THEN tracks.artist_id ELSE EXCLUDED.artist_id END,
       album_id = CASE WHEN EXCLUDED.parse_error THEN tracks.album_id ELSE EXCLUDED.album_id END,
       track_number = CASE WHEN EXCLUDED.parse_error THEN tracks.track_number ELSE EXCLUDED.track_number END,
       disc_number = CASE WHEN EXCLUDED.parse_error THEN tracks.disc_number ELSE EXCLUDED.disc_number END,
       genre = CASE WHEN EXCLUDED.parse_error THEN tracks.genre ELSE EXCLUDED.genre END,
       year = CASE WHEN EXCLUDED.parse_error THEN tracks.year ELSE EXCLUDED.year END,
       bitrate = CASE WHEN EXCLUDED.parse_error THEN tracks.bitrate ELSE EXCLUDED.bitrate END,
       sample_rate = CASE WHEN EXCLUDED.parse_error THEN tracks.sample_rate ELSE EXCLUDED.sample_rate END,
       format = EXCLUDED.format,
       mtime = EXCLUDED.mtime,
       missing_since = NULL,
       track_artist_credit = CASE WHEN EXCLUDED.parse_error THEN tracks.track_artist_credit ELSE EXCLUDED.track_artist_credit END,
       album_artist_credit = CASE WHEN EXCLUDED.parse_error THEN tracks.album_artist_credit ELSE EXCLUDED.album_artist_credit END,
       parse_error = EXCLUDED.parse_error,
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
      parseError: false,
    };
  } catch (err) {
    console.error(`Failed to parse metadata for ${filePath}: ${err.message}`);
    return {
      ...base,
      parseError: true,
      errorMessage: err.message,
    };
  }
}

/** Lists audio files with size/mtime in a single directory walk (stat follows symlinks). */
async function listAudioFiles(musicDir) {
  const physicalRoot = await fs.realpath(musicDir);
  const pattern = path.join(musicDir, '**/*').replace(/\\/g, '/');
  const entries = await glob(pattern, { withFileTypes: true, stat: true, nodir: true, nocase: true });

  const candidates = entries.filter(e => isAudioFile(e.name) && (e.isFile() || e.isSymbolicLink()));
  const files = await mapLimit(candidates, PARSE_CONCURRENCY, async e => {
    try {
      // Parents may themselves be symlinks even when the entry is a regular file.
      const physical = await fs.realpath(e.fullpath());
      const rel = path.relative(physicalRoot, physical);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      const stat = await fs.stat(physical);
      if (!stat.isFile()) return null;
      return { path: e.fullpath(), size: stat.size, mtime: stat.mtime };
    } catch { return null; }
  });
  return files.filter(Boolean);
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
 * Recomputes and updates album-level metadata across all tracks belonging to the album
 * in the database, including unchanged tracks and across batch boundaries.
 */
export async function refreshAlbumsMetadata(client, touchedAlbumIds) {
  if (!touchedAlbumIds || touchedAlbumIds.size === 0) return;
  const albumIds = [...touchedAlbumIds].filter(Boolean);
  if (albumIds.length === 0) return;

  for (const albumId of albumIds) {
    const { rows: tracks } = await client.query(
      `SELECT t.id, t.title, t.track_number, t.disc_number, t.genre, t.year,
              t.track_artist_credit, t.album_artist_credit, t.artist_id,
              a.name AS artist_name
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE t.album_id = $1`,
      [albumId]
    );

    if (tracks.length === 0) continue;

    // Disc count: max disc number across all tracks
    const maxDisc = Math.max(1, ...tracks.map((t) => t.disc_number || 1));

    // Consensus year: most frequent non-null year
    const yearCounts = new Map();
    for (const t of tracks) {
      if (t.year != null) {
        yearCounts.set(t.year, (yearCounts.get(t.year) || 0) + 1);
      }
    }
    let consensusYear = null;
    let maxYearCount = 0;
    for (const [y, cnt] of yearCounts.entries()) {
      if (cnt > maxYearCount) {
        maxYearCount = cnt;
        consensusYear = y;
      }
    }

    // Consensus genre: most frequent non-null genre
    const genreCounts = new Map();
    for (const t of tracks) {
      if (t.genre != null && t.genre.trim() !== '') {
        genreCounts.set(t.genre, (genreCounts.get(t.genre) || 0) + 1);
      }
    }
    let consensusGenre = null;
    let maxGenreCount = 0;
    for (const [g, cnt] of genreCounts.entries()) {
      if (cnt > maxGenreCount) {
        maxGenreCount = cnt;
        consensusGenre = g;
      }
    }

    // Inferred album artist & compilation flag across all tracks
    const tracksForInference = tracks.map((t) => ({
      albumArtistName: t.album_artist_credit,
      artistName: t.artist_name || t.track_artist_credit,
    }));
    const inferred = inferAlbumArtist(tracksForInference);
    const canonicalAlbumArtist = extractLeadingArtist(inferred.name) || inferred.name;

    // Find or insert canonical album artist in artists table
    let artistId = null;
    if (canonicalAlbumArtist) {
      const artRes = await client.query(
        `INSERT INTO artists (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [canonicalAlbumArtist]
      );
      artistId = artRes.rows[0]?.id || null;
    }

    // Check existing album row
    const { rows: albRows } = await client.query(
      'SELECT id, title, artist_id FROM albums WHERE id = $1',
      [albumId]
    );
    if (albRows.length === 0) continue;
    const albumTitle = albRows[0].title;

    // If another album already exists with (title, artistId), merge tracks to avoid conflict
    if (artistId != null) {
      const { rows: conflictRows } = await client.query(
        'SELECT id FROM albums WHERE title = $1 AND artist_id = $2 AND id != $3',
        [albumTitle, artistId, albumId]
      );
      if (conflictRows.length > 0) {
        const targetAlbumId = conflictRows[0].id;
        await client.query('UPDATE tracks SET album_id = $1 WHERE album_id = $2', [targetAlbumId, albumId]);
        await client.query('UPDATE user_starred_albums SET album_id = $1 WHERE album_id = $2 ON CONFLICT DO NOTHING', [targetAlbumId, albumId]);
        await client.query("UPDATE user_ratings SET entity_id = $1 WHERE entity_type = 'album' AND entity_id = $2 ON CONFLICT DO NOTHING", [targetAlbumId, albumId]);
        await client.query('DELETE FROM albums WHERE id = $1', [albumId]);
        touchedAlbumIds.add(targetAlbumId);
        continue;
      }
    }

    // Update album metadata
    await client.query(
      `UPDATE albums
       SET year = $1,
           genre = $2,
           artist_id = $3,
           compilation = $4,
           disc_count = $5
       WHERE id = $6`,
      [consensusYear, consensusGenre, artistId, inferred.compilation, maxDisc, albumId]
    );

    // Sync album_credits
    if (artistId != null) {
      await client.query(
        `DELETE FROM album_credits WHERE album_id = $1 AND role = 'albumartist' AND artist_id != $2`,
        [albumId, artistId]
      );
      await client.query(
        `INSERT INTO album_credits (album_id, artist_id, role, credited_as)
         VALUES ($1, $2, 'albumartist', $3)
         ON CONFLICT (album_id, artist_id, role) DO UPDATE SET credited_as = EXCLUDED.credited_as`,
        [albumId, artistId, canonicalAlbumArtist]
      );
    }
  }
}

/**
 * Scans musicDir. Incremental by default: only files whose mtime differs from
 * the stored one (or that are new) are parsed. `full: true` re-parses everything.
 */
export async function scanDirectory(musicDir, { full = false, reextractCovers = false, onProgress = null } = {}) {
  const root = path.resolve(musicDir);
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('Music directory is unavailable');
  await fs.access(root);
  const startedAt = Date.now();

  onProgress?.({ phase: 'listing', total: 0, processed: 0 });

  const files = await listAudioFiles(root);
  console.log(`Found ${files.length} audio files (${full ? 'full' : 'incremental'} scan)`);

  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const { rows: known } = await query(
    'SELECT id, file_path, album_id, mtime, missing_since FROM tracks WHERE starts_with(file_path, $1)',
    [prefix]
  );
  const knownByPath = new Map(known.map((r) => [r.file_path, r]));

  const onDisk = new Set();
  const toProcess = [];
  const touchedAlbumIds = new Set();

  for (const f of files) {
    onDisk.add(f.path);
    const k = knownByPath.get(f.path);
    if (full || !k || k.missing_since || !k.mtime || k.mtime.getTime() !== f.mtime.getTime() || k.album_id == null) {
      toProcess.push(f);
      if (k?.album_id) touchedAlbumIds.add(k.album_id);
    }
  }
  const unchanged = files.length - toProcess.length;
  console.log(`Unchanged: ${unchanged}, to process: ${toProcess.length}`);

  onProgress?.({
    phase: 'processing',
    total: files.length,
    toProcess: toProcess.length,
    processed: 0,
    unchanged,
  });

  const staleRows = known.filter((r) => !onDisk.has(r.file_path));
  const staleIds = staleRows.map((r) => r.id);
  for (const r of staleRows) {
    if (r.album_id) touchedAlbumIds.add(r.album_id);
  }

  let processed = 0;
  let removed = 0;
  let parseErrors = 0;

  const client = await getClient();
  try {
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const parsed = await mapLimit(toProcess.slice(i, i + BATCH_SIZE), PARSE_CONCURRENCY, parseTrackFile);
      for (const p of parsed) {
        if (p.parseError) parseErrors++;
      }
      processed += await writeBatch(client, parsed, touchedAlbumIds);
      console.log(`Processed ${processed}/${toProcess.length}`);
      onProgress?.({
        phase: 'processing',
        total: files.length,
        toProcess: toProcess.length,
        processed,
        unchanged,
        errors: parseErrors,
      });
    }

    onProgress?.({ phase: 'cleaning', total: files.length, processed, unchanged, errors: parseErrors });

    // A disappearing mount is indistinguishable from deletion during one walk.
    // Retain track IDs and dependent favorites/playlists/history indefinitely.
    if (staleIds.length) {
      await client.query('UPDATE tracks SET missing_since = COALESCE(missing_since, NOW()) WHERE id = ANY($1::int[])', [staleIds]);
      console.warn(`Marked ${staleIds.length} missing tracks; no user data deleted`);
    }
    if (files.length) {
      await client.query('UPDATE tracks SET missing_since = NULL WHERE file_path = ANY($1::text[]) AND missing_since IS NOT NULL', [files.map(f => f.path)]);
    }

    // Clean up empty albums/artists
    await removeOrphans(client);

    // Refresh album metadata across all member tracks in DB
    await refreshAlbumsMetadata(client, touchedAlbumIds);
  } finally {
    client.release();
  }

  let coversExtracted = 0;
  let coversTotal = 0;

  onProgress?.({ phase: 'covers', total: files.length, processed, coversExtracted: 0, coversTotal: 0 });

  const coverProgressCallback = (extracted, total) => {
    coversExtracted = extracted;
    coversTotal = total;
    onProgress?.({ phase: 'covers', total: files.length, processed, coversExtracted, coversTotal });
  };

  if (full || reextractCovers) {
    const covers = await extractAllMissingCovers({ force: true, onProgress: coverProgressCallback });
    coversExtracted = covers.extracted;
    coversTotal = covers.total;
  } else {
    // 1. Force re-extract for touched albums so retagged/moved tracks update the cover
    if (touchedAlbumIds.size > 0) {
      const touchedCovers = await extractAllMissingCovers({
        albumIds: [...touchedAlbumIds],
        force: true,
        onProgress: coverProgressCallback,
      });
      coversExtracted += touchedCovers.extracted;
      coversTotal += touchedCovers.total;
    }
    // 2. Extract for any other albums still missing covers
    const missingCovers = await extractAllMissingCovers({ force: false, onProgress: coverProgressCallback });
    coversExtracted += missingCovers.extracted;
    coversTotal += missingCovers.total;
  }

  console.log(`Covers extracted: ${coversExtracted}/${coversTotal}`);

  const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`Scan complete in ${durationSeconds}s. Processed ${processed} files.`);
  const finalResult = { total: files.length, processed, unchanged, removed, missing: staleIds.length, errors: parseErrors, covers: coversExtracted, durationSeconds };
  onProgress?.({ phase: 'complete', ...finalResult });
  return finalResult;
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
      if (written > 0 && touched.size > 0) {
        await refreshAlbumsMetadata(client, touched);
      }
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
