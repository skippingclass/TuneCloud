import fs from 'fs';
import path from 'path';
import * as mm from 'music-metadata';

const USER_AGENT = 'TuneCloud/1.0 (https://github.com/skippingclass/TuneCloud)';
const FETCH_TIMEOUT_MS = 4000;

// Bracketed noise: (Official Video), [4K], (Lyrics), (MV), (Премьера), (текст песни), etc.
const BRACKETED_NOISE = /[[(]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?(?:\s*video)?|visuali[sz]er|mv|m\/v|hd|hq|4k[^\])]*|1080p[^\])]*|live|clip(?:\s*officiel)?|videoclip|премьера[^\])]*|клип|текст(?:\s*песни)?|official)\s*[\])]/gi;
const CHAPTER_TAIL = /\s*[|｜].*$/g;
const FEATURE_BRACKET = /\s*[[(]\s*(?:feat|ft)\.?\s[^)\]]*[)\]]/gi;
const FEATURE_TAIL = /\s+(?:feat|ft)\.?\s.*$/gi;
const QUALITY_TAIL = /\s+(?:4k|hd|hq|mv|m\/v)\s*$/gi;
const LEADING_TRACK_NUM = /^\s*\d{1,3}[\s.-]+/;
const AUDIO_EXT = /\.(?:mp3|flac|m4a|wav|ogg|opus|aac|wma)$/i;
const DANGLING_DASH = /\s*[-–—−]+\s*$/;

const TOPIC_SUFFIX = /\s*-\s*Topic$/i;
const VEVO_SUFFIX = /\s*VEVO$/i;
const ARTIST_FEATURE_BRACKET = /\s*[,;]?\s*\((?:feat|ft)\.?\s[^)]*\)/gi;
const ARTIST_FEATURE_TAIL = /\s*[,;]?\s+(?:feat|ft)\.?\s.*$/gi;
const OFFICIAL_SUFFIX = /\s+(?:official|официальный)\s*$/gi;

function tidy(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

/**
 * Clean track title by removing bracketed noise, extensions, track numbers, and feature suffixes
 * Following plasma-lrc cleaning heuristics.
 */
export function cleanTrackTitle(title) {
  if (!title) return '';
  let cleaned = tidy(title);
  cleaned = cleaned.replace(AUDIO_EXT, '');
  cleaned = cleaned.replace(LEADING_TRACK_NUM, '');
  cleaned = cleaned.replace(BRACKETED_NOISE, '');
  cleaned = cleaned.replace(CHAPTER_TAIL, '');
  cleaned = cleaned.replace(FEATURE_BRACKET, '');
  cleaned = cleaned.replace(FEATURE_TAIL, '');
  cleaned = tidy(cleaned);

  while (DANGLING_DASH.test(cleaned)) {
    cleaned = cleaned.replace(DANGLING_DASH, '');
    cleaned = tidy(cleaned);
  }

  cleaned = cleaned.replace(QUALITY_TAIL, '');
  return tidy(cleaned);
}

/**
 * Clean artist name by stripping VEVO, Topic, feature tags
 */
export function cleanTrackArtist(artist) {
  if (!artist) return '';
  let cleaned = tidy(artist);
  cleaned = cleaned.replace(TOPIC_SUFFIX, '');
  cleaned = cleaned.replace(VEVO_SUFFIX, '');
  cleaned = cleaned.replace(ARTIST_FEATURE_BRACKET, '');
  cleaned = cleaned.replace(ARTIST_FEATURE_TAIL, '');
  cleaned = tidy(cleaned);
  cleaned = cleaned.replace(OFFICIAL_SUFFIX, '');
  return tidy(cleaned);
}

/**
 * Extract primary artist when multiple artists are credited (comma, slash, &, feat)
 */
export function extractPrimaryArtist(artist) {
  const cleaned = cleanTrackArtist(artist);
  if (!cleaned) return '';
  const parts = cleaned.split(/[;,/]|(?:\s+and\s+)|\s*&\s*|\s+(?:feat|ft)\.?\s+/i);
  return tidy(parts[0] || cleaned);
}

/**
 * Split "Artist - Title" format if artist is embedded in title
 */
export function splitTrackArtistAndTitle(artist, title) {
  let a = tidy(artist);
  let t = tidy(title);
  const match = t.match(/^(.+?)\s+[-–—−]\s+(.+)$/);
  if (match) {
    const left = tidy(match[1]);
    const right = tidy(match[2]);
    if (left && right) {
      if (!a || a.toLowerCase().includes(left.toLowerCase()) || left.toLowerCase().includes(a.toLowerCase())) {
        a = left;
        t = right;
      }
    }
  }
  return { artist: a, title: t };
}

/**
 * Try reading local .lrc or .txt files near the audio file
 */
export function readLocalLyrics(trackPath, cleanTitle) {
  if (!trackPath) return null;
  const dir = path.dirname(trackPath);
  const base = path.basename(trackPath, path.extname(trackPath));
  const candidates = [
    path.join(dir, `${base}.lrc`),
    path.join(dir, `${base}.txt`),
  ];
  if (cleanTitle && cleanTitle !== base) {
    candidates.push(path.join(dir, `${cleanTitle}.lrc`));
    candidates.push(path.join(dir, `${cleanTitle}.txt`));
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf8').trim();
        if (content) {
          const synced = content.includes('[') && /\d{2}:\d{2}/.test(content);
          return {
            synced,
            type: synced ? 'line' : 'plain',
            lyrics: content,
            source: 'local',
          };
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Try reading embedded lyrics from ID3/Vorbis tags inside the audio file
 */
export async function readEmbeddedLyrics(trackPath) {
  if (!trackPath) return null;
  try {
    if (!fs.existsSync(trackPath)) return null;
    const metadata = await mm.parseFile(trackPath, { skipCovers: true });
    let text = null;

    // 1. common.lyrics
    if (metadata.common?.lyrics) {
      if (Array.isArray(metadata.common.lyrics)) {
        text = metadata.common.lyrics.join('\n');
      } else if (typeof metadata.common.lyrics === 'string') {
        text = metadata.common.lyrics;
      }
    }

    // 2. ID3 USLT / SYLT
    if (!text && metadata.native) {
      for (const format of Object.values(metadata.native)) {
        if (!Array.isArray(format)) continue;
        for (const tag of format) {
          if (!tag) continue;
          const id = (tag.id || '').toUpperCase();
          if (id === 'USLT' || id === 'SYLT' || id === 'LYRICS' || id === 'UNSYNCEDLYRICS') {
            if (typeof tag.value === 'string' && tag.value.trim()) {
              text = tag.value;
              break;
            } else if (tag.value && typeof tag.value.text === 'string' && tag.value.text.trim()) {
              text = tag.value.text;
              break;
            }
          }
        }
        if (text) break;
      }
    }

    if (text && text.trim()) {
      const clean = text.trim();
      const synced = clean.includes('[') && /\d{2}:\d{2}/.test(clean);
      return {
        synced,
        type: synced ? 'line' : 'plain',
        lyrics: clean,
        source: 'embedded',
      };
    }
  } catch {}
  return null;
}

async function fetchJsonSafe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function scoreSearchMatch(cand, targetDuration) {
  if (!cand || (!cand.syncedLyrics && !cand.plainLyrics)) return -1;
  let score = 0;
  if (cand.syncedLyrics) score += 50;
  if (cand.plainLyrics) score += 20;

  if (targetDuration && cand.duration) {
    const diff = Math.abs(cand.duration - targetDuration);
    if (diff <= 2) score += 35;
    else if (diff <= 5) score += 25;
    else if (diff <= 10) score += 15;
    else if (diff <= 20) score += 5;
    else score -= 10;
  }
  return score;
}

function candidateToResult(cand) {
  if (cand.syncedLyrics) {
    return {
      synced: true,
      type: 'line',
      lyrics: cand.syncedLyrics,
      source: 'lrclib',
    };
  }
  if (cand.plainLyrics) {
    return {
      synced: false,
      type: 'plain',
      lyrics: cand.plainLyrics,
      source: 'lrclib',
    };
  }
  return null;
}

/**
 * Fetch lyrics from LRCLIB using exact match first, followed by multi-tiered search fallback
 * with plasma-lrc cleaning heuristics.
 */
export async function fetchLrclibLyrics({ title, artist, album, duration }) {
  const rawTitle = tidy(title);
  const rawArtist = tidy(artist);
  if (!rawTitle) return null;

  const splitted = splitTrackArtistAndTitle(rawArtist, rawTitle);
  const baseTitle = splitted.title;
  const baseArtist = splitted.artist;

  const cleanedTitle = cleanTrackTitle(baseTitle);
  const cleanedArtist = cleanTrackArtist(baseArtist);
  const primaryArtist = extractPrimaryArtist(baseArtist);

  // 1. Try exact match (/api/get) with cleaned parameters
  const getParams = [];
  if (cleanedTitle && cleanedArtist) {
    getParams.push({ t: cleanedTitle, a: cleanedArtist });
  }
  if (cleanedTitle && primaryArtist && primaryArtist !== cleanedArtist) {
    getParams.push({ t: cleanedTitle, a: primaryArtist });
  }
  if (baseTitle !== cleanedTitle || baseArtist !== cleanedArtist) {
    getParams.push({ t: baseTitle, a: baseArtist });
  }

  for (const { t, a } of getParams) {
    let url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`;
    if (duration && duration > 0) {
      url += `&duration=${Math.round(duration)}`;
    }
    const data = await fetchJsonSafe(url);
    if (data) {
      const res = candidateToResult(data);
      if (res) return res;
    }
  }

  // 2. Multi-tier search fallback (/api/search)
  const searchQueries = [];

  // Tier 1: Search by clean title + clean artist
  if (cleanedTitle && cleanedArtist) {
    searchQueries.push(`track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(cleanedArtist)}`);
  }

  // Tier 2: Search by clean title + primary artist
  if (cleanedTitle && primaryArtist && primaryArtist !== cleanedArtist) {
    searchQueries.push(`track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(primaryArtist)}`);
  }

  // Tier 3: Search by clean title + full raw artist
  if (cleanedTitle && rawArtist && rawArtist !== cleanedArtist && rawArtist !== primaryArtist) {
    searchQueries.push(`track_name=${encodeURIComponent(cleanedTitle)}&artist_name=${encodeURIComponent(rawArtist)}`);
  }

  // Tier 4: Fuzzy query search ?q=cleanTitle primaryArtist
  if (cleanedTitle && primaryArtist) {
    searchQueries.push(`q=${encodeURIComponent(cleanedTitle + ' ' + primaryArtist)}`);
  }

  // Tier 5: Raw fallback query search ?q=rawTitle rawArtist
  if (baseTitle && baseArtist && (baseTitle !== cleanedTitle || baseArtist !== primaryArtist)) {
    searchQueries.push(`q=${encodeURIComponent(baseTitle + ' ' + baseArtist)}`);
  }

  let bestCandidate = null;
  let bestScore = -1;

  for (const queryStr of searchQueries) {
    const list = await fetchJsonSafe(`https://lrclib.net/api/search?${queryStr}`);
    if (Array.isArray(list) && list.length > 0) {
      for (const item of list) {
        const score = scoreSearchMatch(item, duration);
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = item;
          // If we found a synced match with duration match <= 2s, it's virtually perfect
          if (item.syncedLyrics && duration && Math.abs(item.duration - duration) <= 2) {
            break;
          }
        }
      }
      if (bestCandidate && bestScore >= 70) {
        break;
      }
    }
  }

  if (bestCandidate) {
    return candidateToResult(bestCandidate);
  }

  return null;
}
