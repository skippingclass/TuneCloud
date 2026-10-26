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
 * Row: { id, name, album_count, sample_album_id, starred_at, user_rating }
 */
export function formatArtist(row) {
  return compact({
    id: String(row.id),
    name: row.name,
    albumCount: Number(row.album_count || 0),
    coverArt: row.sample_album_id ? `al-${row.sample_album_id}` : undefined,
    artistImageUrl: row.sample_album_id ? `/rest/getCoverArt.view?id=ar-${row.id}` : undefined,
    starred: iso(row.starred_at),
    userRating: row.user_rating != null ? Number(row.user_rating) : undefined,
  });
}

export function splitArtistNames(str) {
  if (!str) return [];
  return str
    .split(/\s*(?:,|&|\/|\bfeat\.?|\bft\.?)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Row: { id, title, year, genre, cover_path, created_at, artist_id, artist_name, song_count, duration, starred_at, user_rating }
 */
export function formatAlbum(row) {
  const albumArtists = row.artist_id && row.artist_name ? [{ id: String(row.artist_id), name: row.artist_name }] : undefined;
  return compact({
    id: String(row.id),
    name: row.title,
    title: row.title,
    album: row.title,
    artist: row.artist_name || '',
    displayArtist: row.artist_name || '',
    displayAlbumArtist: row.artist_name || '',
    artistId: str(row.artist_id),
    artists: albumArtists,
    albumArtists,
    coverArt: row.cover_path ? `al-${row.id}` : undefined,
    songCount: Number(row.song_count || 0),
    duration: Math.round(Number(row.duration || 0)),
    year: row.year || undefined,
    genre: row.genre || undefined,
    created: iso(row.created_at),
    starred: iso(row.starred_at),
    userRating: row.user_rating != null ? Number(row.user_rating) : undefined,
    isDir: true,
  });
}

/**
 * Row: track columns + album_title, album_year, album_genre, album_cover, artist_name, starred_at, user_rating, play_count
 */
export function formatSong(row) {
  const suffix = (row.format || path.extname(row.file_name || '').slice(1) || 'mp3').toLowerCase();
  let coverArt;
  if (row.cover_path) coverArt = `tr-${row.id}`;
  else if (row.album_id && row.album_cover) coverArt = `al-${row.album_id}`;

  const trackArtist = row.track_artist_credit || row.artist_name || '';
  const names = splitArtistNames(trackArtist);
  const artists = names.length > 0 ? names.map((name, idx) => ({
    id: idx === 0 && row.artist_id ? String(row.artist_id) : str(row.artist_id) || '0',
    name,
  })) : undefined;

  const albumArtistName = row.album_artist_name || (row.album_compilation ? 'Various Artists' : (row.artist_name || ''));
  const albumArtistId = row.album_artist_id ? String(row.album_artist_id) : (row.artist_id ? String(row.artist_id) : undefined);
  const albumArtistNames = splitArtistNames(albumArtistName);
  const albumArtists = albumArtistNames.length > 0
    ? albumArtistNames.map((name) => ({ id: albumArtistId || '0', name }))
    : (albumArtistName ? [{ id: albumArtistId || '0', name: albumArtistName }] : undefined);

  return compact({
    id: String(row.id),
    parent: str(row.album_id),
    isDir: false,
    title: row.title || row.file_name,
    album: row.album_title || '',
    artist: trackArtist,
    displayArtist: trackArtist,
    artists,
    albumArtist: albumArtistName || undefined,
    displayAlbumArtist: albumArtistName || undefined,
    albumArtists,
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
    starred: iso(row.starred_at),
    userRating: row.user_rating != null ? Number(row.user_rating) : undefined,
    playCount: row.play_count != null ? Number(row.play_count) : undefined,
    available: row.available != null ? Boolean(row.available) : (row.missing_since == null),
  });
}

export function formatPlaylist(row, songs = []) {
  return compact({
    id: String(row.id),
    name: row.name,
    comment: row.comment || undefined,
    owner: row.owner_username || undefined,
    public: Boolean(row.is_public),
    songCount: songs.length || Number(row.song_count || 0),
    duration: Math.round(Number(row.duration || (songs.reduce((acc, s) => acc + (s.duration || 0), 0)))),
    created: iso(row.created_at),
    changed: iso(row.updated_at),
    coverArt: row.cover_art ? `al-${row.cover_art}` : (songs[0]?.coverArt || undefined),
    entry: songs.length > 0 ? songs.map(formatSong) : undefined,
  });
}

export const SONG_SELECT = `
  SELECT t.id, t.title, t.file_name, t.file_path, t.file_size, t.duration,
         t.track_number, t.disc_number, t.year, t.genre, t.bitrate, t.sample_rate,
         t.format, t.cover_path, t.created_at, t.album_id, t.artist_id, t.play_count,
         t.missing_since, (t.missing_since IS NULL) AS available,
         t.track_artist_credit,
         al.title AS album_title, al.year AS album_year, al.genre AS album_genre,
         al.cover_path AS album_cover,
         al.artist_id AS album_artist_id,
         al.compilation AS album_compilation,
         a.name AS artist_name,
         ala.name AS album_artist_name
  FROM tracks t
  LEFT JOIN albums al ON t.album_id = al.id
  LEFT JOIN artists a ON t.artist_id = a.id
  LEFT JOIN artists ala ON al.artist_id = ala.id`;

export function songSelectSql(userId = null) {
  if (!userId) return SONG_SELECT;
  const uid = Number(userId);
  return `
    SELECT t.id, t.title, t.file_name, t.file_path, t.file_size, t.duration,
           t.track_number, t.disc_number, t.year, t.genre, t.bitrate, t.sample_rate,
           t.format, t.cover_path, t.created_at, t.album_id, t.artist_id, t.play_count,
           t.missing_since, (t.missing_since IS NULL) AS available,
           t.track_artist_credit,
           al.title AS album_title, al.year AS album_year, al.genre AS album_genre,
           al.cover_path AS album_cover,
           al.artist_id AS album_artist_id,
           al.compilation AS album_compilation,
           a.name AS artist_name,
           ala.name AS album_artist_name,
           st.created_at AS starred_at,
           ur.rating AS user_rating
    FROM tracks t
    LEFT JOIN albums al ON t.album_id = al.id
    LEFT JOIN artists a ON t.artist_id = a.id
    LEFT JOIN artists ala ON al.artist_id = ala.id
    LEFT JOIN user_starred_tracks st ON st.track_id = t.id AND st.user_id = ${uid}
    LEFT JOIN user_ratings ur ON ur.entity_type = 'track' AND ur.entity_id = t.id AND ur.user_id = ${uid}`;
}

export const ALBUM_SELECT = `
  SELECT al.id, al.title, al.year, al.genre, al.cover_path, al.created_at,
         a.id AS artist_id, a.name AS artist_name,
         COUNT(t.id)::int AS song_count,
         COALESCE(SUM(t.duration), 0) AS duration
  FROM albums al
  LEFT JOIN artists a ON al.artist_id = a.id
  LEFT JOIN tracks t ON t.album_id = al.id`;

export function albumSelectSql(userId = null) {
  if (!userId) return ALBUM_SELECT;
  const uid = Number(userId);
  return `
    SELECT al.id, al.title, al.year, al.genre, al.cover_path, al.created_at,
           a.id AS artist_id, a.name AS artist_name,
           COUNT(t.id)::int AS song_count,
           COALESCE(SUM(t.duration), 0) AS duration,
           sa.created_at AS starred_at,
           ur.rating AS user_rating
    FROM albums al
    LEFT JOIN artists a ON al.artist_id = a.id
    LEFT JOIN tracks t ON t.album_id = al.id
    LEFT JOIN user_starred_albums sa ON sa.album_id = al.id AND sa.user_id = ${uid}
    LEFT JOIN user_ratings ur ON ur.entity_type = 'album' AND ur.entity_id = al.id AND ur.user_id = ${uid}`;
}

export const ARTIST_SELECT = `
  SELECT a.id, a.name,
         COUNT(DISTINCT al.id)::int AS album_count,
         MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id
  FROM artists a
  LEFT JOIN albums al ON al.artist_id = a.id`;

export function artistSelectSql(userId = null) {
  if (!userId) return `${ARTIST_SELECT} WHERE a.name NOT LIKE '%,%' GROUP BY a.id, a.name ORDER BY a.name ASC`;
  const uid = Number(userId);
  return `
    SELECT a.id, a.name,
           COUNT(DISTINCT al.id)::int AS album_count,
           MIN(al.id) FILTER (WHERE al.cover_path IS NOT NULL) AS sample_album_id,
           sar.created_at AS starred_at,
           ur.rating AS user_rating
    FROM artists a
    LEFT JOIN albums al ON al.artist_id = a.id
    LEFT JOIN user_starred_artists sar ON sar.artist_id = a.id AND sar.user_id = ${uid}
    LEFT JOIN user_ratings ur ON ur.entity_type = 'artist' AND ur.entity_id = a.id AND ur.user_id = ${uid}
    WHERE a.name NOT LIKE '%,%'
    GROUP BY a.id, a.name, sar.created_at, ur.rating
    ORDER BY a.name ASC`;
}

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

/**
 * Groups folder items into alphabetical index buckets ("A".."Z", "А".."Я", "#").
 * Used for getIndexes in Subsonic folder browsing.
 */
export function buildFolderIndexes(folders) {
  const buckets = new Map();
  for (const f of folders) {
    const key = sortName(f.name || '').trim();
    const ch = key.charAt(0).toUpperCase();
    const letter = /[A-ZА-ЯЁ]/.test(ch) ? ch : '#';
    if (!buckets.has(letter)) buckets.set(letter, []);
    buckets.get(letter).push({
      key,
      artist: compact({
        id: String(f.id),
        name: f.name,
        coverArt: f.coverArt,
      }),
    });
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

export function formatPlayQueue(row, songs = []) {
  return compact({
    current: row.current_track_id != null ? String(row.current_track_id) : undefined,
    position: row.position_ms != null ? Number(row.position_ms) : 0,
    username: row.username || undefined,
    changed: iso(row.updated_at),
    changedBy: row.changed_by || undefined,
    entry: songs.length > 0 ? songs.map(formatSong) : [],
  });
}

export function formatBookmark(row, song = null) {
  return compact({
    position: Number(row.position_ms || 0),
    comment: row.comment || undefined,
    created: iso(row.created_at),
    changed: iso(row.updated_at),
    username: row.username || undefined,
    entry: song ? formatSong(song) : undefined,
  });
}

export function formatInternetRadioStation(row) {
  return compact({
    id: String(row.id),
    name: row.name,
    streamUrl: row.stream_url,
    homepageUrl: row.homepage_url || undefined,
  });
}

export function formatPodcast(row, episodes = []) {
  return compact({
    id: String(row.id),
    url: row.url,
    title: row.title,
    description: row.description || undefined,
    coverArt: row.cover_url || undefined,
    episode: episodes.map(formatPodcastEpisode),
  });
}

export function formatPodcastEpisode(row) {
  return compact({
    id: String(row.id),
    parent: String(row.podcast_id),
    isDir: false,
    title: row.title,
    description: row.description || undefined,
    publishDate: iso(row.publish_date || row.created_at),
    streamUrl: row.stream_url,
    duration: Number(row.duration || 0),
    status: row.status || 'completed',
  });
}

