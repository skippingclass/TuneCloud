import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import NodeID3 from 'node-id3';
import { readMetadata } from '../src/metadata.js';

const names = ['Scally Milano', 'uglystephan'];
const credit = names.join(', ');
const sorted = values => [...values].sort();

test('comma-separated track and album credits identify individual participants', async t => {
  for (const [label, common] of [
    ['no album artist', { artist: credit }],
    ['explicit album artist', { artist: credit, albumartist: names[0] }],
    ['participant arrays', { artists: [credit, 'Guest'], albumartists: [credit, 'Guest'] }],
  ]) {
    await t.test(label, () => {
      const metadata = readMetadata(common);
      const expected = label === 'participant arrays' ? [...names, 'Guest'] : names;
      assert.deepEqual(metadata.artists.map(artist => artist.name), expected);
      if (label === 'participant arrays') assert.deepEqual(metadata.albumArtists.map(artist => artist.name), expected);
    });
  }
});

test('import, web discovery, Subsonic and legacy rescan keep comma feature artists separate', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'comma_features_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-comma-features-'));
  process.env.MUSIC_DIR = dir;
  process.env.COVERS_DIR = path.join(dir, 'covers');
  await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, initDb, query } = await import('../src/db.js');
  const { scanSingleFile, scanDirectory } = await import('../src/scanner.js');
  const auth = await import('../src/auth.js');
  const app = Fastify();
  try {
    await initDb();
    for (const route of ['tracks', 'subsonic']) await (await import(`../src/routes/${route}.js`)).default(app);
    const password = 'comma-feature-password';
    const user = (await query(`INSERT INTO users(username,password_hash,subsonic_secret)
      VALUES('comma-features',$1,$2) RETURNING *`,
    [await auth.hashPassword(password), auth.encryptSubsonicSecret(password)])).rows[0];
    const headers = { authorization: 'Bearer ' + auth.signToken(user) };
    const get = async endpoint => {
      const response = await app.inject({ url: endpoint, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const sub = async (endpoint, params = {}) => {
      const response = await app.inject('/rest/' + endpoint + '?' + new URLSearchParams({
        u: user.username, s: 'salt', t: crypto.createHash('md5').update(password + 'salt').digest('hex'),
        f: 'json', c: 'regression-test', v: '1.16.1', ...params,
      }));
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json()['subsonic-response'];
      assert.equal(result.status, 'ok', response.body);
      return result;
    };
    const make = async (folder, albumArtist) => {
      const file = path.join(dir, folder, 'feature.mp3');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(new URL('./fixtures/tags/sample.mp3', import.meta.url), file);
      assert.equal(NodeID3.removeTags(file), true);
      assert.equal(NodeID3.write({ title: 'Shared song', artist: credit, album: 'Feature album',
        ...(albumArtist ? { performerInfo: albumArtist } : {}) }, file), true);
      return file;
    };
    const verify = async (context, trackId) => {
      await context.test('stored identities and credits', async () => {
        const row = (await query('SELECT * FROM tracks WHERE id=$1', [trackId])).rows[0];
        assert.deepEqual(row.metadata.artists.map(artist => artist.name), names);
        assert.equal(row.track_artist_credit, credit, 'display credit remains intact');
        const artists = (await query('SELECT name FROM artists ORDER BY name')).rows.map(artist => artist.name);
        assert.deepEqual(sorted(artists), sorted(names), 'no composite artist is created');
      });
      await context.test('web list, guest counts and pagination', async () => {
        const result = await get('/api/artists?limit=1&offset=0');
        const second = await get('/api/artists?limit=1&offset=1');
        assert.equal(result.total, 2);
        const artists = [...result.artists, ...second.artists];
        assert.deepEqual(sorted(artists.map(artist => artist.name)), sorted(names));
        assert.ok(artists.every(artist => Number(artist.track_count) === 1), 'both artists count the shared track once');
      });
      for (const name of names) {
        await context.test('web search and detail: ' + name, async () => {
          const filtered = await get('/api/artists?q=' + encodeURIComponent(name));
          assert.deepEqual(filtered.artists.map(artist => artist.name), [name]);
          const found = await get('/api/search?q=' + encodeURIComponent(name));
          assert.deepEqual(found.artists.map(artist => artist.name), [name]);
          const byId = await get('/api/artists/' + filtered.artists[0].id);
          const byName = await get('/api/artists/by-name?name=' + encodeURIComponent(name));
          for (const detail of [byId, byName]) {
            assert.equal(detail.artist.name, name);
            assert.deepEqual(detail.tracks.map(track => track.id), [trackId]);
          }
        });
      }
      await context.test('Subsonic artist identities', async () => {
        const song = (await sub('getSong', { id: String(trackId) })).song;
        assert.deepEqual(song.artists.map(artist => artist.name), names);
        const artists = (await sub('getArtists')).artists.index.flatMap(index => index.artist);
        assert.deepEqual(sorted(artists.map(artist => artist.name)), sorted(names));
      });
    };

    for (const albumArtist of [undefined, names[0]]) {
      await t.test(albumArtist ? 'import with ALBUMARTIST' : 'import without ALBUMARTIST', async context => {
        const file = await make(albumArtist ? 'with-album-artist' : 'without-album-artist', albumArtist);
        try {
          assert.equal(await scanSingleFile(file), true);
          const track = (await query('SELECT id FROM tracks WHERE file_path=$1', [file])).rows[0];
          await verify(context, track.id);
        } finally {
          await query('DELETE FROM tracks');
          await query('DELETE FROM albums');
          await query('DELETE FROM artists');
          await fs.rm(path.dirname(file), { recursive: true, force: true });
        }
      });
    }

    await t.test('full rescan repairs legacy identity and retains track references', async context => {
      const file = await make('legacy');
      const artist = (await query('INSERT INTO artists(name) VALUES($1) RETURNING id', [credit])).rows[0].id;
      const album = (await query(`INSERT INTO albums(title,artist_id,folder_path,release_key)
        VALUES('Feature album',$1,$2,$3) RETURNING id`, [artist, path.dirname(file), 'folder:' + path.dirname(file)])).rows[0].id;
      const metadata = { artists: [{ id: String(artist), name: credit }], albumArtists: [], composers: [], genres: [] };
      const track = (await query(`INSERT INTO tracks(file_path,file_name,title,artist_id,album_id,track_artist_credit,metadata)
        VALUES($1,'feature.mp3','Shared song',$2,$3,$4,$5) RETURNING id`, [file, artist, album, credit, metadata])).rows[0].id;
      await query("INSERT INTO track_credits(track_id,artist_id,role,credited_as) VALUES($1,$2,'artist',$3)", [track, artist, credit]);
      const playlist = (await query("INSERT INTO playlists(name,owner_id) VALUES('Keep feature',$1) RETURNING id", [user.id])).rows[0].id;
      await query('INSERT INTO playlist_tracks(playlist_id,track_id,track_order) VALUES($1,$2,1)', [playlist, track]);
      await query('INSERT INTO user_starred_tracks(user_id,track_id) VALUES($1,$2)', [user.id, track]);
      await query('INSERT INTO play_history(user_id,track_id) VALUES($1,$2)', [user.id, track]);
      const bytes = await fs.readFile(file);
      await scanDirectory(dir, { full: true });
      assert.equal((await query('SELECT id FROM tracks WHERE file_path=$1', [file])).rows[0].id, track);
      assert.equal((await query('SELECT track_id FROM playlist_tracks WHERE playlist_id=$1', [playlist])).rows[0].track_id, track);
      assert.equal((await query('SELECT track_id FROM user_starred_tracks WHERE user_id=$1', [user.id])).rows[0].track_id, track);
      assert.equal((await query('SELECT track_id FROM play_history WHERE user_id=$1', [user.id])).rows[0].track_id, track);
      assert.deepEqual(await fs.readFile(file), bytes, 'rescan must not rewrite audio tags');
      await verify(context, track);
    });
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
