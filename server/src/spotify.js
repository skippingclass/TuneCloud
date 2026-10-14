import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../covers');
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

let accessToken = null;
let tokenExpiresAt = 0;

// In-memory cache for fast repeat lookups
const artistCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getPrimaryArtistName(name) {
  if (!name) return '';
  const parts = name.split(/[,&/]|(?:\s+feat\.?|\s+ft\.?|\s+featuring)\s+/i);
  return (parts[0] || name).trim();
}

async function getSpotifyAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) return null;

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) return null;

    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  } catch {
    return null;
  }
}

async function searchSpotifyArtist(name) {
  const token = await getSpotifyAccessToken();
  if (!token) return null;

  const query = `artist:"${name}"`;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=artist&limit=10`;

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) return null;

    const data = await res.json();
    const artists = data.artists?.items || [];
    if (!artists.length) return null;

    const normalized = name.toLowerCase().trim();
    const exact = artists.find(
      (a) => a.name.toLowerCase().trim() === normalized
    );

    const match = exact || artists[0];
    if (!match || !match.images?.length) return null;

    return {
      id: match.id,
      name: match.name,
      image: match.images[0].url,
      thumbnail: match.images[match.images.length - 1]?.url || match.images[0].url,
      followers: match.followers?.total || 0,
      genres: match.genres || [],
      source: 'spotify',
    };
  } catch {
    return null;
  }
}

async function searchDeezerArtist(name) {
  if (!name) return null;
  const queries = [name];
  const primary = getPrimaryArtistName(name);
  if (primary && primary.toLowerCase() !== name.toLowerCase()) {
    queries.push(primary);
  }

  for (const q of queries) {
    try {
      const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=10`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const data = await res.json();
      const list = data?.data || [];
      if (!list.length) continue;

      const normalized = q.toLowerCase().trim();
      const exact = list.find((a) => a.name?.toLowerCase().trim() === normalized);
      const match = exact || list[0];

      if (match) {
        const image = match.picture_xl || match.picture_big || match.picture_medium || match.picture;
        if (!image) continue;

        return {
          id: String(match.id),
          name: match.name,
          image,
          thumbnail: match.picture_medium || match.picture_small || image,
          followers: match.nb_fan || 0,
          genres: [],
          source: 'deezer',
        };
      }
    } catch {}
  }
  return null;
}

export async function searchArtist(name) {
  if (!name || typeof name !== 'string') return null;
  const clean = name.trim();
  if (!clean) return null;

  const cacheKey = clean.toLowerCase();
  const cached = artistCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  // 1. Try Spotify first if available
  let result = await searchSpotifyArtist(clean);

  // 2. If Spotify fails (e.g. 403 Forbidden or no credentials), fallback to Deezer
  if (!result) {
    result = await searchDeezerArtist(clean);
  }

  // Cache result (even if null, to prevent hammering upstream APIs)
  artistCache.set(cacheKey, {
    result,
    timestamp: Date.now(),
  });

  return result;
}

function cachePath(artistId) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, `artist_${artistId}.jpg`);
}

export async function getArtistImage(name, artistDbId) {
  const cached = path.join(CACHE_DIR, `artist_${artistDbId}.jpg`);
  if (fs.existsSync(cached)) return `/api/cover/artist_${artistDbId}.jpg`;

  const info = await searchArtist(name);
  if (!info?.image) return null;

  try {
    const imgRes = await fetch(info.image);
    if (!imgRes.ok) return null;
    const buf = Buffer.from(await imgRes.arrayBuffer());
    fs.writeFileSync(cached, buf);
    return `/api/cover/artist_${artistDbId}.jpg`;
  } catch {
    return null;
  }
}
