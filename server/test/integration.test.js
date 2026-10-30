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
  process.env.LRC_RED_CONTACT_EMAIL = 'operator@example.net';
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

    await t.test('lyrics API uses DB metadata, rejects unknown IDs, and blocks title traversal', async () => {
      const missing = await call('GET', '/api/lyrics?id=999999', owner);
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error, 'Track not found');

      // Create local lyrics matching track filename
      const lrcFile = path.join(process.env.MUSIC_DIR, 'track.lrc');
      await fs.writeFile(lrcFile, '[00:05.00] DB Metadata Lyrics');

      // Request with malicious title override '../etc/passwd'
      const traversal = await call('GET', `/api/lyrics?id=${track.id}&title=../../../../etc/passwd`, owner);
      assert.equal(traversal.statusCode, 200);
      assert.equal(traversal.json().source, 'local');
      assert.equal(traversal.json().lyrics, '[00:05.00] DB Metadata Lyrics');
      await fs.unlink(lrcFile);
    });

    await t.test('web lyrics prefer lrc.red, preserve its cache and fall back to LRCLIB on upstream failure', async () => {
      const originalFetch = globalThis.fetch;
      const artistId = (await query("INSERT INTO artists (name) VALUES ('Lyrics Test Artist') RETURNING id")).rows[0].id;
      const lyricsFile = path.join(process.env.MUSIC_DIR, 'lyrics-provider.mp3');
      await fs.writeFile(lyricsFile, Buffer.alloc(128));
      const lyricsId = (await query(`INSERT INTO tracks (file_path,file_name,title,artist_id,duration)
        VALUES ($1,'lyrics-provider.mp3','Lyrics Test Song',$2,120) RETURNING id`, [lyricsFile, artistId])).rows[0].id;
      const requests = [];
      const originalContact = process.env.LRC_RED_CONTACT_EMAIL;
      try {
        globalThis.fetch = async url => {
          requests.push(String(url));
          if (String(url).includes('lrc.red/search.json')) return new Response(JSON.stringify({ hits: [
            { isrc: 'USAAA2600001', title: 'Lyrics Test Song', artist: 'Lyrics Test Artist', duration: 120 },
          ] }));
          if (String(url).includes('lrc.red/s/')) return new Response('[00:01.00]<00:01.00>First <00:01.50>line\n[00:04.00]Second line');
          throw new Error('LRCLIB must not be called after lrc.red succeeds');
        };
        const first = await call('GET', `/api/lyrics?id=${lyricsId}`, owner);
        assert.equal(first.statusCode, 200);
        assert.equal(first.json().source, 'lrc.red');
        assert.equal(first.json().lyrics.includes('<00:'), false);
        assert.equal(requests.length, 2);
        const cached = await call('GET', `/api/lyrics?id=${lyricsId}`, owner);
        assert.deepEqual(cached.json(), first.json());
        assert.equal(requests.length, 2, 'cached synchronized lyrics do not refetch providers');

        await query('DELETE FROM track_lyrics WHERE track_id=$1', [lyricsId]);
        requests.length = 0;
        globalThis.fetch = async url => {
          requests.push(String(url));
          return String(url).includes('lrc.red') ? new Response('', { status: 429 }) : new Response(JSON.stringify({
            syncedLyrics: '[00:01.00]LRCLIB fallback line',
          }));
        };
        const fallback = await call('GET', `/api/lyrics?id=${lyricsId}`, owner);
        assert.equal(fallback.statusCode, 200);
        assert.equal(fallback.json().source, 'lrclib');
        assert.ok(requests[0].startsWith('https://lrc.red/'));
        assert.ok(requests[1].startsWith('https://lrclib.net/'));

        await query('DELETE FROM track_lyrics WHERE track_id=$1', [lyricsId]);
        requests.length = 0;
        delete process.env.LRC_RED_CONTACT_EMAIL;
        globalThis.fetch = async url => {
          requests.push(String(url));
          assert.ok(String(url).startsWith('https://lrclib.net/'), 'unset contact must skip lrc.red entirely');
          return new Response(JSON.stringify({ syncedLyrics: '[00:01.00]Unconfigured provider fallback' }));
        };
        const unconfigured = await call('GET', `/api/lyrics?id=${lyricsId}`, owner);
        assert.equal(unconfigured.statusCode, 200);
        assert.equal(unconfigured.json().source, 'lrclib');
        assert.equal(requests.length, 1);

        await query('DELETE FROM track_lyrics WHERE track_id=$1', [lyricsId]);
        await fs.writeFile(lyricsFile.replace('.mp3', '.lrc'), '[00:01.00]Local line');
        globalThis.fetch = async () => { throw new Error('local synchronized lyrics must win'); };
        const local = await call('GET', `/api/lyrics?id=${lyricsId}`, owner);
        assert.equal(local.json().source, 'local');
      } finally {
        globalThis.fetch = originalFetch;
        process.env.LRC_RED_CONTACT_EMAIL = originalContact;
      }
    });

    await t.test('Subsonic Form POST preserves repeating parameters, duplicate songs, and order in playlists and queue', async () => {
      // 1. Form POST createPlaylist with duplicate songId preserving order
      const createRes = await app.inject({
        method: 'POST',
        url: '/rest/createPlaylist.view',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `u=owner&p=${password}&v=1.16.1&c=test&f=json&name=FormDupes&songId=${track.id}&songId=${second.id}&songId=${track.id}`,
      });
      assert.equal(createRes.statusCode, 200);
      assert.equal(createRes.json()['subsonic-response'].status, 'ok');
      const plId = createRes.json()['subsonic-response'].playlist.id;
      const { rows: plRows } = await query('SELECT track_id, track_order FROM playlist_tracks WHERE playlist_id=$1 ORDER BY track_order', [plId]);
      assert.deepEqual(plRows.map(r => r.track_id), [track.id, second.id, track.id]);
      assert.deepEqual(plRows.map(r => r.track_order), [1, 2, 3]);

      // 2. Form POST updatePlaylist with duplicate songIdToAdd
      const updateRes = await app.inject({
        method: 'POST',
        url: '/rest/updatePlaylist.view',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `u=owner&p=${password}&v=1.16.1&c=test&f=json&playlistId=${plId}&songIdToAdd=${second.id}&songIdToAdd=${second.id}`,
      });
      assert.equal(updateRes.statusCode, 200);
      const { rows: updatedRows } = await query('SELECT track_id, track_order FROM playlist_tracks WHERE playlist_id=$1 ORDER BY track_order', [plId]);
      assert.deepEqual(updatedRows.map(r => r.track_id), [track.id, second.id, track.id, second.id, second.id]);

      // 3. Form POST savePlayQueue with duplicate track IDs preserving order
      const queueRes = await app.inject({
        method: 'POST',
        url: '/rest/savePlayQueue.view',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `u=owner&p=${password}&v=1.16.1&c=test&f=json&id=${track.id}&id=${second.id}&id=${track.id}&current=${track.id}&position=5000`,
      });
      assert.equal(queueRes.statusCode, 200);
      const queueRow = (await query('SELECT track_ids, current_track_id, position_ms FROM play_queues WHERE user_id=$1', [owner.id])).rows[0];
      assert.deepEqual(queueRow.track_ids, [track.id, second.id, track.id]);
      assert.equal(queueRow.current_track_id, track.id);
      assert.equal(queueRow.position_ms, 5000);

      // 4. GET getOpenSubsonicExtensions omits transcodeOffset
      const extRes = await app.inject({
        method: 'GET',
        url: `/rest/getOpenSubsonicExtensions?u=owner&p=${password}&v=1.16.1&c=test&f=json`,
      });
      assert.equal(extRes.statusCode, 200);
      const extensions = extRes.json()['subsonic-response'].openSubsonicExtensions;
      assert.equal(extensions.some(e => e.name === 'transcodeOffset'), false);
    });
  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
    await fs.rm(process.env.MUSIC_DIR, { recursive: true, force: true });
  }
});
