import { cleanTrackTitle, cleanTrackArtist, extractPrimaryArtist, splitTrackArtistAndTitle } from './lyrics.js';

const ORIGIN = 'https://lrc.red';
const MAX_RESPONSE_BYTES = 512 * 1024;
const inFlight = new Map();

function normalized(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titleKey(title) {
  return normalized(cleanTrackTitle(title).replace(/\([^)]*remaster[^)]*\)|\[[^\]]*remaster[^\]]*\]/gi, ''));
}

function versionKey(title) {
  return [...new Set((String(title).toLowerCase().match(/\b(?:live|acoustic|remix|instrumental|karaoke|demo|sped|slowed)\b/g) || []))].sort().join(',');
}

function scoreMatch(hit, target) {
  if (!hit || !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(hit.isrc || '')) return -1;
  if (titleKey(hit.title) !== titleKey(target.title) || versionKey(hit.title) !== versionKey(target.title)) return -1;
  const artist = normalized(cleanTrackArtist(hit.artist));
  if (!artist || ![cleanTrackArtist(target.artist), extractPrimaryArtist(target.artist)].some(a => normalized(a) === artist)) return -1;
  const difference = Math.abs(Number(hit.duration) - Number(target.duration));
  if (target.duration > 0 && (!Number.isFinite(difference) || difference > 5)) return -1;
  return (normalized(hit.album) === normalized(target.album) ? 10 : 0) + (target.duration > 0 ? 5 - difference : 0);
}

// Enhanced LRC may contain word timestamps. Keep only the line timestamps.
export function normalizeLineLrc(text) {
  if (typeof text !== 'string') return null;
  const lyrics = text.replace(/^\uFEFF/, '').replace(/<\d+:\d{2}(?:[.:]\d{1,3})?>/g, '').trim();
  const hasTimedText = lyrics.split(/\r?\n/).some(raw => {
    const line = raw.trim();
    const prefix = line.match(/^(?:\[\d+:\d{2}(?:[.:]\d{1,3})?\])+/)?.[0];
    return prefix && line.slice(prefix.length).trim() &&
      [...prefix.matchAll(/\[\d+:(\d{2})(?:[.:]\d{1,3})?\]/g)].some(match => Number(match[1]) < 60);
  });
  if (!hasTimedText) return null;
  return lyrics;
}

async function readResponse(url, accept, { fetchImpl, timeoutMs, userAgent }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'User-Agent': userAgent, Accept: accept },
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) { controller.abort(); return null; }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(target, options) {
  const query = new URLSearchParams({ q: `${target.title} ${target.artist}` });
  const raw = await readResponse(`${ORIGIN}/search.json?${query}`, 'application/json', options);
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(data?.hits)) return null;
  const matches = data.hits.slice(0, 50).map(hit => ({ hit, score: scoreMatch(hit, target) }))
    .filter(item => item.score >= 0).sort((a, b) => b.score - a.score);
  for (const { hit } of matches.slice(0, 3)) {
    const text = await readResponse(`${ORIGIN}/s/${hit.isrc.toUpperCase()}.lrc`, 'text/plain', options);
    if (text === null) return null; // Do not retry other candidates during an outage/rate limit.
    const lyrics = normalizeLineLrc(text);
    if (lyrics) return { synced: true, type: 'line', lyrics, source: 'lrc.red' };
  }
  return null;
}

export async function fetchLrcRedLyrics(metadata, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const { title, artist } = splitTrackArtistAndTitle(metadata.artist, metadata.title);
  if (!title || !artist) return null;
  const contact = (process.env.LRC_RED_CONTACT_EMAIL || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact)) return null;
  const target = { ...metadata, title, artist };
  const key = JSON.stringify([target, contact]);
  if (inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= 100) return null;
  const request = lookup(target, {
    fetchImpl, timeoutMs,
    userAgent: `TuneCloud/0.1.0 (https://github.com/skippingclass/TuneCloud; contact: ${contact})`,
  });
  inFlight.set(key, request);
  try { return await request; } finally { inFlight.delete(key); }
}
