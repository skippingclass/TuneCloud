import crypto from 'node:crypto';
import { requireAuth } from '../auth.js';
import { query, transaction } from '../db.js';
import { configured, hash, encryptSession, decryptSession, DEFAULT_SETTINGS, lastfmRequest, LastfmError, eligible, trackMetadata, metadataPayload } from '../services/lastfm.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const fields = Object.keys(DEFAULT_SETTINGS);
function settings(account) { return Object.fromEntries(fields.map(key => [key, account?.[key] ?? DEFAULT_SETTINGS[key]])); }
function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid settings');
  for (const [key, value] of Object.entries(body)) {
    if (!fields.includes(key)) throw fail('Unknown setting');
    if (typeof DEFAULT_SETTINGS[key] === 'boolean' && typeof value !== 'boolean') throw fail(`Invalid ${key}`);
    const ranges = { percent: [50, 100], seconds: [240, 600], min_duration: [30, 3600] };
    if (ranges[key] && (!Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1])) throw fail(`Invalid ${key}`);
  }
}
async function accountForUpdate(client, userId) {
  return (await client.query('SELECT * FROM lastfm_accounts WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
}
export default async function lastfmRoutes(app, { request = lastfmRequest } = {}) {
  app.addHook('onSend', async (req, reply, payload) => { reply.header('Cache-Control', 'no-store'); return payload; });
  const auth = { preHandler: requireAuth };
  const available = () => { if (!configured()) throw fail('Last.fm is not configured on this server', 503); };
  app.get('/api/lastfm', auth, async req => {
    const account = (await query('SELECT * FROM lastfm_accounts WHERE user_id=$1', [req.user.id])).rows[0];
    const counts = (await query('SELECT status,count(*)::int AS count FROM lastfm_outbox WHERE user_id=$1 GROUP BY status', [req.user.id])).rows;
    return { configured: configured(), connected: Boolean(account), username: account?.username || null,
      connectionId: account?.connection_id || null, needsReauth: account?.needs_reauth || false, settings: settings(account),
      counts: Object.fromEntries(counts.map(r => [r.status, r.count])) };
  });
  app.post('/api/lastfm/connect', auth, async req => {
    available();
    const state = crypto.randomBytes(32).toString('hex');
    // Web authorization returns a token in the callback. Pre-issuing a token
    // selects Last.fm's desktop flow, which asks the user to return manually.
    await query(`INSERT INTO lastfm_auth_attempts(user_id,state_hash,token_hash,auth_version,expires_at) VALUES($1,$2,NULL,$3,now()+interval '10 minutes')
      ON CONFLICT(user_id) DO UPDATE SET state_hash=$2,token_hash=NULL,auth_version=$3,expires_at=EXCLUDED.expires_at`,
    [req.user.id, hash(state), req.user.auth_version]);
    const callback = new URL(process.env.PUBLIC_URL);
    callback.pathname = callback.pathname.replace(/\/$/, '') + '/settings'; callback.search = ''; callback.hash = '';
    callback.searchParams.set('lastfm_state', state);
    const url = new URL('https://www.last.fm/api/auth/');
    url.search = new URLSearchParams({ api_key: process.env.LASTFM_API_KEY, cb: callback.href }).toString();
    return { url: url.href };
  });
  app.post('/api/lastfm/complete', auth, async req => {
    available();
    const { token, state } = req.body || {};
    if (typeof token !== 'string' || !token.trim() || token.length > 256 || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw fail('Invalid authorization callback');
    return transaction(async client => {
      // Keep the old token binding for attempts created before the web-flow
      // migration; new attempts are bound by their one-time state instead.
      const attempt = (await client.query(`DELETE FROM lastfm_auth_attempts WHERE user_id=$1 AND state_hash=$2 AND (token_hash IS NULL OR token_hash=$3) AND auth_version=$4 AND expires_at>now() RETURNING user_id`,
        [req.user.id, hash(state), hash(token), req.user.auth_version])).rows[0];
      if (!attempt) throw fail('Authorization expired or belongs to another account. Connect again.');
      const result = await request('auth.getSession', { token });
      if (!result.session?.key || !result.session?.name) throw fail('Invalid Last.fm session response', 502);
      // Replacing an account discards its queue. Never deliver it to a different user.
      await client.query('DELETE FROM lastfm_accounts WHERE user_id=$1', [req.user.id]);
      await client.query(`INSERT INTO lastfm_accounts(user_id,connection_id,username,session_secret) VALUES($1,$2,$3,$4)`,
        [req.user.id, crypto.randomUUID(), result.session.name, encryptSession(result.session.key)]);
      return { success: true };
    });
  });
  app.delete('/api/lastfm', auth, async req => {
    await transaction(async client => {
      await client.query('DELETE FROM lastfm_auth_attempts WHERE user_id=$1', [req.user.id]);
      await client.query('DELETE FROM lastfm_accounts WHERE user_id=$1', [req.user.id]);
    });
    return { success: true };
  });
  app.patch('/api/lastfm/settings', auth, async req => {
    validateSettings(req.body);
    return transaction(async client => {
      const account = await accountForUpdate(client, req.user.id);
      if (!account) throw fail('Connect Last.fm first', 409);
      const next = { ...settings(account), ...req.body };
      await client.query(`UPDATE lastfm_accounts SET enabled=$2,now_playing=$3,percent=$4,seconds=$5,min_duration=$6,first_artist=$7 WHERE user_id=$1`,
        [req.user.id, ...fields.map(k => next[k])]);
      return next;
    });
  });
  for (const kind of ['now-playing', 'scrobble']) app.post(`/api/lastfm/${kind}`, auth, async req => {
    available();
    const body = req.body || {};
    if (!Number.isInteger(body.trackId) || body.trackId <= 0 || body.trackId > 2147483647 || !uuid.test(body.eventId || '') || !uuid.test(body.connectionId || '') ||
      !Number.isInteger(body.startedAt) || body.startedAt < 0 || body.startedAt > Math.floor(Date.now() / 1000) + 60 ||
      (kind === 'scrobble' && (!Number.isFinite(body.listenedSeconds) || body.listenedSeconds < 0))) throw fail('Invalid playback event');
    return transaction(async client => {
      const account = await accountForUpdate(client, req.user.id);
      if (!account || account.connection_id !== body.connectionId || !account.enabled || account.needs_reauth) return { accepted: false, reason: 'disabled' };
      const data = await trackMetadata(client, body.trackId, req.user.id, account);
      if (!data) throw fail('Track not found', 404);
      if (data.blocked) return { accepted: false, reason: 'blocked' };
      if (!data.payload.artist || !data.payload.track) return { accepted: false, reason: 'missing_metadata' };
      if (kind === 'now-playing') {
        if (!account.now_playing) return { accepted: false, reason: 'disabled' };
        try { await request('track.updateNowPlaying', data.payload, decryptSession(account.session_secret)); }
        catch (error) {
          if (error.code === 9) await client.query('UPDATE lastfm_accounts SET needs_reauth=true WHERE user_id=$1', [req.user.id]);
          return { accepted: false, reason: 'upstream_error' };
        }
      } else {
        if (!eligible(data.track.duration, body.listenedSeconds, account)) return { accepted: false, reason: 'below_threshold' };
        const payload = { ...data.payload, timestamp: String(body.startedAt) };
        await client.query(`INSERT INTO lastfm_outbox(user_id,connection_id,event_id,track_id,payload) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(user_id,connection_id,event_id) DO NOTHING`, [req.user.id, account.connection_id, body.eventId, body.trackId, payload]);
      }
      return { accepted: true };
    });
  });
  app.get('/api/lastfm/queue', auth, async req => {
    const offset = Number(req.query.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000) throw fail('Invalid offset');
    const { rows } = await query(`SELECT id,event_id,track_id,payload,status,attempts,last_error,next_attempt_at,created_at FROM lastfm_outbox WHERE user_id=$1 ORDER BY id DESC LIMIT 25 OFFSET $2`, [req.user.id, offset]);
    return { items: rows };
  });
  app.post('/api/lastfm/retry', auth, async req => {
    await query(`UPDATE lastfm_outbox SET next_attempt_at=now() WHERE user_id=$1 AND status='pending' AND last_error IS NOT NULL`, [req.user.id]);
    return { success: true };
  });
  app.get('/api/lastfm/rules', auth, async req => {
    const tracks = (await query(`SELECT r.*,t.title FROM lastfm_track_rules r JOIN tracks t ON t.id=r.track_id WHERE r.user_id=$1 ORDER BY t.title`, [req.user.id])).rows;
    const artists = (await query(`SELECT b.artist_id,a.name FROM lastfm_artist_blocks b JOIN artists a ON a.id=b.artist_id WHERE b.user_id=$1 ORDER BY a.name`, [req.user.id])).rows;
    return { tracks, artists };
  });
  app.get('/api/lastfm/tracks/:id', auth, async req => {
    const account = (await query('SELECT * FROM lastfm_accounts WHERE user_id=$1', [req.user.id])).rows[0];
    const data = await trackMetadata({ query }, Number(req.params.id), req.user.id, account || DEFAULT_SETTINGS);
    if (!data) throw fail('Track not found', 404);
    return { overrides: data.track.overrides, blocked: data.track.track_blocked, artistBlocked: data.track.artist_blocked,
      artistId: data.track.artist_id, original: metadataPayload(data.track, account || DEFAULT_SETTINGS), preview: data.payload };
  });
  app.put('/api/lastfm/tracks/:id', auth, async req => {
    const { overrides, blocked } = req.body || {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || typeof blocked !== 'boolean') throw fail('Invalid track rule');
    for (const [key, value] of Object.entries(overrides)) {
      if (!['artist', 'track', 'album', 'albumArtist'].includes(key) || typeof value !== 'string' || value.length > 1000 || (['artist', 'track'].includes(key) && !value.trim())) throw fail('Invalid metadata override');
    }
    if (!(await query('SELECT id FROM tracks WHERE id=$1', [req.params.id])).rowCount) throw fail('Track not found', 404);
    await query(`INSERT INTO lastfm_track_rules(user_id,track_id,overrides,blocked) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_id,track_id) DO UPDATE SET overrides=$3,blocked=$4`, [req.user.id, req.params.id, overrides, blocked]);
    return { success: true };
  });
  app.delete('/api/lastfm/tracks/:id', auth, async req => {
    await query('DELETE FROM lastfm_track_rules WHERE user_id=$1 AND track_id=$2', [req.user.id, req.params.id]);
    return { success: true };
  });
  app.put('/api/lastfm/artists/:id', auth, async req => {
    if (typeof req.body?.blocked !== 'boolean') throw fail('Invalid artist rule');
    if (!(await query('SELECT id FROM artists WHERE id=$1', [req.params.id])).rowCount) throw fail('Artist not found', 404);
    if (req.body.blocked) await query('INSERT INTO lastfm_artist_blocks(user_id,artist_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.params.id]);
    else await query('DELETE FROM lastfm_artist_blocks WHERE user_id=$1 AND artist_id=$2', [req.user.id, req.params.id]);
    return { success: true };
  });
  // Route-local upstream errors have safe messages; Fastify handles validation/DB errors.
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof LastfmError) return reply.code(502).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message });
    req.log.error({ code: error.code }, 'Last.fm operation failed');
    reply.code(error.statusCode || 500).send({ error: 'Last.fm operation unavailable' });
  });
}
