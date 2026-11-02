import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

function writeDummyMp3(filePath) {
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(414).fill(0)]));
}

test('Phantom visibility: retained missing tracks are excluded from web and Subsonic browsing while DB refs remain intact', { skip: !databaseUrl }, async (t) => {
  const schema = `tunecloud_phantom_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);

  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-phantom-music-'));
  process.env.MUSIC_DIR = musicDir;
  process.env.COVERS_DIR = path.join(musicDir, 'covers');
  await fsp.mkdir(process.env.COVERS_DIR, { recursive: true });

  const { default: pool, initDb, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');

  const app = Fastify();
  await initDb();
  for (const route of ['auth', 'playlists', 'tracks', 'tags', 'stream', 'subsonic', 'browse', 'scan']) {
    await (await import(`../src/routes/${route}.js`)).default(app);
  }
  await app.ready();

  const username = 'phantom_listener';
  const password = 'phantom-test-password-123';
  const passwordHash = await auth.hashPassword(password);
  const { rows: userRows } = await query(
    'INSERT INTO users (username, password_hash, is_admin, subsonic_secret) VALUES ($1, $2, $3, $4) RETURNING *',
    [username, passwordHash, false, auth.encryptSubsonicSecret(password)]
  );
  const user = userRows[0];
  const token = auth.signToken(user);

  const webGet = (endpoint) =>
    app.inject({ method: 'GET', url: endpoint, headers: { authorization: `Bearer ${token}` } });

  const subsonicGet = (endpoint, params = {}) => {
    const qs = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'phantom-test', f: 'json', ...params });
    return app.inject({ method: 'GET', url: `/rest/${endpoint}?${qs.toString()}` });
  };

  try {
    const album1Dir = path.join(musicDir, 'SharedArtist', 'SharedAlbum');
    const album2Dir = path.join(musicDir, 'SecondArtist', 'SecondAlbum');
    await fsp.mkdir(album1Dir, { recursive: true });
    await fsp.mkdir(album2Dir, { recursive: true });

    const liveFile1 = path.join(album1Dir, '01-live.mp3');
    const missingFile1 = path.join(album1Dir, '01-phantom.mp3');
    const liveFile2 = path.join(album2Dir, '01-second.mp3');
    writeDummyMp3(liveFile1);
    writeDummyMp3(liveFile2);

    const { rows: artists } = await query(
      `INSERT INTO artists (name) VALUES ('Shared Phantom Artist'), ('Second Live Artist') RETURNING *`
    );
    const [artist1, artist2] = artists;

    const { rows: albums } = await query(
      `INSERT INTO albums (title, artist_id, year, genre, folder_path)
       VALUES ('Shared Dual Album', $1, 2024, 'Synthwave', $2),
              ('Second Live Album', $3, 2023, 'Ambient', $4)
       RETURNING *`,
      [artist1.id, album1Dir, artist2.id, album2Dir]
    );
    const [album1, album2] = albums;

    const { rows: seededTracks } = await query(
      `INSERT INTO tracks (file_path, file_name, file_size, duration, title, artist_id, album_id, track_number, disc_number, genre, year, format, missing_since)
       VALUES ($1, '01-live.mp3', 4096, 180, 'Live Track Alpha', $2, $3, 1, 1, 'Synthwave', 2024, 'mp3', NULL),
              ($4, '01-phantom.mp3', 4096, 210, 'Ghost Track Omega', $2, $3, 1, 1, 'Synthwave', 2024, 'mp3', NOW()),
              ($5, '01-second.mp3', 4096, 150, 'Live Track Beta', $6, $7, 1, 1, 'Ambient', 2023, 'mp3', NULL)
       RETURNING *`,
      [liveFile1, artist1.id, album1.id, missingFile1, liveFile2, artist2.id, album2.id]
    );
    const [liveTrack, missingTrack, secondLiveTrack] = seededTracks;

    await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1, $2), ($1, $3)', [user.id, liveTrack.id, missingTrack.id]);
    const { rows: playlistRows } = await query(
      'INSERT INTO playlists (name, owner_id, is_public) VALUES ($1, $2, false) RETURNING *',
      ['Phantom Regression Playlist', user.id]
    );
    const playlist = playlistRows[0];
    await query('INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES ($1, $2, 1), ($1, $3, 2)', [playlist.id, liveTrack.id, missingTrack.id]);
    await query('INSERT INTO play_history (user_id, track_id) VALUES ($1, $2), ($1, $3)', [user.id, liveTrack.id, missingTrack.id]);

    await t.test('1. Web album, tracks, and search endpoints exclude missing rows and report live counts', async () => {
      const albumRes = await webGet(`/api/albums/${album1.id}`);
      assert.equal(albumRes.statusCode, 200);
      assert.deepEqual(albumRes.json().map((tr) => tr.id), [liveTrack.id]);

      const tracksRes = await webGet('/api/tracks');
      assert.equal(tracksRes.statusCode, 200);
      const tracksBody = tracksRes.json();
      assert.equal(tracksBody.total, 2);
      assert.deepEqual(
        tracksBody.tracks.map((tr) => tr.id).sort((a, b) => a - b),
        [liveTrack.id, secondLiveTrack.id].sort((a, b) => a - b)
      );

      const albumFilterRes = await webGet(`/api/tracks?album_id=${album1.id}`);
      assert.equal(albumFilterRes.statusCode, 200);
      const albumFilterBody = albumFilterRes.json();
      assert.equal(albumFilterBody.total, 1);
      assert.deepEqual(albumFilterBody.tracks.map((tr) => tr.id), [liveTrack.id]);

      const searchMissingRes = await webGet('/api/search?q=Ghost%20Track%20Omega');
      assert.equal(searchMissingRes.statusCode, 200);
      assert.deepEqual(searchMissingRes.json().tracks, []);

      const searchSharedRes = await webGet('/api/search?q=Shared');
      assert.equal(searchSharedRes.statusCode, 200);
      const searchSharedBody = searchSharedRes.json();
      assert.deepEqual(searchSharedBody.tracks.map((tr) => tr.id), [liveTrack.id]);
      assert.equal(searchSharedBody.artists.length, 1);
      assert.equal(Number(searchSharedBody.artists[0].track_count), 1);
    });

    await t.test('2. Subsonic browsing, search, random, starred, and playlists hide missing songs while DB refs stay intact', async () => {
      const albumRes = await subsonicGet('getAlbum', { id: String(album1.id) });
      const subAlbum = albumRes.json()['subsonic-response'];
      assert.equal(subAlbum.status, 'ok');
      assert.equal(subAlbum.album.songCount, 1);
      assert.deepEqual((subAlbum.album.song || []).map((s) => Number(s.id)), [liveTrack.id]);

      const missingSongRes = await subsonicGet('getSong', { id: String(missingTrack.id) });
      const subMissingSong = missingSongRes.json()['subsonic-response'];
      assert.equal(subMissingSong.status, 'failed');
      assert.equal(subMissingSong.song, undefined);

      const liveSongRes = await subsonicGet('getSong', { id: String(liveTrack.id) });
      assert.equal(liveSongRes.json()['subsonic-response'].status, 'ok');
      assert.equal(Number(liveSongRes.json()['subsonic-response'].song.id), liveTrack.id);

      const searchGhostRes = await subsonicGet('search3', { query: 'Ghost Track Omega' });
      const subSearchGhost = searchGhostRes.json()['subsonic-response'];
      assert.equal(subSearchGhost.status, 'ok');
      assert.deepEqual(subSearchGhost.searchResult3.song || [], []);

      const searchSharedRes = await subsonicGet('search3', { query: 'Shared' });
      const subSearchShared = searchSharedRes.json()['subsonic-response'];
      assert.equal(subSearchShared.status, 'ok');
      assert.deepEqual((subSearchShared.searchResult3.song || []).map((s) => Number(s.id)), [liveTrack.id]);

      const randomRes = await subsonicGet('getRandomSongs', { size: '50' });
      const subRandom = randomRes.json()['subsonic-response'];
      assert.equal(subRandom.status, 'ok');
      const randomIds = (subRandom.randomSongs.song || []).map((s) => Number(s.id));
      assert.equal(randomIds.includes(missingTrack.id), false);
      assert.equal(randomIds.length, 2);

      const starredRes = await subsonicGet('getStarred2');
      const subStarred = starredRes.json()['subsonic-response'];
      assert.equal(subStarred.status, 'ok');
      assert.deepEqual((subStarred.starred2.song || []).map((s) => Number(s.id)), [liveTrack.id]);

      const playlistRes = await subsonicGet('getPlaylist', { id: String(playlist.id) });
      const subPlaylist = playlistRes.json()['subsonic-response'];
      assert.equal(subPlaylist.status, 'ok');
      assert.deepEqual((subPlaylist.playlist.entry || []).map((s) => Number(s.id)), [liveTrack.id]);

      const dbTrack = await query('SELECT id, missing_since FROM tracks WHERE id = $1', [missingTrack.id]);
      assert.equal(dbTrack.rowCount, 1);
      assert.notEqual(dbTrack.rows[0].missing_since, null);

      const dbStarred = await query('SELECT track_id FROM user_starred_tracks WHERE user_id = $1 ORDER BY track_id', [user.id]);
      assert.deepEqual(dbStarred.rows.map((r) => r.track_id), [liveTrack.id, missingTrack.id]);

      const dbPlaylist = await query('SELECT track_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY track_order', [playlist.id]);
      assert.deepEqual(dbPlaylist.rows.map((r) => r.track_id), [liveTrack.id, missingTrack.id]);

      const dbHistory = await query('SELECT track_id FROM play_history WHERE user_id = $1 ORDER BY track_id', [user.id]);
      assert.deepEqual(dbHistory.rows.map((r) => r.track_id), [liveTrack.id, missingTrack.id]);
    });
  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
    await fsp.rm(musicDir, { recursive: true, force: true });
  }
});
