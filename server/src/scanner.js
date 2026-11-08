import { splitArtists, readMetadata, saveTrackMetadata, albumReleaseKey } from './metadata.js';
import fs from 'fs/promises';
import path from 'path';
import { computeFileHashes } from './file-fingerprints.js';
import { glob } from 'glob';
import { parseFile } from 'music-metadata';
import { query, getClient } from './db.js';
import { extractAllMissingCovers, deleteTrackCover, findAlbumsWithChangedFolderCovers } from './cover.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
const BATCH_SIZE = 300;
const PARSE_CONCURRENCY = 12;
const PG_INT_MAX = 2147483647;
const MIN_UNIQUE_AUDIO_PAYLOAD_BYTES = 512;

export function extractAudioPayload(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return Buffer.alloc(0);
  let start = 0;
  let end = buf.length;

  // Strip leading ID3v2 tag(s) if valid syncsafe header
  while (
    start + 10 <= end &&
    buf[start] === 0x49 &&
    buf[start + 1] === 0x44 &&
    buf[start + 2] === 0x33 &&
    buf[start + 3] < 0xff &&
    buf[start + 4] < 0xff &&
    buf[start + 6] < 0x80 &&
    buf[start + 7] < 0x80 &&
    buf[start + 8] < 0x80 &&
    buf[start + 9] < 0x80
  ) {
    const flags = buf[start + 5];
    const tagSize =
      ((buf[start + 6] & 0x7f) << 21) |
      ((buf[start + 7] & 0x7f) << 14) |
      ((buf[start + 8] & 0x7f) << 7) |
      (buf[start + 9] & 0x7f);
    const footer = (flags & 0x10) ? 10 : 0;
    const nextStart = start + 10 + tagSize + footer;
    if (nextStart <= end && nextStart > start) {
      start = nextStart;
    } else {
      break;
    }
  }

  // Strip trailing ID3v1 tag (128 bytes starting with 'TAG')
  if (
    end - start >= 128 &&
    buf[end - 128] === 0x54 &&
    buf[end - 127] === 0x41 &&
    buf[end - 126] === 0x47
  ) {
    end -= 128;
  }

  return buf.subarray(start, end);
}

export { computeFileHashes } from './file-fingerprints.js';

function stripExt(str) {
  if (!str) return '';
  return String(str).replace(/\.(mp3|flac|ogg|wav|m4a|aac|wma|opus)$/i, '').trim();
}

function extractFilenameTrackNumber(fileName) {
  const s = stripExt(fileName);
  if (!s) return null;
  let m = s.match(/^\s*(?:(?:cd|disc|disk)\s*\d+\s*[-_.\s]+)?0*(\d{1,3})(?:\s*[-_.)\]]+|\s+)/i);
  if (m) return Number(m[1]);
  m = s.match(/^\s*track[\s_.-]*0*(\d{1,3})\b/i);
  if (m) return Number(m[1]);
  return null;
}

function isAudioFile(filePath) {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function toInt(v) {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && Math.abs(n) <= PG_INT_MAX ? n : null;
}

function toBigIntStr(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? String(n) : null;
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function extractLeadingArtist(name) {
  if (!name) return null;
  return splitArtists(name)[0] || null;
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
    const key = `${normFolder.toLowerCase()}\u0000${title.toLowerCase()}`;
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
      compilation: inferred.compilation || group.tracks.some(t => t.metadata?.compilation),
      releaseKey: albumReleaseKey(group.normFolder, sample.metadata),
      year: sample.year,
      genre: sample.genre,
    });
  }

  // Pre-calculate canonical artist name and preserve full track artist credit
  for (const item of items) {
    item.canonicalArtistName = item.metadata?.artists?.[0]?.name || extractLeadingArtist(item.artistName) || item.artistName;
    item.trackArtistCredit = item.artistName || null;
    item.albumArtistCredit = item.albumArtistName || null;
    item.parseError = Boolean(item.parseError);
  }

  // 2. Artists: collect ONLY canonical artist names + inferred album artists (no comma/feat composites)
  const uniqueArtistMap = new Map();
  for (const name of [
    ...items.map((i) => i.canonicalArtistName).filter(Boolean),
    ...albumMetaList.map((a) => extractLeadingArtist(a.albumArtistName) || a.albumArtistName).filter(Boolean),
  ]) {
    const lower = name.toLowerCase();
    if (!uniqueArtistMap.has(lower)) {
      uniqueArtistMap.set(lower, name);
    }
  }
  const allArtistNames = Array.from(uniqueArtistMap.values());

  const artistMap = new Map();
  if (allArtistNames.length > 0) {
    const { rows: existingArtists } = await client.query(
      `SELECT id, name FROM artists WHERE LOWER(name) = ANY($1::text[])`,
      [allArtistNames.map((n) => n.toLowerCase())]
    );
    for (const r of existingArtists) {
      artistMap.set(r.name.toLowerCase(), r.id);
      artistMap.set(r.name, r.id);
    }
    const newArtistNames = allArtistNames.filter((n) => !artistMap.has(n.toLowerCase()));
    if (newArtistNames.length > 0) {
      const { rows: inserted } = await client.query(
        `INSERT INTO artists (name)
         SELECT n FROM unnest($1::text[]) AS n
         ON CONFLICT (LOWER(name)) DO UPDATE SET name = artists.name
         RETURNING id, name`,
        [newArtistNames]
      );
      for (const r of inserted) {
        artistMap.set(r.name.toLowerCase(), r.id);
        artistMap.set(r.name, r.id);
      }
    }
  }

  // 3. Albums: look up existing albums in DB by folder_path OR (title, artist_id)
  for (const a of albumMetaList) {
    a.artistId = a.albumArtistName ? (artistMap.get(a.albumArtistName.toLowerCase()) ?? artistMap.get(a.albumArtistName) ?? null) : null;
  }

  const titles = albumMetaList.map((a) => a.title.toLowerCase());
  const folders = albumMetaList.map((a) => a.normFolder.toLowerCase());
  const artistIds = albumMetaList.map((a) => a.artistId).filter((id) => id !== null);

  const { rows: existingAlbumRows } = await client.query(
    `SELECT id, title, folder_path, artist_id, release_key,
            ARRAY(SELECT t.file_path FROM tracks t WHERE t.album_id = albums.id AND t.missing_since IS NULL) AS member_paths
     FROM albums
     WHERE LOWER(folder_path) = ANY($1::text[])
        OR (LOWER(title) = ANY($2::text[]) AND artist_id = ANY($3::int[]))`,
    [folders, titles, artistIds]
  );

  const albumMap = new Map();

  for (const a of albumMetaList) {
    const normFolderLower = a.normFolder.toLowerCase();
    const titleLower = a.title.toLowerCase();

    // Exact match on folder_path + title (case-insensitive) first
    let match = existingAlbumRows.find(
      (r) => r.folder_path && r.folder_path.toLowerCase() === normFolderLower && r.title.toLowerCase() === titleLower
    );
    // A title change preserves album identity only when this group contains every live member.
    if (!match) {
      match = existingAlbumRows.find(
        (r) => r.folder_path && r.folder_path.toLowerCase() === normFolderLower &&
          r.member_paths?.length > 0 && r.member_paths.every(file =>
            albumGroups.get(a.groupKey).tracks.some(track => track.filePath === file))
      );
    }
    // If not found, match on title + artist_id (case-insensitive, album was moved to another folder)
    if (!match && a.artistId != null) {
      match = existingAlbumRows.find(
        (r) => r.title.toLowerCase() === titleLower && r.artist_id === a.artistId &&
          (r.release_key === a.releaseKey || (!r.folder_path && !r.release_key) ||
           (r.member_paths.length > 0 && r.member_paths.every(file => albumGroups.get(a.groupKey).tracks.some(track => track.filePath === file))))
      );
    }

    if (match) {
      if (match.folder_path !== a.normFolder || match.title !== a.title) {
        await client.query('UPDATE albums SET folder_path = $1, title = $2, release_key = $4 WHERE id = $3', [a.normFolder, a.title, match.id, a.releaseKey]);
        match.folder_path = a.normFolder;
        match.title = a.title;
        match.release_key = a.releaseKey;
      }
      albumMap.set(a.groupKey, match.id);
    }
  }

  // Albums that need to be inserted or upserted
  const albumsToUpsert = albumMetaList.filter((a) => !albumMap.has(a.groupKey));

  if (albumsToUpsert.length > 0) {
    const { rows: upsertedRows } = await client.query(
      `INSERT INTO albums (title, artist_id, year, genre, folder_path, compilation, release_key)
       SELECT * FROM unnest(
         $1::text[], $2::int[], $3::int[], $4::text[], $5::text[], $6::boolean[], $7::text[]
       )
       ON CONFLICT (LOWER(title), artist_id, release_key) DO UPDATE SET
         year = COALESCE(EXCLUDED.year, albums.year),
         genre = COALESCE(EXCLUDED.genre, albums.genre),
         folder_path = COALESCE(EXCLUDED.folder_path, albums.folder_path),
         compilation = COALESCE(EXCLUDED.compilation, albums.compilation)
       RETURNING id, title, folder_path, artist_id, release_key`,
      [
        albumsToUpsert.map((a) => a.title),
        albumsToUpsert.map((a) => a.artistId),
        albumsToUpsert.map((a) => a.year),
        albumsToUpsert.map((a) => a.genre),
        albumsToUpsert.map((a) => a.normFolder),
        albumsToUpsert.map((a) => a.compilation),
        albumsToUpsert.map((a) => a.releaseKey),
      ]
    );

    for (const r of upsertedRows) {
      const meta = albumsToUpsert.find(
        (a) => a.releaseKey === r.release_key && a.title.toLowerCase() === r.title.toLowerCase() && (a.artistId === r.artist_id || (a.normFolder && r.folder_path && a.normFolder.toLowerCase() === r.folder_path.toLowerCase()))
      );
      if (meta) {
        albumMap.set(meta.groupKey, r.id);
      } else if (r.folder_path) {
        albumMap.set(`${r.folder_path.toLowerCase()}\u0000${r.title.toLowerCase()}`, r.id);
      }
    }
  }

  // 4. Tracks: each track links to canonical artistId, while preserving raw featuring credit
  const cols = Array.from({ length: 23 }, () => []);
  for (const i of items) {
    const title = i.albumTitle || path.basename(normalizeAlbumFolder(i.folderPath));
    const normFolder = normalizeAlbumFolder(i.folderPath);
    const aKey = `${normFolder.toLowerCase()}\u0000${title.toLowerCase()}`;
    const albumId = albumMap.get(aKey) ?? null;
    const albumMeta = albumMetaList.find((a) => a.groupKey === aKey);

    // Prefer album artist if track starts with/matches it, else canonical track artist
    const canonicalName = i.canonicalArtistName || albumMeta?.albumArtistName || null;
    const trackArtistId = canonicalName ? (artistMap.get(canonicalName.toLowerCase()) ?? artistMap.get(canonicalName) ?? null) : null;

    if (albumId) touchedAlbumIds.add(albumId);
    [
      i.filePath, i.fileName, i.fileSize, i.duration, i.title,
      trackArtistId, albumId, i.trackNumber, i.discNumber, i.genre,
      i.year, i.bitrate, i.sampleRate, i.format, i.mtime, i.trackArtistCredit,
      i.albumArtistCredit, i.parseError,
      i.dev ?? null, i.ino ?? null, i.birthtimeMs ?? null, i.contentHash ?? null, i.audioHash ?? null,
    ].forEach((v, idx) => cols[idx].push(v));
  }

  await client.query(`DELETE FROM track_lyrics l USING tracks t
    WHERE l.track_id = t.id AND t.file_path = ANY($1::text[])`, [items.filter(i => !i.parseError).map(i => i.filePath)]);

  await client.query(
    `INSERT INTO tracks (
       file_path, file_name, file_size, duration, title,
       artist_id, album_id, track_number, disc_number, genre,
       year, bitrate, sample_rate, format, mtime, track_artist_credit,
       album_artist_credit, parse_error,
       dev, ino, birthtime_ms, content_hash, audio_hash
     )
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::bigint[], $4::real[], $5::text[],
       $6::int[], $7::int[], $8::int[], $9::int[], $10::text[],
       $11::int[], $12::int[], $13::int[], $14::text[], $15::timestamptz[], $16::text[],
       $17::text[], $18::boolean[],
       $19::bigint[], $20::bigint[], $21::bigint[], $22::text[], $23::text[]
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
       dev = EXCLUDED.dev,
       ino = EXCLUDED.ino,
       birthtime_ms = EXCLUDED.birthtime_ms,
       content_hash = EXCLUDED.content_hash,
       audio_hash = EXCLUDED.audio_hash,
       updated_at = NOW()`,
    cols
  );

  await saveTrackMetadata(client, items.filter(i => !i.parseError).map(i => ({ file_path: i.filePath, metadata: i.metadata })));
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

/** Parses tags and hashes into a flat record. Never throws: unreadable tags fall back to a basic entry. */
async function parseTrackFile({ path: filePath, size, mtime, dev = null, ino = null, nlink = 1, birthtimeMs = null }) {
  const fileName = path.basename(filePath);
  const { contentHash, audioHash, audioPayloadSize } = await computeFileHashes(filePath);
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
    dev,
    ino,
    nlink,
    birthtimeMs,
    contentHash,
    audioHash,
    audioPayloadSize,
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
      metadata: readMetadata(common, format),
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

/** Lists audio files with size/mtime/inode identity in a single directory walk (stat follows symlinks). */
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
      return {
        path: e.fullpath(),
        size: stat.size,
        mtime: stat.mtime,
        dev: toBigIntStr(stat.dev),
        ino: toBigIntStr(stat.ino),
        nlink: Number.isFinite(stat.nlink) ? stat.nlink : 1,
        birthtimeMs: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
          ? String(Math.round(stat.birthtimeMs))
          : null,
      };
    } catch { return null; }
  });
  return files.filter(Boolean);
}

/**
 * Merges a verified duplicate pair (missing original track row `originalId` + live duplicate row `duplicateLiveId`)
 * inside a transaction on `client`, preserving `originalId` and migrating all user references.
 */
export async function mergeDuplicateTrackPair(client, originalId, duplicateLiveId) {
  if (!originalId || !duplicateLiveId || originalId === duplicateLiveId) return false;

  const { rows: mRows } = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [originalId]);
  const { rows: lRows } = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [duplicateLiveId]);
  if (mRows.length === 0 || lRows.length === 0) return false;

  const m = mRows[0];
  const l = lRows[0];

  // Migrate user_starred_tracks
  await client.query(
    `UPDATE user_starred_tracks SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM user_starred_tracks u2
         WHERE u2.user_id = user_starred_tracks.user_id AND u2.track_id = $1
       )`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM user_starred_tracks WHERE track_id = $1', [l.id]);

  // Migrate playlist_tracks
  await client.query('UPDATE playlist_tracks SET track_id = $1 WHERE track_id = $2', [m.id, l.id]);

  // Migrate play_history
  await client.query('UPDATE play_history SET track_id = $1 WHERE track_id = $2', [m.id, l.id]);

  // Migrate user_ratings
  await client.query(
    `UPDATE user_ratings SET entity_id = $1
     WHERE entity_type = 'track' AND entity_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM user_ratings r2
         WHERE r2.user_id = user_ratings.user_id AND r2.entity_type = 'track' AND r2.entity_id = $1
       )`,
    [m.id, l.id]
  );
  await client.query("DELETE FROM user_ratings WHERE entity_type = 'track' AND entity_id = $1", [l.id]);

  // Migrate bookmarks
  await client.query(
    `UPDATE bookmarks SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM bookmarks b2
         WHERE b2.user_id = bookmarks.user_id AND b2.track_id = $1
       )`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM bookmarks WHERE track_id = $1', [l.id]);

  // Migrate play_queues
  await client.query('UPDATE play_queues SET current_track_id = $1 WHERE current_track_id = $2', [m.id, l.id]);
  await client.query(
    'UPDATE play_queues SET track_ids = array_replace(track_ids, $2, $1) WHERE $2 = ANY(track_ids)',
    [m.id, l.id]
  );

  // Migrate track_lyrics
  await client.query(
    `UPDATE track_lyrics SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (SELECT 1 FROM track_lyrics tl2 WHERE tl2.track_id = $1)`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM track_lyrics WHERE track_id = $1', [l.id]);

  // Migrate track_credits
  await client.query(
    `UPDATE track_credits SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM track_credits tc2
         WHERE tc2.track_id = $1 AND tc2.artist_id = track_credits.artist_id AND tc2.role = track_credits.role
       )`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM track_credits WHERE track_id = $1', [l.id]);

  // Migrate track_genres
  await client.query(
    `UPDATE track_genres SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM track_genres tg2
         WHERE tg2.track_id = $1 AND tg2.genre_id = track_genres.genre_id
       )`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM track_genres WHERE track_id = $1', [l.id]);

  // Delete the duplicate live row first to release UNIQUE(file_path)
  await client.query('DELETE FROM tracks WHERE id = $1', [l.id]);

  // Update the original track row with the live file path, metadata, and fingerprints
  await client.query(
    `UPDATE tracks SET
       file_path = $1,
       file_name = $2,
       file_size = $3,
       duration = $4,
       title = $5,
       artist_id = $6,
       album_id = $7,
       track_number = $8,
       disc_number = $9,
       genre = $10,
       year = $11,
       bitrate = $12,
       sample_rate = $13,
       format = $14,
       cover_path = COALESCE($15, cover_path),
       composer = COALESCE($16, composer),
       track_artist_credit = $17,
       album_artist_credit = $18,
       parse_error = $19,
       missing_since = NULL,
       mtime = $20,
       dev = $21,
       ino = $22,
       birthtime_ms = $23,
       content_hash = $24,
       audio_hash = $25,
       play_count = COALESCE(play_count, 0) + COALESCE($26, 0),
       last_played_at = GREATEST(last_played_at, $27),
       updated_at = NOW()
     WHERE id = $28`,
    [
      l.file_path,
      l.file_name,
      l.file_size,
      l.duration,
      l.title,
      l.artist_id,
      l.album_id,
      l.track_number,
      l.disc_number,
      l.genre,
      l.year,
      l.bitrate,
      l.sample_rate,
      l.format,
      l.cover_path,
      l.composer,
      l.track_artist_credit,
      l.album_artist_credit,
      l.parse_error,
      l.mtime,
      l.dev,
      l.ino,
      l.birthtime_ms,
      l.content_hash,
      l.audio_hash,
      l.play_count,
      l.last_played_at,
      m.id,
    ]
  );

  await deleteTrackCover(l.id).catch(() => {});
  return true;
}

function hasCompatibleSlot(oldRow, newItemOrRow) {
  const oldDisc = Number(oldRow.disc_number || 1);
  const newDisc = Number(newItemOrRow.discNumber ?? newItemOrRow.disc_number ?? 1);
  if (oldDisc !== newDisc) return false;

  const oldTrackNo = oldRow.track_number != null ? Number(oldRow.track_number) : null;
  const newTrackNo = (newItemOrRow.trackNumber ?? newItemOrRow.track_number) != null
    ? Number(newItemOrRow.trackNumber ?? newItemOrRow.track_number)
    : null;
  if (oldTrackNo != null && newTrackNo != null && oldTrackNo !== newTrackNo) {
    return false;
  }

  const oldFileTrackNo = extractFilenameTrackNumber(oldRow.file_name || path.basename(oldRow.file_path || ''));
  const newFileTrackNo = extractFilenameTrackNumber(newItemOrRow.fileName || newItemOrRow.file_name || path.basename(newItemOrRow.filePath || newItemOrRow.file_path || ''));
  if (oldFileTrackNo != null && newFileTrackNo != null && oldFileTrackNo !== newFileTrackNo) {
    return false;
  }

  return true;
}

function hasCompatibleFormatAndDuration(oldRow, newItemOrRow) {
  const oldFmt = String(oldRow.format || path.extname(oldRow.file_path || '').slice(1)).toLowerCase();
  const newFmt = String(newItemOrRow.format || path.extname(newItemOrRow.filePath || newItemOrRow.file_path || '').slice(1)).toLowerCase();
  if (oldFmt && newFmt && oldFmt !== newFmt) return false;

  const oldDur = Number(oldRow.duration || 0);
  const newDur = Number(newItemOrRow.duration || 0);
  if (oldDur > 0 && newDur > 0 && Math.abs(oldDur - newDur) > 1.5) return false;

  return true;
}

function hasCompatibleBirthtime(oldBirthtimeMs, newBirthtimeMs) {
  const a = Number(oldBirthtimeMs || 0);
  const b = Number(newBirthtimeMs || 0);
  if (a > 0 && b > 0) {
    return Math.abs(a - b) <= 5;
  }
  return true;
}

/**
 * Reconciles already-created live + missing duplicate track pairs under `prefix`
 * ONLY when both rows have matching verified stored hashes/fingerprints and 1:1 uniqueness.
 * Never merges rows that lack stored hashes or rely on metadata similarity alone.
 */
async function reconcileExistingDuplicatePairs(client, prefix, touchedAlbumIds) {
  const { rows: allRows } = await client.query(
    `SELECT id, file_path, file_name, file_size, duration, title, artist_id, album_id,
            track_number, disc_number, format, mtime, missing_since, metadata,
            dev, ino, birthtime_ms, content_hash, audio_hash
     FROM tracks
     WHERE starts_with(file_path, $1)
     ORDER BY id ASC`,
    [prefix]
  );

  const missingRows = allRows.filter((r) => r.missing_since != null);
  const liveRows = allRows.filter((r) => r.missing_since == null);
  if (missingRows.length === 0 || liveRows.length === 0) return 0;

  const missingContentCounts = new Map();
  const liveContentCounts = new Map();
  const missingDevInoCounts = new Map();
  const liveDevInoCounts = new Map();

  for (const m of missingRows) {
    if (m.content_hash) {
      missingContentCounts.set(m.content_hash, (missingContentCounts.get(m.content_hash) || 0) + 1);
    }
    if (m.dev != null && m.ino != null) {
      const k = `${m.dev}:${m.ino}`;
      missingDevInoCounts.set(k, (missingDevInoCounts.get(k) || 0) + 1);
    }
  }
  for (const l of liveRows) {
    if (l.content_hash) {
      liveContentCounts.set(l.content_hash, (liveContentCounts.get(l.content_hash) || 0) + 1);
    }
    if (l.dev != null && l.ino != null) {
      const k = `${l.dev}:${l.ino}`;
      liveDevInoCounts.set(k, (liveDevInoCounts.get(k) || 0) + 1);
    }
  }

  const matchedMissingIds = new Set();
  const matchedLiveIds = new Set();
  const pairs = [];

  // Pass 1: Exact verified full-file content_hash match (1:1 between missing and live)
  for (const m of missingRows) {
    if (!m.content_hash || Number(m.file_size) <= 0) continue;
    if (missingContentCounts.get(m.content_hash) !== 1) continue;
    if (liveContentCounts.get(m.content_hash) !== 1) continue;

    const l = liveRows.find((r) => !matchedLiveIds.has(r.id) && r.content_hash === m.content_hash);
    if (!l) continue;
    if (Number(l.file_size) !== Number(m.file_size)) continue;
    if (!hasCompatibleFormatAndDuration(m, l)) continue;

    const sameFolder =
      normalizeAlbumFolder(path.dirname(m.file_path)).toLowerCase() ===
      normalizeAlbumFolder(path.dirname(l.file_path)).toLowerCase();
    if (sameFolder && !hasCompatibleSlot(m, l)) continue;

    matchedMissingIds.add(m.id);
    matchedLiveIds.add(l.id);
    pairs.push({ missing: m, live: l });
  }

  // Pass 2: Durable (dev, ino) + verified audio_hash + birthtime guard (1:1 between missing and live)
  for (const m of missingRows) {
    if (matchedMissingIds.has(m.id)) continue;
    if (m.dev == null || m.ino == null || !m.audio_hash) continue;
    const key = `${m.dev}:${m.ino}`;
    if (missingDevInoCounts.get(key) !== 1) continue;
    if (liveDevInoCounts.get(key) !== 1) continue;

    const l = liveRows.find(
      (r) => !matchedLiveIds.has(r.id) && r.dev != null && r.ino != null && `${r.dev}:${r.ino}` === key
    );
    if (!l || !l.audio_hash || l.audio_hash !== m.audio_hash) continue;
    if (!hasCompatibleBirthtime(m.birthtime_ms, l.birthtime_ms)) continue;
    if (!hasCompatibleFormatAndDuration(m, l)) continue;
    if (!hasCompatibleSlot(m, l)) continue;

    const sameFolderOrAlbum =
      (m.album_id != null && m.album_id === l.album_id) ||
      normalizeAlbumFolder(path.dirname(m.file_path)).toLowerCase() ===
        normalizeAlbumFolder(path.dirname(l.file_path)).toLowerCase();
    if (!sameFolderOrAlbum) continue;

    matchedMissingIds.add(m.id);
    matchedLiveIds.add(l.id);
    pairs.push({ missing: m, live: l });
  }

  let mergedCount = 0;
  for (const { missing, live } of pairs) {
    try {
      const ok = await inTransaction(client, () => mergeDuplicateTrackPair(client, missing.id, live.id));
      if (ok) {
        mergedCount++;
        if (missing.album_id) touchedAlbumIds.add(missing.album_id);
        if (live.album_id) touchedAlbumIds.add(live.album_id);
      }
    } catch (err) {
      console.error(`Failed to merge duplicate track pair (${missing.id} <- ${live.id}): ${err.message}`);
    }
  }
  return mergedCount;
}

async function removeOrphans(client) {
  await client.query(
    `DELETE FROM albums al WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id)`
  );
  await client.query(
    `DELETE FROM artists a
     WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM albums al WHERE al.artist_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM track_credits c WHERE c.artist_id = a.id)`
  );
}

/**
 * Recomputes and updates album-level metadata across all tracks belonging to the album
 * in the database, preferring available tracks when present.
 */
export async function refreshAlbumsMetadata(client, touchedAlbumIds, { transactionActive = false } = {}) {
  if (!touchedAlbumIds || touchedAlbumIds.size === 0) return;
  const albumIds = [...touchedAlbumIds].filter(Boolean);
  if (albumIds.length === 0) return;

  for (const albumId of albumIds) {
    const { rows: allTracks } = await client.query(
      `SELECT t.id, t.title, t.track_number, t.disc_number, t.genre, t.year,
              t.track_artist_credit, t.album_artist_credit, t.artist_id,
              t.missing_since, t.metadata,
              a.name AS artist_name
       FROM tracks t
       LEFT JOIN artists a ON t.artist_id = a.id
       WHERE t.album_id = $1`,
      [albumId]
    );

    if (allTracks.length === 0) continue;
    const availableTracks = allTracks.filter((t) => t.missing_since == null);
    const tracks = availableTracks.length > 0 ? availableTracks : allTracks;

    // Disc count: max disc number across available tracks
    const maxDisc = Math.max(1, ...tracks.map((t) => Math.max(t.disc_number || 1, t.metadata?.discTotal || 1)));

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

    // Inferred album artist & compilation flag across tracks
    const tracksForInference = tracks.map((t) => ({
      albumArtistName: t.album_artist_credit,
      artistName: t.artist_name || t.track_artist_credit,
    }));
    const inferred = inferAlbumArtist(tracksForInference);
    const canonicalAlbumArtist = extractLeadingArtist(inferred.name) || inferred.name;

    // Find or insert canonical album artist in artists table (case-insensitive)
    let artistId = null;
    if (canonicalAlbumArtist) {
      const artLookup = await client.query(
        `SELECT id FROM artists WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [canonicalAlbumArtist]
      );
      if (artLookup.rows.length > 0) {
        artistId = artLookup.rows[0].id;
      } else {
        const artRes = await client.query(
          `INSERT INTO artists (name) VALUES ($1)
           ON CONFLICT (LOWER(name)) DO UPDATE SET name = artists.name
           RETURNING id`,
          [canonicalAlbumArtist]
        );
        artistId = artRes.rows[0]?.id || null;
      }
    }

    // Check existing album row
    const { rows: albRows } = await client.query(
      'SELECT id, title, artist_id, release_key FROM albums WHERE id = $1',
      [albumId]
    );
    if (albRows.length === 0) continue;
    const albumTitle = albRows[0].title;

    // If another album already exists with (title, artistId), merge tracks to avoid conflict
    if (artistId != null) {
      const { rows: conflictRows } = await client.query(
        'SELECT id FROM albums WHERE LOWER(title) = LOWER($1) AND artist_id = $2 AND id != $3 AND release_key=$4',
        [albumTitle, artistId, albumId, albRows[0].release_key]
      );
      if (conflictRows.length > 0) {
        const targetAlbumId = conflictRows[0].id;
        const merge = async () => {
          await client.query('SELECT id FROM albums WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[albumId, targetAlbumId]]);
          await client.query('UPDATE tracks SET album_id = $1 WHERE album_id = $2', [targetAlbumId, albumId]);
          await client.query(`INSERT INTO user_starred_albums (user_id, album_id, created_at)
            SELECT user_id, $1, created_at FROM user_starred_albums WHERE album_id = $2
            ON CONFLICT DO NOTHING`, [targetAlbumId, albumId]);
          await client.query(`INSERT INTO user_ratings (user_id, entity_type, entity_id, rating, created_at)
            SELECT user_id, entity_type, $1, rating, created_at FROM user_ratings
            WHERE entity_type = 'album' AND entity_id = $2 ON CONFLICT DO NOTHING`, [targetAlbumId, albumId]);
          await client.query("DELETE FROM user_ratings WHERE entity_type = 'album' AND entity_id = $1", [albumId]);
          await client.query(`INSERT INTO album_credits (album_id, artist_id, role, credited_as)
            SELECT $1, artist_id, role, credited_as FROM album_credits WHERE album_id = $2
            ON CONFLICT DO NOTHING`, [targetAlbumId, albumId]);
          await client.query(`UPDATE albums target SET cover_path = COALESCE(target.cover_path, source.cover_path)
            FROM albums source WHERE target.id = $1 AND source.id = $2`, [targetAlbumId, albumId]);
          await client.query('DELETE FROM albums WHERE id = $1', [albumId]);
        };
        if (transactionActive) await merge();
        else await inTransaction(client, merge);
        touchedAlbumIds.add(targetAlbumId);
        if (!albumIds.includes(targetAlbumId)) albumIds.push(targetAlbumId);
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
           disc_count = $5,
           musicbrainz_id = $7
       WHERE id = $6`,
      [consensusYear, consensusGenre, artistId, inferred.compilation || tracks.some(t => t.metadata?.compilation), maxDisc, albumId, tracks.find(t => t.metadata?.albumMusicBrainzId)?.metadata.albumMusicBrainzId || null]
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
    `SELECT id, file_path, file_name, file_size, duration, title, artist_id, album_id,
            track_number, disc_number, format, mtime, missing_since, metadata,
            dev, ino, birthtime_ms, content_hash, audio_hash
     FROM tracks
     WHERE starts_with(file_path, $1)`,
    [prefix]
  );

  const onDisk = new Set(files.map((f) => f.path));
  const knownByPath = new Map(known.map((r) => [r.file_path, r]));
  const knownByLowerPath = new Map();
  for (const r of known) {
    if (!onDisk.has(r.file_path)) {
      knownByLowerPath.set(r.file_path.toLowerCase(), r);
    }
  }

  const claimedKnownIds = new Set();
  const toProcess = [];
  const unmatchedFiles = [];
  const needsIdentityBackfill = [];
  const touchedAlbumIds = new Set();
  const pathUpdates = [];

  for (const f of files) {
    let k = knownByPath.get(f.path);
    if (!k) {
      const lowerCandidate = knownByLowerPath.get(f.path.toLowerCase());
      if (lowerCandidate && !claimedKnownIds.has(lowerCandidate.id)) {
        const oldFolder = path.dirname(lowerCandidate.file_path);
        const newFolder = path.dirname(f.path);
        pathUpdates.push({
          id: lowerCandidate.id,
          newPath: f.path,
          newFileName: path.basename(f.path),
          albumId: lowerCandidate.album_id,
          oldFolder,
          newFolder,
        });
        knownByPath.delete(lowerCandidate.file_path);
        lowerCandidate.file_path = f.path;
        lowerCandidate.file_name = path.basename(f.path);
        lowerCandidate.missing_since = null;
        knownByPath.set(f.path, lowerCandidate);
        k = lowerCandidate;
        if (k.album_id) touchedAlbumIds.add(k.album_id);
      }
    }

    if (k) {
      claimedKnownIds.add(k.id);
    } else {
      unmatchedFiles.push(f);
    }

    if (full || !k || k.missing_since || !k.mtime || k.mtime.getTime() !== f.mtime.getTime() || k.album_id == null || !k.metadata || Object.keys(k.metadata).length === 0) {
      toProcess.push(f);
      if (k?.album_id) touchedAlbumIds.add(k.album_id);
    } else if (k.dev == null || k.ino == null || k.content_hash == null || k.audio_hash == null) {
      needsIdentityBackfill.push({ row: k, file: f });
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

  // Pre-parse unmatched files when there are unclaimed DB rows so we can safely reconcile renames
  // before writing batches or marking old rows as missing.
  const parsedCache = new Map();
  const unclaimedRows = known.filter((r) => !claimedKnownIds.has(r.id));

  if (unmatchedFiles.length > 0 && unclaimedRows.length > 0) {
    const parsedUnmatched = await mapLimit(unmatchedFiles, PARSE_CONCURRENCY, parseTrackFile);
    for (const p of parsedUnmatched) {
      parsedCache.set(p.filePath, p);
    }

    // Frequency maps for strict 1:1 uniqueness & hardlink/duplicate protection
    const diskDevInoCounts = new Map();
    for (const f of files) {
      if (f.dev != null && f.ino != null) {
        const key = `${f.dev}:${f.ino}`;
        diskDevInoCounts.set(key, (diskDevInoCounts.get(key) || 0) + 1);
      }
    }

    const claimedRows = known.filter((r) => claimedKnownIds.has(r.id));
    const liveContentHashSet = new Set(claimedRows.map((r) => r.content_hash).filter(Boolean));
    const liveAudioHashSet = new Set(claimedRows.map((r) => r.audio_hash).filter(Boolean));
    const liveDevInoSet = new Set(
      claimedRows.filter((r) => r.dev != null && r.ino != null).map((r) => `${r.dev}:${r.ino}`)
    );

    const unmatchedContentCounts = new Map();
    const unmatchedAudioCounts = new Map();
    const unmatchedDevInoCounts = new Map();
    for (const item of parsedUnmatched) {
      if (item.contentHash) {
        unmatchedContentCounts.set(item.contentHash, (unmatchedContentCounts.get(item.contentHash) || 0) + 1);
      }
      if (item.audioHash) {
        unmatchedAudioCounts.set(item.audioHash, (unmatchedAudioCounts.get(item.audioHash) || 0) + 1);
      }
      if (item.dev != null && item.ino != null) {
        const key = `${item.dev}:${item.ino}`;
        unmatchedDevInoCounts.set(key, (unmatchedDevInoCounts.get(key) || 0) + 1);
      }
    }

    const unclaimedContentCounts = new Map();
    const unclaimedAudioCounts = new Map();
    const unclaimedDevInoCounts = new Map();
    for (const r of unclaimedRows) {
      if (r.content_hash) {
        unclaimedContentCounts.set(r.content_hash, (unclaimedContentCounts.get(r.content_hash) || 0) + 1);
      }
      if (r.audio_hash) {
        unclaimedAudioCounts.set(r.audio_hash, (unclaimedAudioCounts.get(r.audio_hash) || 0) + 1);
      }
      if (r.dev != null && r.ino != null) {
        const key = `${r.dev}:${r.ino}`;
        unclaimedDevInoCounts.set(key, (unclaimedDevInoCounts.get(key) || 0) + 1);
      }
    }

    const reconciledRowIds = new Set();
    const reconciledPaths = new Set();

    const recordRenameMatch = (oldRow, item) => {
      reconciledRowIds.add(oldRow.id);
      reconciledPaths.add(item.filePath);
      claimedKnownIds.add(oldRow.id);
      const oldFolder = path.dirname(oldRow.file_path);
      const newFolder = path.dirname(item.filePath);
      pathUpdates.push({
        id: oldRow.id,
        newPath: item.filePath,
        newFileName: item.fileName,
        albumId: oldRow.album_id,
        oldFolder,
        newFolder,
      });
      knownByPath.delete(oldRow.file_path);
      oldRow.file_path = item.filePath;
      oldRow.file_name = item.fileName;
      oldRow.missing_since = null;
      knownByPath.set(item.filePath, oldRow);
      if (oldRow.album_id) touchedAlbumIds.add(oldRow.album_id);
    };

    // Pass 1: Verified full-file content_hash match (1:1 between unclaimed DB rows and unmatched files)
    for (const item of parsedUnmatched) {
      if (reconciledPaths.has(item.filePath)) continue;
      if (!item.contentHash || Number(item.fileSize) <= 0) continue;
      if (unmatchedContentCounts.get(item.contentHash) !== 1) continue;
      if (unclaimedContentCounts.get(item.contentHash) !== 1) continue;

      const oldRow = unclaimedRows.find(
        (r) => !reconciledRowIds.has(r.id) && r.content_hash === item.contentHash
      );
      if (!oldRow) continue;
      if (Number(oldRow.file_size) !== Number(item.fileSize)) continue;
      if (!hasCompatibleFormatAndDuration(oldRow, item)) continue;

      const sameInode =
        oldRow.dev != null &&
        oldRow.ino != null &&
        item.dev != null &&
        item.ino != null &&
        String(oldRow.dev) === String(item.dev) &&
        String(oldRow.ino) === String(item.ino) &&
        item.nlink === 1 &&
        !liveDevInoSet.has(`${item.dev}:${item.ino}`);

      // Guard against matching a newly added duplicate copy of an already-live track
      if (liveContentHashSet.has(item.contentHash) && !sameInode) continue;

      const sameFolder =
        normalizeAlbumFolder(path.dirname(oldRow.file_path)).toLowerCase() ===
        normalizeAlbumFolder(item.folderPath).toLowerCase();
      if (sameFolder && !hasCompatibleSlot(oldRow, item)) continue;

      recordRenameMatch(oldRow, item);
    }

    // Pass 2: Durable (dev, ino) match with inode-reuse & hardlink guards
    for (const item of parsedUnmatched) {
      if (reconciledPaths.has(item.filePath)) continue;
      if (item.dev == null || item.ino == null) continue;
      if (item.nlink !== 1) continue;

      const devInoKey = `${item.dev}:${item.ino}`;
      if (diskDevInoCounts.get(devInoKey) !== 1) continue;
      if (liveDevInoSet.has(devInoKey)) continue;
      if (unmatchedDevInoCounts.get(devInoKey) !== 1) continue;
      if (unclaimedDevInoCounts.get(devInoKey) !== 1) continue;

      const oldRow = unclaimedRows.find(
        (r) =>
          !reconciledRowIds.has(r.id) &&
          r.dev != null &&
          r.ino != null &&
          `${r.dev}:${r.ino}` === devInoKey
      );
      if (!oldRow) continue;

      // Inode reuse guards:
      // 1. Birthtime must match when available
      if (!hasCompatibleBirthtime(oldRow.birthtime_ms, item.birthtimeMs)) continue;
      // 2. Content hash or stripped audio payload hash must match
      const hashMatches =
        (oldRow.content_hash != null && item.contentHash != null && oldRow.content_hash === item.contentHash) ||
        (oldRow.audio_hash != null && item.audioHash != null && oldRow.audio_hash === item.audioHash);
      if (!hashMatches) continue;
      // 3. Compatible format, duration, and non-conflicting disc/track slot
      if (!hasCompatibleFormatAndDuration(oldRow, item)) continue;
      if (!hasCompatibleSlot(oldRow, item)) continue;

      const sameFolder =
        normalizeAlbumFolder(path.dirname(oldRow.file_path)).toLowerCase() ===
        normalizeAlbumFolder(item.folderPath).toLowerCase();
      const bothHaveBirthtime = Number(oldRow.birthtime_ms || 0) > 0 && Number(item.birthtimeMs || 0) > 0;
      if (!sameFolder && !bothHaveBirthtime) continue;

      recordRenameMatch(oldRow, item);
    }

    // Pass 3: Globally-unique verified non-stub audio_hash match in the same folder & track slot
    // (handles tag editors that rewrite the file to a new temp inode during rename + retag)
    for (const item of parsedUnmatched) {
      if (reconciledPaths.has(item.filePath)) continue;
      if (!item.audioHash || (item.audioPayloadSize || 0) <= MIN_UNIQUE_AUDIO_PAYLOAD_BYTES) continue;
      if (liveAudioHashSet.has(item.audioHash)) continue;
      if (unmatchedAudioCounts.get(item.audioHash) !== 1) continue;
      if (unclaimedAudioCounts.get(item.audioHash) !== 1) continue;

      const oldRow = unclaimedRows.find(
        (r) => !reconciledRowIds.has(r.id) && r.audio_hash === item.audioHash
      );
      if (!oldRow) continue;
      if (!hasCompatibleFormatAndDuration(oldRow, item)) continue;
      if (!hasCompatibleSlot(oldRow, item)) continue;

      const sameFolder =
        normalizeAlbumFolder(path.dirname(oldRow.file_path)).toLowerCase() ===
        normalizeAlbumFolder(item.folderPath).toLowerCase();
      if (!sameFolder) continue;

      recordRenameMatch(oldRow, item);
    }
  }

  const staleRows = known.filter((r) => !claimedKnownIds.has(r.id) && !onDisk.has(r.file_path));
  const staleIds = staleRows.map((r) => r.id);
  for (const r of staleRows) {
    if (r.album_id) touchedAlbumIds.add(r.album_id);
  }

  let processed = 0;
  let removed = 0;
  let parseErrors = 0;
  let mergedPairs = 0;

  const client = await getClient();
  try {
    if (pathUpdates.length > 0) {
      for (const upd of pathUpdates) {
        await client.query(
          'UPDATE tracks SET file_path = $1, file_name = $2, missing_since = NULL WHERE id = $3',
          [upd.newPath, upd.newFileName, upd.id]
        );
        if (upd.albumId && upd.oldFolder !== upd.newFolder) {
          const normNewFolder = normalizeAlbumFolder(upd.newFolder);
          await client.query('UPDATE albums SET folder_path = $1 WHERE id = $2', [normNewFolder, upd.albumId]);
        }
      }
    }

    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const slice = toProcess.slice(i, i + BATCH_SIZE);
      const parsed = await mapLimit(slice, PARSE_CONCURRENCY, async (f) => {
        return parsedCache.get(f.path) || parseTrackFile(f);
      });
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

    // Backfill durable file identity & hashes for pre-migration unchanged live tracks
    if (needsIdentityBackfill.length > 0) {
      const backfilled = await mapLimit(needsIdentityBackfill, PARSE_CONCURRENCY, async ({ row, file }) => {
        const { contentHash, audioHash } = await computeFileHashes(file.path);
        return {
          id: row.id,
          dev: file.dev,
          ino: file.ino,
          birthtimeMs: file.birthtimeMs,
          contentHash,
          audioHash,
        };
      });
      for (const b of backfilled) {
        await client.query(
          `UPDATE tracks
           SET dev = $1,
               ino = $2,
               birthtime_ms = $3,
               content_hash = $4,
               audio_hash = $5
           WHERE id = $6`,
          [b.dev, b.ino, b.birthtimeMs, b.contentHash, b.audioHash, b.id]
        );
      }
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

    // Repair already-created live+missing duplicate pairs when BOTH have matching verified stored hashes
    mergedPairs = await reconcileExistingDuplicatePairs(client, prefix, touchedAlbumIds);

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
    for (const id of await findAlbumsWithChangedFolderCovers()) touchedAlbumIds.add(id);
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
  const remainingMissing = Math.max(0, staleIds.length - mergedPairs);
  const finalResult = { total: files.length, processed, unchanged, removed, missing: remainingMissing, errors: parseErrors, covers: coversExtracted, durationSeconds };
  onProgress?.({ phase: 'complete', ...finalResult });
  return finalResult;
}

export async function scanSingleFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const item = await parseTrackFile({
      path: filePath,
      size: stat.size,
      mtime: stat.mtime,
      dev: toBigIntStr(stat.dev),
      ino: toBigIntStr(stat.ino),
      nlink: Number.isFinite(stat.nlink) ? stat.nlink : 1,
      birthtimeMs: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
        ? String(Math.round(stat.birthtimeMs))
        : null,
    });
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
