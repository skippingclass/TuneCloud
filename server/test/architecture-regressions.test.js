import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import Fastify from 'fastify';
import NodeID3 from 'node-id3';
import { readEmbeddedLyrics } from '../src/lyrics.js';
import { fetchWithTimeout } from '../src/spotify.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('embedded lyrics retain text and millisecond SYLT timestamps', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-lyrics-regression-'));
  const file = path.join(dir, 'song.mp3');
  try {
    await fs.copyFile(new URL('./fixtures/tags/sample.mp3', import.meta.url), file);
    NodeID3.update({ unsynchronisedLyrics: { language: 'eng', text: 'First line\nSecond line' } }, file);
    assert.equal((await readEmbeddedLyrics(file)).lyrics, 'First line\nSecond line');
    NodeID3.update({ synchronisedLyrics: [{ language: 'eng', timeStampFormat: 2, contentType: 1,
      synchronisedText: [{ text: 'Timed first', timeStamp: 1250 }, { text: 'Timed second', timeStamp: 62050 }] }] }, file);
    const timed = await readEmbeddedLyrics(file);
    assert.equal(timed.synced, true);
    assert.equal(timed.lyrics, '[00:01.250]Timed first\n[01:02.050]Timed second');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('upstream timeout includes a body stalled after successful headers', async () => {
  let timer;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders();
    timer = setTimeout(() => res.end('{"ok":true}'), 1000);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {}, 100), error => error.name === 'AbortError');
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('library identity, tag consistency, exact artist matching, playback retries and personal Subsonic lists', { skip: !databaseUrl }, async t => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'architecture_' + crypto.randomBytes(8).toString('hex');
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString(); process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex'); process.env.TAG_EDITING_ENABLED = 'true';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-architecture-'));
  process.env.MUSIC_DIR = dir; process.env.COVERS_DIR = path.join(dir, 'covers');
  await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, query, initDb } = await import('../src/db.js');
  const { scanSingleFile, scanDirectory, extractLeadingArtist } = await import('../src/scanner.js');
  const auth = await import('../src/auth.js'); const app = Fastify();
  try {
    await initDb();
    for (const route of ['tracks', 'tags', 'subsonic']) await (await import(`../src/routes/${route}.js`)).default(app);
    const password = 'architecture-password';
    const user = (await query("INSERT INTO users(username,password_hash,is_admin,subsonic_secret) VALUES('audit',$1,true,$2) RETURNING *",
      [await auth.hashPassword(password), auth.encryptSubsonicSecret(password)])).rows[0];
    const other = (await query("INSERT INTO users(username,password_hash) VALUES('other','unused') RETURNING *")).rows[0];
    const headers = { authorization: 'Bearer ' + auth.signToken(user) };
    const call = (url, method = 'GET', payload) => app.inject({ url, method, payload, headers });
    const makeTrack = async (name, tags) => {
      const file = path.join(dir, name + '.mp3');
      await fs.copyFile(new URL('./fixtures/tags/sample.mp3', import.meta.url), file);
      NodeID3.removeTags(file); NodeID3.write(tags, file);
      assert.equal(await scanSingleFile(file), true);
      return (await query('SELECT * FROM tracks WHERE file_path=$1', [file])).rows[0];
    };
    let a, b;
    await t.test('same directory never supplies identity for an unrelated new album', async () => {
      a = await makeTrack('first', { title: 'First', artist: 'Artist', album: 'Album A', year: '2001', genre: 'Rock' });
      b = await makeTrack('second', { title: 'Second', artist: 'Artist', album: 'Album B' });
      assert.notEqual(a.album_id, b.album_id);
      assert.equal((await query('SELECT title FROM albums WHERE id=$1', [a.album_id])).rows[0].title, 'Album A');
      await scanDirectory(dir, { full: true });
      assert.equal((await query('SELECT album_id FROM tracks WHERE id=$1', [a.id])).rows[0].album_id, a.album_id);
      assert.equal((await query('SELECT album_id FROM tracks WHERE id=$1', [b.id])).rows[0].album_id, b.album_id);
    });
    await t.test('tag edit refreshes album year/genre, invalidates lyrics, and remains correct after an incremental scan', async () => {
      await query("INSERT INTO track_lyrics(track_id,synced,lyrics,source) VALUES($1,true,'Old lyrics','local')", [a.id]);
      const response = await call(`/api/tags/${a.id}`, 'PUT', { year: 2030, genre: 'New genre' });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual((await query('SELECT year,genre FROM albums WHERE id=$1', [a.album_id])).rows[0], { year: 2030, genre: 'New genre' });
      assert.equal((await query('SELECT * FROM track_lyrics WHERE track_id=$1', [a.id])).rowCount, 0);
      const scan = await scanDirectory(dir);
      assert.equal(scan.processed, 0);
      assert.equal((await query('SELECT year FROM albums WHERE id=$1', [a.album_id])).rows[0].year, 2030);
    });
    await t.test('a late lookup for old metadata cannot poison the corrected lyrics cache', async () => {
      const lrc = a.file_path.replace(/\.mp3$/, '.lrc');
      await fs.writeFile(lrc, '[00:01.00]Old local lyric');
      const first = await call(`/api/lyrics?id=${a.id}`);
      assert.equal(first.json().lyrics, '[00:01.00]Old local lyric');
      const oldKey = (await query('SELECT metadata_key FROM track_lyrics WHERE track_id=$1', [a.id])).rows[0].metadata_key;
      assert.equal((await call(`/api/tags/${a.id}`, 'PUT', { title: 'Correct title' })).statusCode, 200);
      await fs.writeFile(lrc, '[00:01.00]Correct local lyric');
      await query("INSERT INTO track_lyrics(track_id,synced,lyrics,source,metadata_key) VALUES($1,true,'Late old lookup','lrclib',$2)", [a.id,oldKey]);
      const corrected = await call(`/api/lyrics?id=${a.id}`);
      assert.equal(corrected.json().lyrics, '[00:01.00]Correct local lyric');
      assert.notEqual((await query('SELECT metadata_key FROM track_lyrics WHERE track_id=$1', [a.id])).rows[0].metadata_key, oldKey);
      await fs.unlink(lrc);
    });
    await t.test('a failure during album refresh rolls back both tags on disk and metadata in PostgreSQL', async () => {
      const before = await fs.readFile(a.file_path);
      await query(`CREATE FUNCTION reject_album_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.year = 2099 THEN RAISE EXCEPTION 'refresh rejected'; END IF; RETURN NEW; END $$`);
      await query('CREATE TRIGGER reject_album_refresh BEFORE UPDATE ON albums FOR EACH ROW EXECUTE FUNCTION reject_album_refresh()');
      try {
        const response = await call(`/api/tags/${a.id}`, 'PUT', { year: 2099 });
        assert.equal(response.statusCode, 500, response.body);
        assert.deepEqual(await fs.readFile(a.file_path), before);
        assert.equal((await query('SELECT year FROM tracks WHERE id=$1', [a.id])).rows[0].year, 2030);
        assert.equal((await query('SELECT year FROM albums WHERE id=$1', [a.album_id])).rows[0].year, 2030);
      } finally { await query('DROP TRIGGER reject_album_refresh ON albums'); }
    });
    await t.test('artist names preserve band punctuation and only whole participant credits match', async () => {
      assert.equal(extractLeadingArtist('dvsn'), 'dvsn');
      assert.equal(extractLeadingArtist('Simon & Garfunkel'), 'Simon & Garfunkel');
      assert.equal(extractLeadingArtist('AC/DC'), 'AC/DC');
      assert.equal(extractLeadingArtist('Main feat. Guest'), 'Main');
      const low = await makeTrack('low', { artist: 'Low', album: 'Low album', title: 'Low song' });
      const slow = await makeTrack('slow', { artist: 'Slowdive', album: 'Slow album', title: 'Slow song' });
      const guest = await makeTrack('guest', { artist: 'Other, Low', album: 'Guest album', title: 'Guest song' });
      const result = (await call(`/api/artists/${low.artist_id}`)).json();
      assert.deepEqual(result.tracks.map(track => track.id).sort((a,b) => a-b), [low.id, guest.id].sort((a,b) => a-b));
      assert.ok(!result.tracks.some(track => track.id === slow.id));
      const literal = await makeTrack('literal', { artist: '100%_Artist', album: 'Literal album' });
      const byName = (await call('/api/artists/by-name?name=' + encodeURIComponent('100%_Artist'))).json();
      assert.deepEqual(byName.tracks.map(track => track.id), [literal.id]);
    });
    await t.test('retrying an acknowledged or lost playback event cannot double-count it', async () => {
      const eventId = crypto.randomUUID();
      for (let i = 0; i < 2; i++) assert.equal((await call(`/api/scrobble/${a.id}`, 'POST', { eventId })).statusCode, 200);
      assert.equal((await query('SELECT * FROM play_history WHERE user_id=$1 AND track_id=$2', [user.id, a.id])).rowCount, 1);
      assert.equal((await query('SELECT play_count FROM tracks WHERE id=$1', [a.id])).rows[0].play_count, 1);
      assert.equal((await call(`/api/scrobble/${a.id}`, 'POST', { eventId: 'bad' })).statusCode, 400);
    });
    await t.test('Subsonic frequent and recent use personal listening history rather than import dates', async () => {
      await query("INSERT INTO play_history(user_id,track_id,played_at) VALUES($1,$2,'2020-01-01'),($1,$2,'2020-01-02'),($1,$3,NOW()),($4,$3,NOW()),($4,$3,NOW()),($4,$3,NOW()),($4,$3,NOW())", [user.id,a.id,b.id,other.id]);
      const sub = async type => {
        const qs = new URLSearchParams({ u: user.username, p: password, c: 'test', v: '1.16.1', f: 'json', type });
        const response = await app.inject({ url: '/rest/getAlbumList2?' + qs });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json()['subsonic-response'].status, 'ok', response.body);
        return response.json()['subsonic-response'].albumList2.album;
      };
      assert.equal((await sub('frequent'))[0].id, String(a.album_id));
      assert.equal((await sub('recent'))[0].id, String(b.album_id));
    });
  } finally {
    await app.close(); await pool.end(); await adminPool.query(`DROP SCHEMA ${schema} CASCADE`); await adminPool.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
