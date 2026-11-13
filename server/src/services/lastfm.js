import crypto from 'node:crypto';
import { query, transaction } from '../db.js';

// Behavior inspired by Pano Scrobbler (GPL-3.0-or-later): MainPrefs,
// PendingScrobblesWorker and FirstArtistExtractor. Independently implemented.
// https://github.com/kawaiiDango/pano-scrobbler
export const DEFAULT_SETTINGS = { enabled: true, now_playing: false, percent: 50, seconds: 240, min_duration: 30, first_artist: true };
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export function configured() {
  try {
    const url = new URL(process.env.PUBLIC_URL);
    return Boolean(process.env.LASTFM_API_KEY && process.env.LASTFM_API_SECRET && process.env.LASTFM_ENCRYPTION_KEY?.length >= 32 &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) && !url.username && !url.password);
  } catch { return false; }
}
let cachedEncryptionSecret = null;
let cachedEncryptionKey = null;

function encryptionKey() {
  const secret = process.env.LASTFM_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error('Last.fm encryption key unavailable');
  if (secret !== cachedEncryptionSecret) {
    cachedEncryptionKey = crypto.scryptSync(secret, 'tunecloud-lastfm-v1', 32);
    cachedEncryptionSecret = secret;
  }
  return cachedEncryptionKey;
}
export function encryptSession(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(v => v.toString('hex')).join(':');
}
export function decryptSession(value) {
  const [iv, tag, data] = value.split(':').map(v => Buffer.from(v, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
export function signature(params, secret) {
  return crypto.createHash('md5').update(Object.keys(params).filter(k => !['format', 'callback', 'api_sig'].includes(k)).sort()
    .map(k => k + params[k]).join('') + secret, 'utf8').digest('hex');
}
export class LastfmError extends Error {
  constructor(code, retryable = false) {
    // Never forward upstream text, which may contain request secrets.
    super(({ 9: 'Reconnect your Last.fm account', 29: 'Last.fm rate limit; retry scheduled', 26: 'Last.fm suspended this API key' })[code] || (retryable ? 'Last.fm temporarily unavailable' : `Last.fm rejected request (${code})`));
    this.code = code; this.retryable = retryable;
  }
}
export async function lastfmRequest(method, values = {}, session, fetcher = globalThis.fetch) {
  const params = { ...values, method, api_key: process.env.LASTFM_API_KEY, ...(session ? { sk: session } : {}) };
  params.api_sig = signature(params, process.env.LASTFM_API_SECRET);
  params.format = 'json';
  try {
    const response = await fetcher('https://ws.audioscrobbler.com/2.0/', {
      method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429 || response.status >= 500) throw new LastfmError(response.status, true);
    const data = await response.json();
    if (data.error) throw new LastfmError(Number(data.error), [8, 11, 16, 29].includes(Number(data.error)));
    if (!response.ok) throw new LastfmError(response.status);
    return data;
  } catch (error) {
    if (error instanceof LastfmError) throw error;
    throw new LastfmError('network', true);
  }
}
export function threshold(duration, settings = DEFAULT_SETTINGS) {
  return Math.min(duration * settings.percent / 100, settings.seconds);
}
export function eligible(duration, listened, settings = DEFAULT_SETTINGS) {
  return Number.isFinite(duration) && duration > settings.min_duration && Number.isFinite(listened) && listened >= threshold(duration, settings);
}
export function metadataPayload(track, settings, overrides = {}) {
  const allArtists = track.metadata?.artists?.length > 1 ? track.metadata.artists.map(a => a.name).filter(Boolean).join(', ') : '';
  const value = {
    artist: (settings.first_artist ? track.metadata?.artists?.[0]?.name || track.artist : null) ||
      (allArtists && (!track.track_artist_credit || track.track_artist_credit === track.artist) ? allArtists : track.track_artist_credit) || track.artist || '',
    track: track.title || '', album: track.album || '',
    albumArtist: (settings.first_artist ? track.metadata?.albumArtists?.[0]?.name || track.album_artist : null) || track.album_artist_credit || track.album_artist || '',
    duration: String(Math.floor(track.duration || 0)),
  };
  for (const key of ['artist', 'track', 'album', 'albumArtist']) if (overrides[key] !== undefined) value[key] = overrides[key];
  for (const key of ['artist', 'track', 'album', 'albumArtist']) value[key] = value[key].trim();
  return value;
}
export async function trackMetadata(client, trackId, userId, settings) {
  const { rows } = await client.query(`SELECT t.*, a.name AS artist, al.title AS album, aa.name AS album_artist,
    COALESCE(r.overrides,'{}') AS overrides, COALESCE(r.blocked,false) AS track_blocked,
    EXISTS (SELECT 1 FROM lastfm_artist_blocks b WHERE b.user_id=$2 AND
      (b.artist_id=t.artist_id OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.metadata->'artists','[]')) c WHERE c->>'id'=b.artist_id::text))) AS artist_blocked
    FROM tracks t LEFT JOIN artists a ON a.id=t.artist_id LEFT JOIN albums al ON al.id=t.album_id
    LEFT JOIN artists aa ON aa.id=al.artist_id LEFT JOIN lastfm_track_rules r ON r.track_id=t.id AND r.user_id=$2 WHERE t.id=$1`, [trackId, userId]);
  const track = rows[0];
  if (!track) return null;
  return { track, payload: metadataPayload(track, settings, track.overrides), blocked: track.track_blocked || track.artist_blocked };
}
export function batchParams(entries) {
  return Object.fromEntries(entries.flatMap((entry, i) => Object.entries(entry.payload).filter(([, v]) => v !== '').map(([k, v]) => [`${k}[${i}]`, v])));
}
export async function processAccount(userId, request = lastfmRequest) {
  // Keep the account and batch locked through delivery. PostgreSQL releases locks
  // on crash/rollback, so no stuck processing jobs or separate lease service.
  return transaction(async client => {
    const account = (await client.query(`SELECT * FROM lastfm_accounts WHERE user_id=$1 AND enabled AND NOT needs_reauth FOR UPDATE SKIP LOCKED`, [userId])).rows[0];
    if (!account) return;
    const entries = (await client.query(`SELECT * FROM lastfm_outbox WHERE user_id=$1 AND connection_id=$2 AND status='pending' AND next_attempt_at<=now()
      ORDER BY (payload->>'timestamp')::bigint,id LIMIT 50 FOR UPDATE SKIP LOCKED`, [userId, account.connection_id])).rows;
    if (!entries.length) return;
    let session;
    try { session = decryptSession(account.session_secret); }
    catch {
      await client.query('UPDATE lastfm_accounts SET needs_reauth=true WHERE user_id=$1', [userId]);
      return;
    }
    try {
      const result = await request('track.scrobble', batchParams(entries), session);
      const raw = result.scrobbles?.scrobble;
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (items.length !== entries.length || items.some(item => !/^\d+$/.test(String(item.ignoredMessage?.code ?? '')))) throw new LastfmError('invalid-response', true);
      for (const [i, entry] of entries.entries()) {
        const code = String(items[i].ignoredMessage?.code ?? '');
        if (!/^\d+$/.test(code)) throw new LastfmError('invalid-response', true);
        const retry = code === '5'; // Daily scrobble limit, not a permanent rejection.
        await client.query(`UPDATE lastfm_outbox SET status=$2, attempts=attempts+1, last_error=$3,
          next_attempt_at=now()+interval '24 hours',updated_at=now() WHERE id=$1`,
        [entry.id, retry ? 'pending' : code === '0' ? 'sent' : 'ignored', code === '0' ? null : `Last.fm ignored scrobble (code ${code})`]);
      }
    } catch (error) {
      if (!(error instanceof LastfmError)) throw error;
      if (error.code === 9) await client.query('UPDATE lastfm_accounts SET needs_reauth=true WHERE user_id=$1', [userId]);
      await client.query(`UPDATE lastfm_outbox SET status=$2, attempts=attempts+1, last_error=$3,
        next_attempt_at=now()+CASE WHEN $4::int IS NOT NULL THEN $4 ELSE LEAST(3600,10*(1<<LEAST(attempts,9))) END*interval '1 second',
        updated_at=now() WHERE id=ANY($1::bigint[])`,
      [entries.map(e => e.id), error.retryable || error.code === 9 ? 'pending' : 'failed', error.message, error.code === 29 ? 300 : null]);
    }
  });
}
export function startWorker(logger) {
  let stopped = false, running = null;
  const tick = () => {
    if (stopped || running || !configured()) return;
    running = (async () => {
      const { rows } = await query(`SELECT DISTINCT a.user_id FROM lastfm_accounts a JOIN lastfm_outbox o ON o.user_id=a.user_id
        WHERE a.enabled AND NOT a.needs_reauth AND o.status='pending' AND o.next_attempt_at<=now() LIMIT 100`);
      for (const row of rows) {
        if (stopped) break;
        try { await processAccount(row.user_id); } catch { logger.error('Last.fm account delivery failed; will retry'); }
      }
      await query('DELETE FROM lastfm_auth_attempts WHERE expires_at<now()');
    })().catch(() => logger.error('Last.fm worker failed; will retry')).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 10000); timer.unref(); tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
