import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('Last.fm account isolation, playback acceptance and persistent concurrent delivery', { skip: !databaseUrl }, async t => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'lastfm_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  Object.assign(process.env, { DATABASE_URL: url.toString(), DOTENV_CONFIG_PATH: '/dev/null', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    LASTFM_API_KEY: 'api-key', LASTFM_API_SECRET: 'api-secret', LASTFM_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), PUBLIC_URL: 'https://music.example.test' });
  const { default: pool, initDb, query } = await import('../src/db.js');
  const { signToken } = await import('../src/auth.js');
  const { processAccount, LastfmError, decryptSession } = await import('../src/services/lastfm.js');
  const originalFetch = globalThis.fetch;
  let serial = 0, calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = Object.fromEntries(opts.body); calls.push(body);
    const data = body.method === 'auth.getToken' ? { token: 'token-' + ++serial } : body.method === 'auth.getSession' ? { session: { name: 'lastfm-user', key: 'session-secret' } } : {};
    return { ok: true, status: 200, json: async () => data };
  };
  let app;
  try {
    await initDb(); app = await (await import('../src/index.js')).buildApp(); app.log.level = 'silent';
    const users = (await query("INSERT INTO users(username,password_hash) VALUES('alpha','unused'),('beta','unused') RETURNING *")).rows;
    const artist = (await query("INSERT INTO artists(name) VALUES('Artist') RETURNING id")).rows[0].id;
    const track = (await query("INSERT INTO tracks(file_path,file_name,title,artist_id,duration,metadata) VALUES('/virtual/a','a.mp3','Song',$1,300,$2) RETURNING id", [artist, { artists: [{ name: 'First', id: String(artist) }] }])).rows[0].id;
    const request = (method, path, payload, user = users[0]) => app.inject({ method, url: '/api/lastfm' + path, headers: { authorization: 'Bearer ' + signToken(user) }, payload });
    const start = async user => {
      const res = await request('POST', '/connect', {}, user); assert.equal(res.statusCode, 200, res.body);
      const authUrl = new URL(res.json().url), cb = new URL(authUrl.searchParams.get('cb'));
      assert.equal(cb.pathname, '/settings');
      return { token: authUrl.searchParams.get('token'), state: cb.searchParams.get('lastfm_state') };
    };
    const connect = async user => {
      const data = await start(user); const res = await request('POST', '/complete', data, user); assert.equal(res.statusCode, 200, res.body);
      return (await request('GET', '', undefined, user)).json().connectionId;
    };
    await t.test('authorization is single use, bound to user, token and current login version', async () => {
      const data = await start(users[0]);
      assert.equal((await request('POST', '/complete', data, users[1])).statusCode, 400);
      assert.equal((await request('POST', '/complete', { ...data, token: 'attacker-token' })).statusCode, 400);
      assert.equal((await request('POST', '/complete', data)).statusCode, 200);
      assert.equal((await request('POST', '/complete', data)).statusCode, 400);
      const row = (await query('SELECT session_secret FROM lastfm_accounts WHERE user_id=$1', [users[0].id])).rows[0];
      assert.equal(decryptSession(row.session_secret), 'session-secret');
      const status = (await request('GET', '')).body;
      assert.ok(!status.includes('session-secret')); assert.ok(!status.includes('session_secret'));
      const expired = await start(users[0]); await query("UPDATE lastfm_auth_attempts SET expires_at=now()-interval '1 minute'");
      assert.equal((await request('POST', '/complete', expired)).statusCode, 400);
      const revoked = await start(users[0]); await query('UPDATE lastfm_auth_attempts SET auth_version=auth_version+1');
      assert.equal((await request('POST', '/complete', revoked)).statusCode, 400);
      assert.equal((await app.inject('/api/lastfm')).statusCode, 401);
    });
    let connectionId = (await request('GET', '')).json().connectionId;
    const event = (extra = {}) => ({ trackId: track, eventId: crypto.randomUUID(), connectionId, startedAt: Math.floor(Date.now() / 1000) - 160, listenedSeconds: 150, ...extra });
    await t.test('local history threshold stays independent; duplicates enqueue once', async () => {
      const early = await request('POST', '/scrobble', event({ listenedSeconds: 30 })); assert.equal(early.json().reason, 'below_threshold');
      const body = event();
      for (let i = 0; i < 2; i++) assert.equal((await request('POST', '/scrobble', body)).json().accepted, true);
      assert.equal((await query('SELECT count(*)::int AS n FROM lastfm_outbox')).rows[0].n, 1);
      assert.equal((await query('SELECT count(*)::int AS n FROM play_history')).rows[0].n, 0);
      const local = await app.inject({ method: 'POST', url: `/api/scrobble/${track}`, headers: { authorization: 'Bearer ' + signToken(users[0]) }, payload: { eventId: crypto.randomUUID() } });
      assert.equal(local.statusCode, 200); assert.equal((await query('SELECT count(*)::int AS n FROM lastfm_outbox')).rows[0].n, 1);
      assert.equal((await request('POST', '/scrobble', event({ startedAt: Math.floor(Date.now() / 1000) + 600 }))).statusCode, 400);
      assert.equal((await request('PATCH', '/settings', { percent: 40 })).statusCode, 400);
      assert.equal((await request('PATCH', '/settings', { now_playing: false })).statusCode, 200);
      assert.equal((await request('POST', '/now-playing', event())).json().reason, 'disabled');
      assert.equal((await request('PATCH', '/settings', { now_playing: true })).statusCode, 200);
      assert.equal((await request('POST', '/now-playing', event())).json().accepted, true);
      assert.ok(calls.some(c => c.method === 'track.updateNowPlaying'));
    });
    await t.test('corrections and blocks are personal; payload is snapshotted', async () => {
      await connect(users[1]);
      const rule = { overrides: { artist: 'Correct Artist', track: 'Correct Song', album: '' }, blocked: false };
      assert.equal((await request('PUT', `/tracks/${track}`, rule)).statusCode, 200);
      assert.equal((await request('GET', `/tracks/${track}`)).json().preview.artist, 'Correct Artist');
      assert.equal((await request('GET', `/tracks/${track}`, undefined, users[1])).json().preview.artist, 'Artist');
      const body = event(); await request('POST', '/scrobble', body);
      await request('PUT', `/tracks/${track}`, { ...rule, blocked: true });
      assert.equal((await request('POST', '/scrobble', event())).json().reason, 'blocked');
      assert.equal((await request('POST', '/now-playing', event())).json().reason, 'blocked');
      assert.equal((await query('SELECT payload FROM lastfm_outbox WHERE event_id=$1', [body.eventId])).rows[0].payload.artist, 'Correct Artist');
      await request('DELETE', `/tracks/${track}`);
      await request('PUT', `/artists/${artist}`, { blocked: true });
      assert.equal((await request('POST', '/scrobble', event())).json().reason, 'blocked');
      await request('PUT', `/artists/${artist}`, { blocked: false });
      await request('PATCH', '/settings', { first_artist: true });
      assert.equal((await request('GET', `/tracks/${track}`)).json().preview.artist, 'First');
    });
    await t.test('two workers deliver one batch, handle partial acceptance and keep original timestamp', async () => {
      await query('DELETE FROM lastfm_outbox');
      const first = event(), second = event();
      await request('POST', '/scrobble', first); await request('POST', '/scrobble', second);
      let sends = 0;
      const send = async (method, params, session) => {
        sends++; assert.equal(session, 'session-secret'); assert.equal(params['timestamp[0]'], String(first.startedAt));
        await new Promise(resolve => setTimeout(resolve, 30));
        return { scrobbles: { scrobble: [{ ignoredMessage: { code: '0' } }, { ignoredMessage: { code: '1' } }] } };
      };
      await Promise.all([processAccount(users[0].id, send), processAccount(users[0].id, send)]);
      assert.equal(sends, 1);
      assert.deepEqual((await query('SELECT status FROM lastfm_outbox ORDER BY id')).rows.map(r => r.status), ['sent', 'ignored']);
      const body = event(); await request('POST', '/scrobble', body);
      await processAccount(users[0].id, async () => { throw new LastfmError('network', true); });
      const pending = (await query('SELECT * FROM lastfm_outbox WHERE event_id=$1', [body.eventId])).rows[0];
      assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 1); assert.equal(pending.payload.timestamp, String(body.startedAt));
      assert.ok(new Date(pending.next_attempt_at) > new Date());
      await request('POST', '/retry', {});
      await processAccount(users[0].id, async () => { throw new LastfmError(9); });
      assert.equal((await request('GET', '')).json().needsReauth, true);
    });
    await t.test('delivery bounds batches, retries malformed results atomically, and survives rollback', async () => {
      await query('DELETE FROM lastfm_outbox');
      await query('UPDATE lastfm_accounts SET needs_reauth=false WHERE user_id=$1', [users[0].id]);
      for (let i = 0; i < 51; i++) await request('POST', '/scrobble', event());
      let size = 0;
      await processAccount(users[0].id, async (method, params) => {
        size = Object.keys(params).filter(k => k.startsWith('timestamp[')).length;
        return { scrobbles: { scrobble: Array.from({ length: size }, () => ({ ignoredMessage: { code: '0' } })) } };
      });
      assert.equal(size, 50);
      assert.equal((await query("SELECT count(*)::int n FROM lastfm_outbox WHERE status='pending'")).rows[0].n, 1);
      await assert.rejects(processAccount(users[0].id, async () => { throw new Error('simulated worker crash'); }));
      assert.equal((await query("SELECT count(*)::int n FROM lastfm_outbox WHERE status='pending' AND attempts=0")).rows[0].n, 1);
      await processAccount(users[0].id, async () => ({ scrobbles: {} }));
      assert.equal((await query("SELECT status FROM lastfm_outbox ORDER BY id DESC LIMIT 1")).rows[0].status, 'pending');
      await request('POST', '/retry', {});
      await processAccount(users[0].id, async () => ({ scrobbles: { scrobble: { ignoredMessage: { code: '5' } } } }));
      assert.equal((await query("SELECT status FROM lastfm_outbox ORDER BY id DESC LIMIT 1")).rows[0].status, 'pending');
      await request('POST', '/retry', {});
      await processAccount(users[0].id, async () => { throw new LastfmError(6); });
      assert.equal((await query("SELECT status FROM lastfm_outbox ORDER BY id DESC LIMIT 1")).rows[0].status, 'failed');
      await request('POST', '/scrobble', event());
      await processAccount(users[0].id, async () => { throw new LastfmError(29, true); });
      const retry = (await query("SELECT * FROM lastfm_outbox ORDER BY id DESC LIMIT 1")).rows[0];
      assert.equal(retry.status, 'pending'); assert.ok(new Date(retry.next_attempt_at).getTime() > Date.now() + 290000);
    });
    await t.test('pause keeps queue; disconnect/reconnect prevents old account events', async () => {
      await query('UPDATE lastfm_accounts SET needs_reauth=false WHERE user_id=$1', [users[0].id]);
      await request('PATCH', '/settings', { enabled: false });
      let sent = false; await processAccount(users[0].id, async () => { sent = true; }); assert.equal(sent, false);
      assert.equal((await request('POST', '/scrobble', event())).json().reason, 'disabled');
      assert.equal((await request('GET', '/queue', undefined, users[1])).json().items.length, 0);
      const oldEvent = event();
      await request('DELETE', ''); assert.equal((await query('SELECT count(*)::int n FROM lastfm_outbox WHERE user_id=$1', [users[0].id])).rows[0].n, 0);
      connectionId = await connect(users[0]);
      assert.equal((await request('POST', '/scrobble', oldEvent)).json().reason, 'disabled');
      assert.equal((await request('POST', '/scrobble', event())).json().accepted, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (app) await app.close();
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
