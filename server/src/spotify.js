import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(process.env.COVERS_DIR || path.join(__dirname, '../covers'));
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';

export const REQUEST_TIMEOUT_MS = 5000;
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for successful artist info
export const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes for confirmed "not found"
export const MAX_CACHE_SIZE = 500;
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB maximum image size

let accessToken = null;
let tokenExpiresAt = 0;

export class BoundedTtlCache {
  constructor({ maxSize = MAX_CACHE_SIZE, defaultTtlMs = CACHE_TTL_MS } = {}) {
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.pruneExpired();
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now >= entry.expiresAt) {
        this.map.delete(key);
      }
    }
  }
}

export const artistCache = new BoundedTtlCache({ maxSize: MAX_CACHE_SIZE, defaultTtlMs: CACHE_TTL_MS });
export const inFlight = new Map();

export async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const isTransient = res.status >= 500 || res.status === 429;
      return { error: true, transient: isTransient };
    }

    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
  } catch {
    return { error: true, transient: true };
  }
}

async function searchSpotifyArtist(name) {
  const tokenOrErr = await getSpotifyAccessToken();
  if (!tokenOrErr) {
    return { status: 'unconfigured' };
  }
  if (typeof tokenOrErr === 'object' && tokenOrErr.error) {
    return { status: 'error', transient: tokenOrErr.transient };
  }
  const token = tokenOrErr;

  const query = `artist:"${name}"`;
  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=artist&limit=10`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        accessToken = null;
      }
      return { status: 'error', transient: res.status >= 500 || res.status === 429 };
    }

    const data = await res.json();
    const artists = data.artists?.items || [];
    if (!artists.length) return { status: 'not_found' };

    const normalized = name.toLowerCase().trim();
    const exact = artists.find(
      (a) => a.name.toLowerCase().trim() === normalized
    );

    const match = exact || artists[0];
    if (!match || !match.images?.length) return { status: 'not_found' };

    return {
      status: 'found',
      artist: {
        id: match.id,
        name: match.name,
        image: match.images[0].url,
        thumbnail: match.images[match.images.length - 1]?.url || match.images[0].url,
        followers: match.followers?.total || 0,
        genres: match.genres || [],
        source: 'spotify',
      },
    };
  } catch {
    return { status: 'error', transient: true };
  }
}

async function searchDeezerArtist(name) {
  if (!name) return { status: 'not_found' };
  const queries = [name];
  const primary = getPrimaryArtistName(name);
  if (primary && primary.toLowerCase() !== name.toLowerCase()) {
    queries.push(primary);
  }

  let anyTransientError = false;
  for (const q of queries) {
    try {
      const url = `https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=10`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) anyTransientError = true;
        continue;
      }

      const data = await res.json();
      if (data?.error) {
        anyTransientError = true;
        continue;
      }
      const list = data?.data || [];
      if (!list.length) continue;

      const normalized = q.toLowerCase().trim();
      const exact = list.find((a) => a.name?.toLowerCase().trim() === normalized);
      const match = exact || list[0];

      if (match) {
        const image = match.picture_xl || match.picture_big || match.picture_medium || match.picture;
        if (!image) continue;

        return {
          status: 'found',
          artist: {
            id: String(match.id),
            name: match.name,
            image,
            thumbnail: match.picture_medium || match.picture_small || image,
            genres: [],
            source: 'deezer',
          },
        };
      }
    } catch {
      anyTransientError = true;
    }
  }

  if (anyTransientError) {
    return { status: 'error', transient: true };
  }
  return { status: 'not_found' };
}

async function executeSearch(clean, cacheKey) {
  // 1. Try Spotify first
  const spotifyRes = await searchSpotifyArtist(clean);
  if (spotifyRes.status === 'found') {
    artistCache.set(cacheKey, spotifyRes.artist, CACHE_TTL_MS);
    return spotifyRes.artist;
  }

  // 2. Try Deezer fallback
  const deezerRes = await searchDeezerArtist(clean);
  if (deezerRes.status === 'found') {
    artistCache.set(cacheKey, deezerRes.artist, CACHE_TTL_MS);
    return deezerRes.artist;
  }

  const isTransient =
    (spotifyRes.status === 'error' && spotifyRes.transient) ||
    (deezerRes.status === 'error' && deezerRes.transient);

  if (isTransient) {
    // DO NOT cache transient network errors for 24 hours!
    return null;
  }

  // Both services confirmed not found
  artistCache.set(cacheKey, null, NEGATIVE_CACHE_TTL_MS);
  return null;
}

export async function searchArtist(name) {
  if (!name || typeof name !== 'string') return null;
  const clean = name.trim();
  if (!clean) return null;

  const cacheKey = clean.toLowerCase();
  const cached = artistCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Request coalescing: reuse active in-flight request for identical key
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    try {
      return await executeSearch(clean, cacheKey);
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

export async function getArtistImage(name, artistDbId) {
  const cached = path.join(CACHE_DIR, `artist_${artistDbId}.jpg`);
  if (fs.existsSync(cached)) return `/api/cover/artist_${artistDbId}.jpg`;

  const info = await searchArtist(name);
  if (!info?.image) return null;

  try {
    const imgRes = await fetchWithTimeout(info.image, {}, REQUEST_TIMEOUT_MS);
    if (!imgRes.ok) return null;

    const contentLength = parseInt(imgRes.headers.get('content-length'), 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_SIZE) {
      return null;
    }

    if (!imgRes.body) return null;

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of imgRes.body) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_IMAGE_SIZE) {
        return null;
      }
      chunks.push(chunk);
    }

    if (totalBytes === 0) return null;

    const buf = Buffer.concat(chunks);
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cached, buf);
    return `/api/cover/artist_${artistDbId}.jpg`;
  } catch {
    return null;
  }
}
