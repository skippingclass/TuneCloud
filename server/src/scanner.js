import {
  splitArtists,
  readMetadata,
  prepareTrackMetadataBatch,
  syncTrackCreditsAndMbids,
  albumReleaseKey,
} from './metadata.js';
import fs from 'fs/promises';
import path from 'path';
import { computeFileHashes, computeFileHashesBatch } from './file-fingerprints.js';
import { getNativeScanner } from './native-scanner.js';
import { glob } from 'glob';
import { parseFile, selectCover } from 'music-metadata';
import { query, getClient } from './db.js';
import {
  extractAllMissingCovers,
  deleteTrackCover,
  findAlbumsWithChangedFolderCovers,
  beginScanCoverSession,
  recordScannedTrackCover,
  endScanCoverSession,
} from './cover.js';
import { isWithinRoot } from './paths.js';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.wav', '.m4a', '.aac', '.wma', '.opus']);
const BATCH_SIZE = 300;
const HDD_TAG_CONCURRENCY = 2;
const LIST_STAT_CONCURRENCY = 4;
const HASH_BACKFILL_BATCH = 128;
const PG_INT_MAX = 2147483647;
const MIN_UNIQUE_AUDIO_PAYLOAD_BYTES = 512;
const MAX_INODE_SENTINEL = 9007199254740991n;

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

export { computeFileHashes, computeFileHashesBatch, computeFileHashesJs } from './file-fingerprints.js';

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

function sortFilesByInode(files) {
  return [...files]
    .map(file => ({
      file,
      dev: file.dev != null ? BigInt(file.dev) : MAX_INODE_SENTINEL,
      ino: file.ino != null ? BigInt(file.ino) : MAX_INODE_SENTINEL,
    }))
    .sort((a, b) => (
      a.dev < b.dev ? -1 : a.dev > b.dev ? 1 :
      a.ino < b.ino ? -1 : a.ino > b.ino ? 1 :
      a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0
    ))
    .map(entry => entry.file);
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

  let bestArtist = null;
  let maxCount = 0;
  for (const [artist, count] of counts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestArtist = artist;
    }
  }

  if (bestArtist && (maxCount >= Math.ceil(tracks.length * 0.4) || maxCount >= 2)) {
    return { name: extractLeadingArtist(bestArtist) || bestArtist, compilation: false };
  }

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
 * Upserts a batch of parsed tracks (artists -> albums -> tracks) in bulk,
 * writing `metadata` JSONB and `composer` directly inside `INSERT INTO tracks`
 * to avoid a second MVCC `UPDATE` pass over every row.
 */
async function flushTrackBatch(client, items, { hasExistingTracks = true } = {}) {
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

  for (const item of items) {
    item.canonicalArtistName = item.metadata?.artists?.[0]?.name || extractLeadingArtist(item.artistName) || item.artistName;
    item.trackArtistCredit = item.artistName || null;
    item.albumArtistCredit = item.albumArtistName || null;
    item.parseError = Boolean(item.parseError);
  }

  // Enrich `metadata` and `composer` (and insert any guest/composer artists with DO NOTHING)
  // BEFORE inserting into `tracks` so each row is written once.
  const validMetadataRecords = items
    .filter(i => !i.parseError && i.metadata)
    .map(i => ({ item: i, file_path: i.filePath, metadata: i.metadata }));
  if (validMetadataRecords.length > 0) {
    await prepareTrackMetadataBatch(client, validMetadataRecords);
    for (const rec of validMetadataRecords) {
      rec.item.metadata = rec.metadata;
      rec.item.composer = rec.composer ?? null;
    }
  }

  // 2. Canonical track & album artists
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
    await client.query(
      `INSERT INTO artists (name)
       SELECT DISTINCT ON (LOWER(n)) n FROM unnest($1::text[]) AS n
       ON CONFLICT (LOWER(name)) DO NOTHING`,
      [allArtistNames]
    );
    const { rows: resolvedArtists } = await client.query(
      `SELECT id, name FROM artists WHERE LOWER(name) = ANY($1::text[])`,
      [allArtistNames.map((n) => n.toLowerCase())]
    );
    for (const r of resolvedArtists) {
      artistMap.set(r.name.toLowerCase(), r.id);
      artistMap.set(r.name, r.id);
    }
  }

  // 3. Albums: look up existing albums in DB (skipped entirely on a fresh empty DB)
  for (const a of albumMetaList) {
    a.artistId = a.albumArtistName ? (artistMap.get(a.albumArtistName.toLowerCase()) ?? artistMap.get(a.albumArtistName) ?? null) : null;
  }

  const albumMap = new Map();

  if (hasExistingTracks) {
    const titles = albumMetaList.map((a) => a.title.toLowerCase());
    const folders = albumMetaList.map((a) => a.normFolder.toLowerCase());
    const artistIds = albumMetaList.map((a) => a.artistId).filter((id) => id !== null);

    const { rows: existingAlbumRows } = await client.query(
      `SELECT id, title, folder_path, artist_id, release_key,
              ARRAY(SELECT t.file_path FROM tracks t WHERE t.album_id = albums.id AND t.missing_since IS NULL) AS member_paths
       FROM albums
       WHERE LOWER(folder_path) = ANY($1::text[])
          OR (LOWER(title) = ANY($2::text[]) AND artist_id = ANY($3::int[]))
          OR (LOWER(title) = ANY($2::text[]) AND artist_id IS NULL)`,
      [folders, titles, artistIds]
    );

    const albumUpdates = [];
    for (const a of albumMetaList) {
      const normFolderLower = a.normFolder.toLowerCase();
      const titleLower = a.title.toLowerCase();

      let match = existingAlbumRows.find(
        (r) => r.folder_path && r.folder_path.toLowerCase() === normFolderLower && r.title.toLowerCase() === titleLower
      );
      if (!match) {
        match = existingAlbumRows.find(
          (r) => r.folder_path && r.folder_path.toLowerCase() === normFolderLower &&
            r.member_paths?.length > 0 && r.member_paths.every(file =>
              albumGroups.get(a.groupKey).tracks.some(track => track.filePath === file))
        );
      }
      if (!match) {
        match = existingAlbumRows.find(
          (r) => r.title.toLowerCase() === titleLower && r.artist_id === a.artistId &&
            ((r.release_key ?? '') === (a.releaseKey ?? '') || (!r.folder_path && !r.release_key) ||
             (r.member_paths.length > 0 && r.member_paths.every(file => albumGroups.get(a.groupKey).tracks.some(track => track.filePath === file))))
        );
      }

      if (match) {
        if (match.folder_path !== a.normFolder || match.title !== a.title || (match.release_key ?? '') !== (a.releaseKey ?? '')) {
          albumUpdates.push({ id: match.id, folder: a.normFolder, title: a.title, releaseKey: a.releaseKey ?? '' });
          match.folder_path = a.normFolder;
          match.title = a.title;
          match.release_key = a.releaseKey ?? '';
        }
        albumMap.set(a.groupKey, match.id);
      }
    }

    if (albumUpdates.length > 0) {
      await client.query(
        `UPDATE albums AS al
         SET folder_path = u.folder, title = u.title, release_key = u.release_key
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]) AS u(id, folder, title, release_key)
         WHERE al.id = u.id`,
        [
          albumUpdates.map(u => u.id),
          albumUpdates.map(u => u.folder),
          albumUpdates.map(u => u.title),
          albumUpdates.map(u => u.releaseKey),
        ]
      );
    }
  }

  const albumsToUpsert = albumMetaList.filter((a) => !albumMap.has(a.groupKey));
  if (albumsToUpsert.length > 0) {
    const withArtist = albumsToUpsert.filter((a) => a.artistId !== null);
    const withoutArtist = albumsToUpsert.filter((a) => a.artistId === null);
    const upsertedRows = [];

    for (const [slice, conflictTarget] of [
      [withArtist, '(LOWER(title), artist_id, release_key)'],
      [withoutArtist, '(LOWER(title), release_key) WHERE artist_id IS NULL'],
    ]) {
      if (slice.length === 0) continue;
      const { rows } = await client.query(
        `INSERT INTO albums (title, artist_id, year, genre, folder_path, compilation, release_key)
         SELECT * FROM unnest(
           $1::text[], $2::int[], $3::int[], $4::text[], $5::text[], $6::boolean[], $7::text[]
         )
         ON CONFLICT ${conflictTarget} DO UPDATE SET
           year = COALESCE(EXCLUDED.year, albums.year),
           genre = COALESCE(EXCLUDED.genre, albums.genre),
           folder_path = COALESCE(EXCLUDED.folder_path, albums.folder_path),
           compilation = COALESCE(EXCLUDED.compilation, albums.compilation)
         RETURNING id, title, folder_path, artist_id, release_key`,
        [
          slice.map((a) => a.title),
          slice.map((a) => a.artistId),
          slice.map((a) => a.year),
          slice.map((a) => a.genre),
          slice.map((a) => a.normFolder),
          slice.map((a) => a.compilation),
          slice.map((a) => a.releaseKey ?? ''),
        ]
      );
      upsertedRows.push(...rows);
    }

    for (const r of upsertedRows) {
      const meta = albumsToUpsert.find(
        (a) => (a.releaseKey ?? '') === (r.release_key ?? '') && a.title.toLowerCase() === r.title.toLowerCase() && (a.artistId === r.artist_id || (a.normFolder && r.folder_path && a.normFolder.toLowerCase() === r.folder_path.toLowerCase()))
      );
      if (meta) {
        albumMap.set(meta.groupKey, r.id);
      } else if (r.folder_path) {
        albumMap.set(`${r.folder_path.toLowerCase()}\u0000${r.title.toLowerCase()}`, r.id);
      }
    }
  }

  // 4. Single-pass `tracks` upsert (including `metadata` JSONB and `composer`)
  const albumMetaByKey = new Map(albumMetaList.map(a => [a.groupKey, a]));
  const cols = Array.from({ length: 25 }, () => []);
  for (const i of items) {
    const title = i.albumTitle || path.basename(normalizeAlbumFolder(i.folderPath));
    const normFolder = normalizeAlbumFolder(i.folderPath);
    const aKey = `${normFolder.toLowerCase()}\u0000${title.toLowerCase()}`;
    const albumId = albumMap.get(aKey) ?? null;
    const albumMeta = albumMetaByKey.get(aKey);

    const canonicalName = i.canonicalArtistName || albumMeta?.albumArtistName || null;
    const trackArtistId = canonicalName ? (artistMap.get(canonicalName.toLowerCase()) ?? artistMap.get(canonicalName) ?? null) : null;

    if (albumId) touchedAlbumIds.add(albumId);
    [
      i.filePath,
      i.fileName,
      i.fileSize,
      i.duration,
      i.title,
      trackArtistId,
      albumId,
      i.trackNumber,
      i.discNumber,
      i.genre,
      i.year,
      i.bitrate,
      i.sampleRate,
      i.format,
      i.mtime,
      i.trackArtistCredit,
      i.albumArtistCredit,
      i.parseError,
      i.dev ?? null,
      i.ino ?? null,
      i.birthtimeMs ?? null,
      i.contentHash ?? null,
      i.audioHash ?? null,
      JSON.stringify(i.metadata || {}),
      i.composer ?? null,
    ].forEach((v, idx) => cols[idx].push(v));
  }

  if (hasExistingTracks) {
    const updatedPaths = items.filter(i => !i.parseError).map(i => i.filePath);
    if (updatedPaths.length > 0) {
      await client.query(
        `DELETE FROM track_lyrics l USING tracks t
         WHERE l.track_id = t.id AND t.file_path = ANY($1::text[])`,
        [updatedPaths]
      );
    }
  }

  await client.query(
    `INSERT INTO tracks (
       file_path, file_name, file_size, duration, title,
       artist_id, album_id, track_number, disc_number, genre,
       year, bitrate, sample_rate, format, mtime, track_artist_credit,
       album_artist_credit, parse_error,
       dev, ino, birthtime_ms, content_hash, audio_hash,
       metadata, composer
     )
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::bigint[], $4::real[], $5::text[],
       $6::int[], $7::int[], $8::int[], $9::int[], $10::text[],
       $11::int[], $12::int[], $13::int[], $14::text[], $15::timestamptz[], $16::text[],
       $17::text[], $18::boolean[],
       $19::bigint[], $20::bigint[], $21::bigint[], $22::text[], $23::text[],
       $24::jsonb[], $25::text[]
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
       metadata = CASE WHEN EXCLUDED.parse_error THEN tracks.metadata ELSE EXCLUDED.metadata END,
       composer = CASE WHEN EXCLUDED.parse_error THEN tracks.composer ELSE EXCLUDED.composer END,
       updated_at = NOW()`,
    cols
  );

  if (validMetadataRecords.length > 0) {
    await syncTrackCreditsAndMbids(client, validMetadataRecords);
  }
  return touchedAlbumIds;
}

async function inTransaction(client, fn, { fastCommit = false } = {}) {
  await client.query('BEGIN');
  try {
    if (fastCommit) {
      await client.query("SET LOCAL synchronous_commit = 'off'");
    }
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  }
}

async function writeBatch(client, items, touchedAlbumIds, options = {}) {
  try {
    const ids = await inTransaction(client, () => flushTrackBatch(client, items, options), { fastCommit: true });
    ids.forEach((id) => touchedAlbumIds.add(id));
    return items.length;
  } catch (err) {
    console.error(`Batch write failed (${err.message}), retrying per track`);
  }
  let written = 0;
  for (const item of items) {
    try {
      const ids = await inTransaction(client, () => flushTrackBatch(client, [item], options), { fastCommit: true });
      ids.forEach((id) => touchedAlbumIds.add(id));
      written++;
    } catch (err) {
      console.error(`Could not write ${item.filePath}: ${err.message}`);
    }
  }
  return written;
}

/**
 * Parses tags (and captures embedded cover hashes in the same open handle).
 * Full-file SHA-256 hashing is omitted on the hot indexing path (`withHashes = false`)
 * so HDD heads read only header metadata rather than tens of gigabytes of audio.
 */
async function parseTrackFile(
  { path: filePath, size, mtime, dev = null, ino = null, nlink = 1, birthtimeMs = null },
  { withHashes = false, captureCover = false } = {}
) {
  const fileName = path.basename(filePath);
  const hashes = withHashes
    ? await computeFileHashes(filePath)
    : { contentHash: null, audioHash: null, audioPayloadSize: 0 };

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
    contentHash: hashes.contentHash,
    audioHash: hashes.audioHash,
    audioPayloadSize: hashes.audioPayloadSize,
    hashesComputed: withHashes,
  };

  try {
    // Capture embedded artwork during the initial metadata read when running a scan
    // so the cover stage never re-opens all 3,500 files on spinning HDDs.
    const meta = await parseFile(filePath, { skipCovers: !captureCover, duration: true });
    if (captureCover) {
      recordScannedTrackCover(filePath, {
        readable: true,
        pic: selectCover(meta.common?.picture),
      });
    }
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
    if (captureCover) {
      recordScannedTrackCover(filePath, { readable: false, pic: null });
    }
    console.error(`Failed to parse metadata for ${filePath}: ${err.message}`);
    return {
      ...base,
      parseError: true,
      errorMessage: err.message,
    };
  }
}

/** Lists audio files with size/mtime/inode identity; failed native walks always abort the scan. */
export async function listAudioFiles(musicDir) {
  const result = await getNativeScanner().listAudioFiles(musicDir);
  return result ?? listAudioFilesJs(musicDir);
}

/** JS reference and rollback implementation (stat follows symlinks). */
export async function listAudioFilesJs(musicDir) {
  const physicalRoot = await fs.realpath(musicDir);
  const lexicalRoot = path.resolve(musicDir);
  if (!(await fs.stat(physicalRoot)).isDirectory()) throw new Error(`Music root is not a directory: ${musicDir}`);
  const entries = await glob('**/*', { cwd: physicalRoot, withFileTypes: true, stat: true, nodir: true, nocase: true });

  const candidates = entries.filter(e => isAudioFile(e.name) && (e.isFile() || e.isSymbolicLink()));
  const files = await mapLimit(candidates, LIST_STAT_CONCURRENCY, async e => {
    try {
      const physical = await fs.realpath(e.fullpath());
      if (!isWithinRoot(physicalRoot, physical)) return null;
      const stat = await fs.stat(physical);
      if (!stat.isFile()) return null;
      return {
        path: path.join(lexicalRoot, path.relative(physicalRoot, e.fullpath())),
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

export async function mergeDuplicateTrackPair(client, originalId, duplicateLiveId) {
  if (!originalId || !duplicateLiveId || originalId === duplicateLiveId) return false;

  const { rows: mRows } = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [originalId]);
  const { rows: lRows } = await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [duplicateLiveId]);
  if (mRows.length === 0 || lRows.length === 0) return false;

  const m = mRows[0];
  const l = lRows[0];

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

  await client.query('UPDATE playlist_tracks SET track_id = $1 WHERE track_id = $2', [m.id, l.id]);
  await client.query('UPDATE play_history SET track_id = $1 WHERE track_id = $2', [m.id, l.id]);

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

  await client.query('UPDATE play_queues SET current_track_id = $1 WHERE current_track_id = $2', [m.id, l.id]);
  await client.query(
    'UPDATE play_queues SET track_ids = array_replace(track_ids, $2, $1) WHERE $2 = ANY(track_ids)',
    [m.id, l.id]
  );

  await client.query(
    `UPDATE track_lyrics SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (SELECT 1 FROM track_lyrics tl2 WHERE tl2.track_id = $1)`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM track_lyrics WHERE track_id = $1', [l.id]);

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

  await client.query(
    `UPDATE lastfm_track_rules SET track_id = $1
     WHERE track_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM lastfm_track_rules r2
         WHERE r2.user_id = lastfm_track_rules.user_id AND r2.track_id = $1
       )`,
    [m.id, l.id]
  );
  await client.query('DELETE FROM lastfm_track_rules WHERE track_id = $1', [l.id]);
  await client.query('UPDATE lastfm_outbox SET track_id = $1 WHERE track_id = $2', [m.id, l.id]);

  await client.query('DELETE FROM tracks WHERE id = $1', [l.id]);

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

function computeAlbumSummary(allTracks) {
  const availableTracks = allTracks.filter((t) => t.missing_since == null);
  const tracks = availableTracks.length > 0 ? availableTracks : allTracks;

  const maxDisc = Math.max(1, ...tracks.map((t) => Math.max(t.disc_number || 1, t.metadata?.discTotal || 1)));

  const yearCounts = new Map();
  for (const t of tracks) {
    if (t.year != null) yearCounts.set(t.year, (yearCounts.get(t.year) || 0) + 1);
  }
  let consensusYear = null;
  let maxYearCount = 0;
  for (const [y, cnt] of yearCounts.entries()) {
    if (cnt > maxYearCount) { maxYearCount = cnt; consensusYear = y; }
  }

  const genreCounts = new Map();
  for (const t of tracks) {
    if (t.genre != null && t.genre.trim() !== '') {
      genreCounts.set(t.genre, (genreCounts.get(t.genre) || 0) + 1);
    }
  }
  let consensusGenre = null;
  let maxGenreCount = 0;
  for (const [g, cnt] of genreCounts.entries()) {
    if (cnt > maxGenreCount) { maxGenreCount = cnt; consensusGenre = g; }
  }

  const tracksForInference = tracks.map((t) => ({
    albumArtistName: t.album_artist_credit,
    artistName: t.artist_name || t.track_artist_credit,
  }));
  const inferred = inferAlbumArtist(tracksForInference);
  const canonicalAlbumArtist = extractLeadingArtist(inferred.name) || inferred.name;
  const compilation = inferred.compilation || tracks.some((t) => t.metadata?.compilation);
  const mbid = tracks.find((t) => t.metadata?.albumMusicBrainzId)?.metadata.albumMusicBrainzId || null;

  return { maxDisc, consensusYear, consensusGenre, canonicalAlbumArtist, compilation, mbid };
}

/**
 * Set-based album metadata refresh across all `touchedAlbumIds`: replaces ~7*N
 * per-album round-trips (2,450 queries for 350 albums) with ~7 bulk queries total,
 * while preserving transactional album-merge conflict resolution.
 */
export async function refreshAlbumsMetadata(client, touchedAlbumIds, { transactionActive = false } = {}) {
  if (!touchedAlbumIds || touchedAlbumIds.size === 0) return;
  let pendingIds = [...new Set([...touchedAlbumIds].filter(Boolean))];
  if (pendingIds.length === 0) return;

  while (pendingIds.length > 0) {
    const batchIds = pendingIds;
    pendingIds = [];

    const [{ rows: allTrackRows }, { rows: albumRows }] = await Promise.all([
      client.query(
        `SELECT t.album_id, t.id, t.title, t.track_number, t.disc_number, t.genre, t.year,
                t.track_artist_credit, t.album_artist_credit, t.artist_id,
                t.missing_since, t.metadata,
                a.name AS artist_name
         FROM tracks t
         LEFT JOIN artists a ON t.artist_id = a.id
         WHERE t.album_id = ANY($1::int[])`,
        [batchIds]
      ),
      client.query(
        'SELECT id, title, artist_id, release_key FROM albums WHERE id = ANY($1::int[])',
        [batchIds]
      ),
    ]);

    if (allTrackRows.length === 0 || albumRows.length === 0) break;

    const tracksByAlbum = new Map();
    for (const row of allTrackRows) {
      let arr = tracksByAlbum.get(row.album_id);
      if (!arr) { arr = []; tracksByAlbum.set(row.album_id, arr); }
      arr.push(row);
    }
    const albumById = new Map(albumRows.map(a => [a.id, a]));

    const summaries = [];
    const artistNamesSet = new Map();
    for (const albumId of batchIds) {
      const tracks = tracksByAlbum.get(albumId);
      const alb = albumById.get(albumId);
      if (!tracks || tracks.length === 0 || !alb) continue;
      const summary = computeAlbumSummary(tracks);
      if (summary.canonicalAlbumArtist) {
        const lower = summary.canonicalAlbumArtist.toLowerCase();
        if (!artistNamesSet.has(lower)) artistNamesSet.set(lower, summary.canonicalAlbumArtist);
      }
      summaries.push({ albumId, alb, ...summary });
    }
    if (summaries.length === 0) break;

    const artistIdByLower = new Map();
    if (artistNamesSet.size > 0) {
      const uniqueNames = [...artistNamesSet.values()];
      await client.query(
        `INSERT INTO artists (name)
         SELECT DISTINCT ON (LOWER(n)) n FROM unnest($1::text[]) AS n
         ON CONFLICT (LOWER(name)) DO NOTHING`,
        [uniqueNames]
      );
      const { rows: artRows } = await client.query(
        'SELECT id, name FROM artists WHERE LOWER(name) = ANY($1::text[])',
        [uniqueNames.map(n => n.toLowerCase())]
      );
      for (const r of artRows) artistIdByLower.set(r.name.toLowerCase(), r.id);
    }

    for (const s of summaries) {
      s.artistId = s.canonicalAlbumArtist
        ? (artistIdByLower.get(s.canonicalAlbumArtist.toLowerCase()) ?? null)
        : null;
    }

    // Check for rare `(LOWER(title), artistId, release_key)` merge conflicts in one query
    const withArtist = summaries.filter(s => s.artistId != null);
    const conflictMap = new Map(); // sourceAlbumId -> targetAlbumId
    if (withArtist.length > 0) {
      const { rows: conflicts } = await client.query(
        `SELECT u.album_id AS source_id, al.id AS target_id
         FROM unnest($1::int[], $2::text[], $3::int[], $4::text[])
           AS u(album_id, title_lower, artist_id, release_key)
         JOIN albums al
           ON LOWER(al.title) = u.title_lower
          AND al.artist_id = u.artist_id
          AND al.release_key = u.release_key
          AND al.id <> u.album_id`,
        [
          withArtist.map(s => s.albumId),
          withArtist.map(s => s.alb.title.toLowerCase()),
          withArtist.map(s => s.artistId),
          withArtist.map(s => s.alb.release_key),
        ]
      );
      for (const c of conflicts) {
        if (!conflictMap.has(c.source_id) && !conflictMap.has(c.target_id)) {
          conflictMap.set(c.source_id, c.target_id);
        }
      }
    }

    for (const [albumId, targetAlbumId] of conflictMap.entries()) {
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
      pendingIds.push(targetAlbumId);
    }

    const readySummaries = summaries.filter(s => !conflictMap.has(s.albumId) && !pendingIds.includes(s.albumId));
    if (readySummaries.length > 0) {
      await client.query(
        `UPDATE albums AS al
         SET year = u.year,
             genre = u.genre,
             artist_id = u.artist_id,
             compilation = u.compilation,
             disc_count = u.disc_count,
             musicbrainz_id = u.mbid
         FROM unnest(
           $1::int[], $2::int[], $3::text[], $4::int[], $5::boolean[], $6::int[], $7::text[]
         ) AS u(id, year, genre, artist_id, compilation, disc_count, mbid)
         WHERE al.id = u.id`,
        [
          readySummaries.map(s => s.albumId),
          readySummaries.map(s => s.consensusYear),
          readySummaries.map(s => s.consensusGenre),
          readySummaries.map(s => s.artistId),
          readySummaries.map(s => s.compilation),
          readySummaries.map(s => s.maxDisc),
          readySummaries.map(s => s.mbid),
        ]
      );

      const credited = readySummaries.filter(s => s.artistId != null);
      if (credited.length > 0) {
        await client.query(
          `DELETE FROM album_credits AS ac
           USING unnest($1::int[], $2::int[]) AS u(album_id, artist_id)
           WHERE ac.album_id = u.album_id AND ac.role = 'albumartist' AND ac.artist_id <> u.artist_id`,
          [credited.map(s => s.albumId), credited.map(s => s.artistId)]
        );
        await client.query(
          `INSERT INTO album_credits (album_id, artist_id, role, credited_as)
           SELECT u.album_id, u.artist_id, 'albumartist', u.credited_as
           FROM unnest($1::int[], $2::int[], $3::text[]) AS u(album_id, artist_id, credited_as)
           ON CONFLICT (album_id, artist_id, role) DO UPDATE SET credited_as = EXCLUDED.credited_as`,
          [credited.map(s => s.albumId), credited.map(s => s.artistId), credited.map(s => s.canonicalAlbumArtist)]
        );
      }
    }
  }
}

/**
 * Computes full-file `content_hash` / `audio_hash` in `(dev, ino)` order via
 * the native single-reader / multi-hasher pipeline and persists them in batches.
 * Used synchronously by direct `scanDirectory` callers or asynchronously after
 * background scans so tracks become playable within seconds on spinning HDDs.
 */
export async function backfillMissingTrackHashes(prefix, { shouldContinue = () => true } = {}) {
  if (!shouldContinue()) return 0;
  const { rows } = await query(
    `SELECT id, file_path, file_size, dev, ino, mtime
     FROM tracks
     WHERE starts_with(file_path, $1)
       AND missing_since IS NULL
       AND file_size > 0
       AND (content_hash IS NULL OR audio_hash IS NULL)`,
    [prefix]
  );
  if (rows.length === 0) return 0;

  const ordered = rows
    .map(r => ({
      ...r,
      devBig: r.dev != null ? BigInt(r.dev) : MAX_INODE_SENTINEL,
      inoBig: r.ino != null ? BigInt(r.ino) : MAX_INODE_SENTINEL,
    }))
    .sort((a, b) => (a.devBig < b.devBig ? -1 : a.devBig > b.devBig ? 1 : a.inoBig < b.inoBig ? -1 : a.inoBig > b.inoBig ? 1 : 0));

  let updated = 0;
  for (let i = 0; i < ordered.length; i += HASH_BACKFILL_BATCH) {
    if (!shouldContinue()) break;
    const slice = ordered.slice(i, i + HASH_BACKFILL_BATCH);
    const hashes = await computeFileHashesBatch(
      slice.map(r => ({ path: r.file_path, dev: r.dev, ino: r.ino }))
    );
    if (!shouldContinue()) break;

    const ids = [];
    const contentHashes = [];
    const audioHashes = [];
    const expectedPaths = [];
    for (let j = 0; j < slice.length; j++) {
      const h = hashes[j];
      if (!h?.contentHash) continue;
      ids.push(slice[j].id);
      contentHashes.push(h.contentHash);
      audioHashes.push(h.audioHash);
      expectedPaths.push(slice[j].file_path);
    }
    if (ids.length > 0) {
      await query(
        `UPDATE tracks AS t
         SET content_hash = u.content_hash,
             audio_hash = u.audio_hash
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])
           AS u(id, file_path, content_hash, audio_hash)
         WHERE t.id = u.id AND t.file_path = u.file_path AND t.missing_since IS NULL`,
        [ids, expectedPaths, contentHashes, audioHashes]
      );
      updated += ids.length;
    }
  }
  return updated;
}

/**
 * Scans musicDir. Incremental by default: only files whose mtime differs from
 * the stored one (or that are new) are parsed. `full: true` re-parses everything.
 * When `deferHashes: true` (used by background HTTP scans), full-file SHA-256
 * hashing is moved out of the critical indexing window so libraries on spinning
 * HDDs become available in seconds rather than minutes.
 */
export async function scanDirectory(
  musicDir,
  { full = false, reextractCovers = false, deferHashes = false, onProgress = null } = {}
) {
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
  const metadataIdentityUpdates = [];
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

    const needsDurationRepair = k && /\.(ogg|opus)$/i.test(f.path) && !(k.duration > 0);
    if (full || !k || needsDurationRepair || k.missing_since || !k.mtime || k.mtime.getTime() !== f.mtime.getTime() || k.album_id == null || !k.metadata || Object.keys(k.metadata).length === 0) {
      toProcess.push(f);
      if (k?.album_id) touchedAlbumIds.add(k.album_id);
    } else if (k.dev == null || k.ino == null) {
      metadataIdentityUpdates.push({ id: k.id, dev: f.dev, ino: f.ino, birthtimeMs: f.birthtimeMs });
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

  beginScanCoverSession();
  try {
    const parsedCache = new Map();
    const unclaimedRows = known.filter((r) => !claimedKnownIds.has(r.id));

    if (unmatchedFiles.length > 0 && unclaimedRows.length > 0) {
      const orderedUnmatched = sortFilesByInode(unmatchedFiles);
      const parsedUnmatched = await mapLimit(orderedUnmatched, HDD_TAG_CONCURRENCY, (f) =>
        parseTrackFile(f, { withHashes: false, captureCover: true })
      );

      // Only compute full-file hashes synchronously for unmatched files that can
      // plausibly match an unclaimed row (by size, dev:ino, or folder+format+duration).
      const unclaimedSizes = new Set(unclaimedRows.filter(r => r.content_hash && Number(r.file_size) > 0).map(r => Number(r.file_size)));
      const unclaimedDevInos = new Set(
        unclaimedRows.filter(r => r.dev != null && r.ino != null && (r.content_hash || r.audio_hash)).map(r => `${r.dev}:${r.ino}`)
      );
      const unclaimedAudioFolders = new Set(
        unclaimedRows.filter(r => r.audio_hash).map(r => normalizeAlbumFolder(path.dirname(r.file_path)).toLowerCase())
      );

      const hashCandidates = parsedUnmatched.filter(item => {
        if (Number(item.fileSize) <= 0) return false;
        if (unclaimedSizes.has(Number(item.fileSize))) return true;
        if (item.dev != null && item.ino != null && unclaimedDevInos.has(`${item.dev}:${item.ino}`)) return true;
        if (unclaimedAudioFolders.has(normalizeAlbumFolder(item.folderPath).toLowerCase())) return true;
        return false;
      });

      if (hashCandidates.length > 0) {
        const candidateHashes = await computeFileHashesBatch(
          hashCandidates.map(item => ({ path: item.filePath, dev: item.dev, ino: item.ino }))
        );
        for (let idx = 0; idx < hashCandidates.length; idx++) {
          const item = hashCandidates[idx];
          const h = candidateHashes[idx];
          item.contentHash = h.contentHash;
          item.audioHash = h.audioHash;
          item.audioPayloadSize = h.audioPayloadSize;
          item.hashesComputed = true;
        }
      }

      for (const p of parsedUnmatched) {
        parsedCache.set(p.filePath, p);
      }

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

        if (!hasCompatibleBirthtime(oldRow.birthtime_ms, item.birthtimeMs)) continue;
        const hashMatches =
          (oldRow.content_hash != null && item.contentHash != null && oldRow.content_hash === item.contentHash) ||
          (oldRow.audio_hash != null && item.audioHash != null && oldRow.audio_hash === item.audioHash);
        if (!hashMatches) continue;
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

    // Sort `toProcess` by physical `(dev, ino)` so tag reads sweep monotonically across HDD platters.
    const orderedToProcess = sortFilesByInode(toProcess);
    let hasExistingTracks = known.length > 0;

    const client = await getClient();
    try {
      if (pathUpdates.length > 0) {
        await inTransaction(client, async () => {
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
        }, { fastCommit: true });
      }

      // Double-buffered pipeline: overlap reading batch N+1 from disk with writing batch N to Postgres.
      const readBatchSlice = (startIdx) => {
        if (startIdx >= orderedToProcess.length) return null;
        const slice = orderedToProcess.slice(startIdx, startIdx + BATCH_SIZE);
        return mapLimit(slice, HDD_TAG_CONCURRENCY, async (f) => {
          return parsedCache.get(f.path) || parseTrackFile(f, { withHashes: false, captureCover: true });
        });
      };

      let nextBatchPromise = readBatchSlice(0);
      for (let i = 0; i < orderedToProcess.length; i += BATCH_SIZE) {
        const parsed = await nextBatchPromise;
        nextBatchPromise = readBatchSlice(i + BATCH_SIZE);
        for (const p of parsed) {
          if (p.parseError) parseErrors++;
        }
        processed += await writeBatch(client, parsed, touchedAlbumIds, { hasExistingTracks });
        hasExistingTracks = true;
        console.log(`Processed ${processed}/${orderedToProcess.length}`);
        onProgress?.({
          phase: 'processing',
          total: files.length,
          toProcess: orderedToProcess.length,
          processed,
          unchanged,
          errors: parseErrors,
        });
      }

      if (metadataIdentityUpdates.length > 0) {
        await inTransaction(client, async () => {
          await client.query(
            `UPDATE tracks AS t
             SET dev = u.dev,
                 ino = u.ino,
                 birthtime_ms = u.birthtime_ms
             FROM unnest($1::int[], $2::bigint[], $3::bigint[], $4::bigint[])
               AS u(id, dev, ino, birthtime_ms)
             WHERE t.id = u.id`,
            [
              metadataIdentityUpdates.map(b => b.id),
              metadataIdentityUpdates.map(b => b.dev),
              metadataIdentityUpdates.map(b => b.ino),
              metadataIdentityUpdates.map(b => b.birthtimeMs),
            ]
          );
        }, { fastCommit: true });
      }

      onProgress?.({ phase: 'cleaning', total: files.length, processed, unchanged, errors: parseErrors });

      const hadMissingTracks = known.some(r => r.missing_since != null);
      if (staleIds.length > 0 || hadMissingTracks) {
        await inTransaction(client, async () => {
          if (staleIds.length) {
            await client.query('UPDATE tracks SET missing_since = COALESCE(missing_since, NOW()) WHERE id = ANY($1::int[])', [staleIds]);
            console.warn(`Marked ${staleIds.length} missing tracks; no user data deleted`);
          }
          if (hadMissingTracks && files.length) {
            await client.query('UPDATE tracks SET missing_since = NULL WHERE file_path = ANY($1::text[]) AND missing_since IS NOT NULL', [files.map(f => f.path)]);
          }
        });
      }

      if (hadMissingTracks || staleIds.length > 0) {
        mergedPairs = await reconcileExistingDuplicatePairs(client, prefix, touchedAlbumIds);
      }

      await inTransaction(client, async () => {
        await refreshAlbumsMetadata(client, touchedAlbumIds, { transactionActive: true });
        if (known.length > 0 || mergedPairs > 0) {
          await removeOrphans(client);
        }
      });
    } finally {
      client.release();
    }

    let coversExtracted = 0;
    let coversTotal = 0;

    onProgress?.({ phase: 'covers', total: files.length, processed, coversExtracted: 0, coversTotal: 0 });

    const makeCoverProgressCallback = (baseExtracted = 0, baseTotal = 0) => (extracted, total) => {
      coversExtracted = baseExtracted + extracted;
      coversTotal = baseTotal + total;
      onProgress?.({ phase: 'covers', total: files.length, processed, coversExtracted, coversTotal });
    };

    if (full || reextractCovers) {
      const covers = await extractAllMissingCovers({ force: true, onProgress: makeCoverProgressCallback() });
      coversExtracted = covers.extracted;
      coversTotal = covers.total;
    } else {
      // Skip `findAlbumsWithChangedFolderCovers` on a fresh initial scan (`known.length === 0`),
      // since every album in the DB is already in `touchedAlbumIds`.
      if (known.length > 0) {
        for (const id of await findAlbumsWithChangedFolderCovers()) touchedAlbumIds.add(id);
      }
      if (touchedAlbumIds.size > 0) {
        const touchedCovers = await extractAllMissingCovers({
          albumIds: [...touchedAlbumIds],
          force: true,
          onProgress: makeCoverProgressCallback(0, 0),
        });
        coversExtracted = touchedCovers.extracted;
        coversTotal = touchedCovers.total;
      }
      if (known.length > 0) {
        const baseExtracted = coversExtracted;
        const baseTotal = coversTotal;
        const missingCovers = await extractAllMissingCovers({
          force: false,
          onProgress: makeCoverProgressCallback(baseExtracted, baseTotal),
        });
        coversExtracted = baseExtracted + missingCovers.extracted;
        coversTotal = baseTotal + missingCovers.total;
      }
    }

    console.log(`Covers extracted: ${coversExtracted}/${coversTotal}`);

    // Stage 2: Full-file SHA-256 backfill (executed synchronously for direct API/test
    // callers, or deferred to a non-blocking background worker for UI scans).
    if (!deferHashes) {
      await backfillMissingTrackHashes(prefix);
      // If a legacy pre-existing missing+live duplicate pair needed freshly computed
      // live hashes to merge, reconcile once more when missing rows exist.
      if (known.some(r => r.missing_since != null) || staleIds.length > 0) {
        const postBackfillClient = await getClient();
        try {
          const extraMerged = await reconcileExistingDuplicatePairs(postBackfillClient, prefix, touchedAlbumIds);
          if (extraMerged > 0) {
            mergedPairs += extraMerged;
            await inTransaction(postBackfillClient, async () => {
              await refreshAlbumsMetadata(postBackfillClient, touchedAlbumIds, { transactionActive: true });
              await removeOrphans(postBackfillClient);
            });
          }
        } finally {
          postBackfillClient.release();
        }
      }
    }

    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`Scan complete in ${durationSeconds}s. Processed ${processed} files.`);
    const remainingMissing = Math.max(0, staleIds.length - mergedPairs);
    const finalResult = { total: files.length, processed, unchanged, removed, missing: remainingMissing, errors: parseErrors, covers: coversExtracted, durationSeconds };
    onProgress?.({ phase: 'complete', ...finalResult });
    return finalResult;
  } finally {
    endScanCoverSession();
  }
}

export async function scanSingleFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const item = await parseTrackFile(
      {
        path: filePath,
        size: stat.size,
        mtime: stat.mtime,
        dev: toBigIntStr(stat.dev),
        ino: toBigIntStr(stat.ino),
        nlink: Number.isFinite(stat.nlink) ? stat.nlink : 1,
        birthtimeMs: Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
          ? String(Math.round(stat.birthtimeMs))
          : null,
      },
      { withHashes: true, captureCover: false }
    );
    const touched = new Set();
    const { rows: prev } = await query('SELECT album_id FROM tracks WHERE file_path = $1', [filePath]);
    if (prev[0]?.album_id) touched.add(prev[0].album_id);

    const client = await getClient();
    let written = 0;
    try {
      await inTransaction(client, async () => {
        const ids = await flushTrackBatch(client, [item]);
        ids.forEach((id) => touched.add(id));
        written = 1;
        if (touched.size > 0) {
          await refreshAlbumsMetadata(client, touched, { transactionActive: true });
        }
      });
    } finally {
      client.release();
    }
    if (written > 0 && touched.size > 0) {
      await extractAllMissingCovers({ albumIds: [...touched], force: true });
    }
    return written > 0;
  } catch (err) {
    console.error(`Failed to scan single file ${filePath}: ${err.message}`);
    return false;
  }
}
