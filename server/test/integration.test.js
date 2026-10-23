import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL integration: session security, playlists, tags, scanner and pagination', { skip: !databaseUrl }, async t => {
  // Only use an explicitly supplied test DB; isolate all test tables in a temporary schema.
  const schema = `tunecloud_test_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.MUSIC_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-test-music-'));
  process.env.COVERS_DIR = path.join(process.env.MUSIC_DIR, 'covers');
  await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, initDb, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const app = Fastify();
  try {
    await initDb();
    for (const route of ['auth', 'playlists', 'tracks', 'tags', 'stream', 'subsonic', 'browse', 'scan']) {
      await (await import(`../src/routes/${route}.js`)).default(app);
    }
    await app.ready();
    const password = 'valid-test-password';
    const hash = await auth.hashPassword(password);
    async function user(name, admin = false) {
      const { rows } = await query('INSERT INTO users (username, password_hash, is_admin, subsonic_secret) VALUES ($1,$2,$3,$4) RETURNING *',
        [name, hash, admin, auth.encryptSubsonicSecret(password)]);
      return rows[0];
    }
    const owner = await user('owner');
    const other = await user('other');
    const admin = await user('administrator', true);
    const headers = u => ({ authorization: `Bearer ${auth.signToken(u)}` });
    const file = path.join(process.env.MUSIC_DIR, 'track.mp3');
    await fs.writeFile(file, Buffer.alloc(128));
    const { rows: tracks } = await query("INSERT INTO tracks (file_path,file_name,title) VALUES ($1,'track.mp3','Original'),($2,'second.mp3','Other') RETURNING *", [file, path.join(process.env.MUSIC_DIR, 'second.mp3')]);
    const [track, second] = tracks;
    const call = (method, url, u, payload) => app.inject({ method, url, headers: headers(u), payload });

    await t.test('complete server boots with upgraded plugins, metrics and readiness', async () => {
      const { buildApp } = await import('../src/index.js');
      const full = await buildApp();
      try {
        assert.equal((await full.inject('/api/ready')).statusCode, 200);
        assert.equal((await full.inject('/metrics')).statusCode, 200);
        assert.equal((await full.inject('/api/tracks/invalid')).statusCode, 400);
      } finally { await full.close(); }
    });

    await t.test('user list contains no reversible credentials; same password works in web and Subsonic', async () => {
      const list = await call('GET', '/api/auth/users', admin);
      assert.equal(list.statusCode, 200);
      for (const u of list.json()) {
        assert.equal('password' in u, false);
        assert.equal('password_hash' in u, false);
        assert.equal('subsonic_secret' in u, false);
      }
      const sub = await app.inject({ url: `/rest/ping?u=owner&p=${password}&f=json` });
      assert.equal(sub.json()['subsonic-response'].status, 'ok');
      const salt = 'test-salt';
      const token = crypto.createHash('md5').update(password + salt).digest('hex');
      const salted = await app.inject({ url: `/rest/ping?u=owner&t=${token}&s=${salt}&f=json` });
      assert.equal(salted.json()['subsonic-response'].status, 'ok');
    });

    await t.test('missing Subsonic encryption can be repaired without locking out web login', async () => {
      const recovering = await user('recovering');
      await query('UPDATE users SET subsonic_secret = NULL WHERE id = $1', [recovering.id]);
      for (let i = 0; i < 11; i++) {
        const response = await app.inject('/rest/ping?u=recovering&t=invalid&s=salt&f=json');
        assert.equal(response.json()['subsonic-response'].error.code, 0);
      }
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'recovering', password } });
      assert.equal(login.statusCode, 200);
      const secret = (await query('SELECT subsonic_secret FROM users WHERE id = $1', [recovering.id])).rows[0].subsonic_secret;
      assert.equal(auth.decryptSubsonicSecret(secret), password);
    });

    await t.test('stream cookie is HttpOnly, has a dedicated scope, and cannot authenticate the regular API', async () => {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'owner', password } });
      assert.equal(login.statusCode, 200);
      const cookie = login.headers['set-cookie'];
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Path=\/api\/stream/);
      assert.match(cookie, /SameSite=Strict/);
      process.env.NODE_ENV = 'production';
      const secure = await call('GET', '/api/auth/me', owner);
      assert.match(secure.headers['set-cookie'], /; Secure/);
      process.env.NODE_ENV = 'test';
      const pair = cookie.split(';')[0];
      const stream = await app.inject({ url: `/api/stream/${track.id}`, headers: { cookie: pair, range: 'bytes=0-15' } });
      assert.equal(stream.statusCode, 206);
      assert.equal(stream.rawPayload.length, 16);
      const cookieJwt = pair.slice(pair.indexOf('=') + 1);
      const bad = await app.inject({ url: '/api/tracks', headers: { authorization: `Bearer ${cookieJwt}` } });
      assert.equal(bad.statusCode, 401);
      const legacy = await app.inject({ url: `/api/stream/${track.id}?token=${login.json().token}` });
      assert.equal(legacy.statusCode, 401);
    });

    await t.test('revocation applies immediately after demotion, password change, deletion and logout', async () => {
      const victim = await user('victim', true);
      const stale = headers(victim);
      assert.equal((await app.inject({ url: '/api/auth/users', headers: stale })).statusCode, 200);
      assert.equal((await call('PATCH', `/api/auth/users/${victim.id}/admin`, admin, { is_admin: false })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/auth/users', headers: stale })).statusCode, 401);
      const current = (await query('SELECT * FROM users WHERE id=$1', [victim.id])).rows[0];
      assert.equal((await call('GET', '/api/auth/users', current)).statusCode, 403);
      const oldPasswordToken = headers(current);
      await call('PUT', `/api/auth/users/${victim.id}/password`, admin, { password: 'replacement-password' });
      assert.equal((await app.inject({ url: '/api/tracks', headers: oldPasswordToken })).statusCode, 401);
      const deletedToken = headers((await query('SELECT * FROM users WHERE id=$1', [victim.id])).rows[0]);
      await call('DELETE', `/api/auth/users/${victim.id}`, admin);
      assert.equal((await app.inject({ url: '/api/tracks', headers: deletedToken })).statusCode, 401);
      const logoutUser = await user('logout-user');
      const logoutHeaders = headers(logoutUser);
      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: logoutHeaders });
      assert.equal(logout.statusCode, 200);
      assert.match(logout.headers['set-cookie'], /Max-Age=0/);
      assert.equal((await app.inject({ url: '/api/tracks', headers: logoutHeaders })).statusCode, 401);
    });

    await t.test('invalid playlist creation rolls back all inserts; private playlist rejects other users', async () => {
      const fail = await call('POST', '/api/playlists', owner, { name: 'Invalid', trackIds: [track.id, 2147483647] });
      assert.equal(fail.statusCode, 400);
      assert.equal((await query("SELECT * FROM playlists WHERE name='Invalid'")).rowCount, 0);
      const create = await call('POST', '/api/playlists', owner, { name: 'Private', trackIds: [track.id] });
      assert.equal(create.statusCode, 201);
      const id = create.json().id;
      assert.equal((await call('GET', `/api/playlists/${id}`, other)).statusCode, 404);
      assert.equal((await call('POST', `/api/playlists/${id}/tracks`, other, { trackIds: [second.id] })).statusCode, 404);
      const before = (await query('SELECT * FROM playlist_tracks WHERE playlist_id=$1', [id])).rows;
      assert.equal((await call('POST', `/api/playlists/${id}/tracks`, owner, { trackIds: [second.id, 2147483647] })).statusCode, 400);
      assert.deepEqual((await query('SELECT * FROM playlist_tracks WHERE playlist_id=$1', [id])).rows, before);
      const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', `/api/playlists/${id}/tracks`, owner, { trackId: second.id })));
      assert.ok(results.every(r => r.statusCode === 200));
      const entries = (await query('SELECT * FROM playlist_tracks WHERE playlist_id=$1 ORDER BY track_order', [id])).rows;
      assert.deepEqual(entries.map(e => e.track_order), [1,2,3,4,5,6,7,8,9]);
      const incomplete = await call('PUT', `/api/playlists/${id}/reorder`, owner, { playlistTrackIds: [entries[0].id] });
      assert.equal(incomplete.statusCode, 400);
      const ordered = await call('PUT', `/api/playlists/${id}/reorder`, owner, { playlistTrackIds: entries.map(e => e.id).reverse() });
      assert.equal(ordered.statusCode, 200);
      const sub = await app.inject({ method: 'POST', url: '/rest/updatePlaylist?f=json', payload: { u: 'owner', p: password, playlistId: id, songIndexToRemove: '0', public: 'false' } });
      assert.equal(sub.json()['subsonic-response'].status, 'ok');
      assert.equal((await query('SELECT * FROM playlist_tracks WHERE playlist_id=$1', [id])).rowCount, 8);
    });

    await t.test('failed tag writes do not update DB or source file; artist and album change use the new artist', async () => {
      process.env.TAG_EDITING_ENABLED = 'false';
      assert.equal((await call('PUT', `/api/tags/${track.id}`, admin, { title: 'Disabled' })).statusCode, 403);
      process.env.TAG_EDITING_ENABLED = 'true';
      const id3 = (await import('node-id3')).default;
      const update = id3.update;
      const original = await fs.readFile(file);
      try {
        id3.update = () => Object.assign(new Error('read-only filesystem'), { code: 'EROFS' });
        assert.equal((await call('PUT', `/api/tags/${track.id}`, admin, { title: 'Must not save' })).statusCode, 403);
        assert.equal((await query('SELECT title FROM tracks WHERE id=$1', [track.id])).rows[0].title, 'Original');
        assert.deepEqual(await fs.readFile(file), original);
      } finally { id3.update = update; }
      const edited = await call('PUT', `/api/tags/${track.id}`, admin, { artist: 'New Artist', album: 'New Album', year: 2026 });
      assert.equal(edited.statusCode, 200, edited.body);
      const result = (await query('SELECT t.artist_id, al.artist_id AS album_artist_id FROM tracks t JOIN albums al ON al.id=t.album_id WHERE t.id=$1', [track.id])).rows[0];
      assert.equal(result.artist_id, result.album_artist_id);
      assert.equal(id3.read(file).artist, 'New Artist');
      const storedMtime = (await query('SELECT mtime FROM tracks WHERE id=$1', [track.id])).rows[0].mtime;
      assert.equal(storedMtime.getTime(), (await fs.stat(file)).mtime.getTime());
      // Force a DB failure after staging; original bytes must stay intact.
      const bytes = await fs.readFile(file);
      await query(`CREATE FUNCTION reject_audit_title() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'DB failure' THEN RAISE EXCEPTION 'audit failure'; END IF; RETURN NEW; END $$`);
      await query('CREATE TRIGGER reject_audit_title BEFORE UPDATE ON tracks FOR EACH ROW EXECUTE FUNCTION reject_audit_title()');
      assert.equal((await call('PUT', `/api/tags/${track.id}`, admin, { title: 'DB failure' })).statusCode, 500);
      assert.deepEqual(await fs.readFile(file), bytes);
    });

    await t.test('directory browsing and single-file scanning cannot escape the music root through symlinks', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-test-outside-'));
      try {
        await fs.writeFile(path.join(outside, 'outside.mp3'), Buffer.alloc(128));
        await fs.symlink(outside, path.join(process.env.MUSIC_DIR, 'escape-dir'));
        await fs.symlink(path.join(outside, 'outside.mp3'), path.join(process.env.MUSIC_DIR, 'escape.mp3'));
        const browse = await call('GET', '/api/browse/dirs?dir=escape-dir', owner);
        assert.equal(browse.statusCode, 403);
        const scan = await call('POST', '/api/scan/file', admin, { filePath: path.join(process.env.MUSIC_DIR, 'escape-dir/outside.mp3') });
        assert.equal(scan.statusCode, 403);
        const { scanDirectory } = await import('../src/scanner.js');
        await scanDirectory(process.env.MUSIC_DIR);
        assert.equal((await query("SELECT id FROM tracks WHERE file_path LIKE $1", [path.join(process.env.MUSIC_DIR, 'escape') + '%'])).rowCount, 0);
        const legacy = (await query("INSERT INTO tracks(file_path,file_name) VALUES($1,'outside.mp3') RETURNING id", [path.join(process.env.MUSIC_DIR, 'escape-dir/outside.mp3')])).rows[0].id;
        assert.equal((await call('GET', `/api/stream/${legacy}`, owner)).statusCode, 403);
      } finally { await fs.rm(outside, { recursive: true, force: true }); }
    });

    await t.test('server pagination searches all matching tracks with stable ordering', async () => {
      await query("INSERT INTO tracks (file_path,file_name,title) SELECT '/test/'||n, n||'.mp3', 'Paged' FROM generate_series(1,10005) n");
      const page = await call('GET', '/api/tracks?limit=200&offset=10000&q=Paged', owner);
      assert.equal(page.statusCode, 200, page.body);
      assert.equal(page.json().total, 10005);
      assert.equal(page.json().tracks.length, 5);
      const first = await call('GET', '/api/tracks?limit=200&q=Paged', owner);
      const next = await call('GET', '/api/tracks?limit=200&offset=200&q=Paged', owner);
      assert.ok(first.json().tracks.every(t => t.id < next.json().tracks[0].id));
    });

    await t.test('empty/unavailable library does not cascade-delete playlists, favorites or history', async () => {
      await query('INSERT INTO user_starred_tracks (user_id,track_id) VALUES ($1,$2)', [owner.id, track.id]);
      await query('INSERT INTO play_history (user_id,track_id) VALUES ($1,$2)', [owner.id, track.id]);
      await query('UPDATE tracks SET cover_path=$1 WHERE id=$2', ['/api/cover/track_' + track.id + '.png', track.id]);
      const cachedCover = path.join(process.env.COVERS_DIR, `track_${track.id}.png`);
      await fs.writeFile(cachedCover, 'cached-art');
      await fs.rename(file, file + '.offline');
      const { scanDirectory } = await import('../src/scanner.js');
      await scanDirectory(process.env.MUSIC_DIR);
      const row = (await query('SELECT * FROM tracks WHERE id=$1', [track.id])).rows[0];
      assert.ok(row.missing_since);
      assert.equal(row.cover_path, '/api/cover/track_' + track.id + '.png');
      assert.equal(await fs.readFile(cachedCover, 'utf8'), 'cached-art');
      const { extractCoversForAlbum } = await import('../src/cover.js');
      await extractCoversForAlbum(row.album_id);
      assert.equal(await fs.readFile(cachedCover, 'utf8'), 'cached-art');
      assert.equal((await query('SELECT * FROM user_starred_tracks WHERE track_id=$1', [track.id])).rowCount, 1);
      assert.equal((await query('SELECT * FROM play_history WHERE track_id=$1', [track.id])).rowCount, 1);
      assert.ok((await query('SELECT * FROM playlist_tracks WHERE track_id=$1', [track.id])).rowCount > 0);
      await fs.rename(file + '.offline', file);
      await scanDirectory(process.env.MUSIC_DIR);
      assert.equal((await query('SELECT missing_since FROM tracks WHERE id=$1', [track.id])).rows[0].missing_since, null);
    });
  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
    await fs.rm(process.env.MUSIC_DIR, { recursive: true, force: true });
  }
});
