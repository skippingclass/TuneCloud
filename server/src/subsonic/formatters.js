import path from 'path';
import { contentTypeFor } from '../streaming.js';

// Removes null/undefined values so they are omitted from JSON and XML output.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

const str = (v) => (v === null || v === undefined ? undefined : String(v));
const iso = (d) => (d ? new Date(d).toISOString() : undefined);

function relativePath(filePath, fileName) {
  const root = process.env.MUSIC_DIR;
  if (root && filePath) {
    const rel = path.relative(root, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return fileName;
}

function bitRateKbps(bitrate) {
  if (!bitrate) return undefined;
  return bitrate > 1000 ? Math.round(bitrate / 1000) : bitrate;
}

/**
 * Row: { id, name, album_count, sample_album_id }
 */
export function formatArtist(row) {
  return compact({
    id: String(row.id),
    name: row.name,
    albumCount: Number(row.album_count || 0),
    coverArt: row.sample_album_id ? `al-${row.sample_album_id}` : undefined,
    artistImageUrl: row.sample_album_id ? `/rest/getCoverArt.view?id=ar-${row.id}` : undefined,
  });
}

/**
 * Row: { id, title, year, genre, cover_path, created_at, artist_id, artist_name, song_count, duration }
 */
export function formatAlbum(row) {
  return compact({
    id: String(row.id),
    name: row.title,
    title: row.title,
    album: row.title,
    artist: row.artist_name || '',
    artistId: str(row.artist_id),
    coverArt: row.cover_path ? `al-${row.id}` : undefined,
    songCount: Number(row.song_count || 0),
    duration: Math.round(Number(row.duration || 0)),
    year: row.year || undefined,
    genre: row.genre || undefined,
    created: iso(row.created_at),
    isDir: true,
  });
}

/**
 * Row: track columns + album_title, album_year, album_genre, album_cover, artist_name
 */
export function formatSong(row) {
  const suffix = (row.format || path.extname(row.file_name || '').slice(1) || 'mp3').toLowerCase();
  let coverArt;
  if (row.album_id && (row.album_cover || row.cover_path)) coverArt = `al-${row.album_id}`;
  else if (row.cover_path) coverArt = `tr-${row.id}`;

  return compact({
    id: String(row.id),
    parent: str(row.album_id),
    isDir: false,
    title: row.title || row.file_name,
    album: row.album_title || '',
    artist: row.artist_name || '',
    track: row.track_number || 1,
    year: row.year || row.album_year || undefined,
    genre: row.genre || row.album_genre || undefined,
    coverArt,
    size: Number(row.file_size || 0),
    contentType: contentTypeFor(suffix),
    suffix,
    duration: Math.round(Number(row.duration || 0)),
    bitRate: bitRateKbps(row.bitrate),
    samplingRate: row.sample_rate || undefined,
    path: relativePath(row.file_path, row.file_name),
    discNumber: row.disc_number || 1,
    type: 'music',
    mediaType: 'song',
    created: iso(row.created_at),
    albumId: str(row.album_id),
    artistId: str(row.artist_id),
  });
}

export const SONG_SELECT = `
  SELECT t.id, t.title, t.file_name, t.file_path, t.file_size, t.duration,
         t.track_number, t.disc_number, t.year, t.genre, t.bitrate, t.sample_rate,
         t.format, t.cover_path, t.created_at, t.album_id, t.artist_id,
         al.title AS album_title, al.year AS album_year, al.genre AS album_genre,
         al.cover_path AS album_cover,
         a.name AS artist_name
  FROM tracks t
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN artists a ON t.artist_id = a.id`;

const IGNORED_ARTICLES = ['The', 'El', 'La', 'Los', 'Las', 'Le', 'Les'];
export const IGNORED_ARTICLES_STR = IGNORED_ARTICLES.join(' ');

function sortName(name) {
  for (const art of IGNORED_ARTICLES) {
    const prefix = `${art} `;
    if (name.length > prefix.length && name.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

/**
 * Groups artist rows into alphabetical index buckets ("A".."Z", "А".."Я", "#").
 */
export function buildIndexes(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = sortName(row.name || '').trim();
    const ch = key.charAt(0).toUpperCase();
    const letter = /[A-ZА-ЯЁ]/.test(ch) ? ch : '#';
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push({ key, artist: formatArtist(row) });
  }

  return [...buckets.keys()]
    .sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b, 'ru')))
    .map((name) => ({
      name,
      artist: buckets
        .get(name)
        .sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
        .map((x) => x.artist),
    }));
}
