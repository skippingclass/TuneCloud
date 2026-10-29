import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import nodeID3 from 'node-id3';

const databaseUrl = process.env.TEST_DATABASE_URL;

function createDummyMp3(filePath, tags = {}) {
  const mp3Frame = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(414).fill(0)]);
  fs.writeFileSync(filePath, mp3Frame);
  if (tags && Object.keys(tags).length > 0) {
    nodeID3.write(tags, filePath);
  }
}

test('Case-insensitivity: path rename synchronization, album/artist dedup, and availability in search', { skip: !databaseUrl }, async (t) => {
  const schema = `tunecloud_case_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-case-music-'));
  process.env.MUSIC_DIR = musicDir;
  process.env.COVERS_DIR = path.join(musicDir, 'covers');
  await fsp.mkdir(process.env.COVERS_DIR, { recursive: true });

  const { default: pool, initDb, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const { scanDirectory } = await import('../src/scanner.js');

  const app = Fastify();
  await initDb();
  for (const route of ['auth', 'playlists', 'tracks', 'tags', 'stream', 'subsonic', 'browse', 'scan']) {
    await (await import(`../src/routes/${route}.js`)).default(app);
  }
  await app.ready();

  const password = 'test-password-123';
  const hash = await auth.hashPassword(password);
  async function createUser(name, admin = false) {
    const { rows } = await query(
      'INSERT INTO users (username, password_hash, is_admin, subsonic_secret) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, hash, admin, auth.encryptSubsonicSecret(password)]
    );
    const user = rows[0];
    const token = auth.signToken(user);
    return { ...user, token };
  }

  const user = await createUser('case_user');

  async function call(method, endpoint, body = undefined) {
    const headers = { authorization: `Bearer ${user.token}` };
    const opts = { method, url: endpoint, headers };
    if (body !== undefined) {
      opts.payload = body;
    }
    return app.inject(opts);
  }

  try {
    // -------------------------------------------------------------------------
    // 1. Renaming folder on disk with different case preserves track ID & favorites
    // -------------------------------------------------------------------------
    await t.test('1. Renaming album folder with different case does not duplicate tracks or albums', async () => {
      const oldFolder = path.join(musicDir, 'ArtistA', '(2020) IRLY');
      await fsp.mkdir(oldFolder, { recursive: true });
      const oldTrackPath = path.join(oldFolder, 'track1.mp3');

      createDummyMp3(oldTrackPath, {
        title: 'Song One',
        artist: 'Artist A',
        album: 'IRLY',
        year: 2020,
      });

      const scan1 = await scanDirectory(musicDir);
      assert.equal(scan1.processed, 1);

      const { rows: initialTracks } = await query('SELECT id, file_path, album_id FROM tracks WHERE title = $1', ['Song One']);
      assert.equal(initialTracks.length, 1);
      const originalTrackId = initialTracks[0].id;
      const originalAlbumId = initialTracks[0].album_id;

      // Favorite this track
      await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1, $2)', [user.id, originalTrackId]);

      // Rename folder on disk from (2020) IRLY to (2020) Irly
      const newFolder = path.join(musicDir, 'ArtistA', '(2020) Irly');
      await fsp.rename(oldFolder, newFolder);
      const newTrackPath = path.join(newFolder, 'track1.mp3');

      const scan2 = await scanDirectory(musicDir);
      assert.equal(scan2.missing, 0, 'No missing tracks should be recorded on case-only folder rename');

      // Check track in DB: same ID, updated path, available
      const { rows: afterTracks } = await query('SELECT id, file_path, album_id, missing_since FROM tracks WHERE id = $1', [originalTrackId]);
      assert.equal(afterTracks.length, 1);
      assert.equal(afterTracks[0].id, originalTrackId, 'Track ID must be preserved');
      assert.equal(afterTracks[0].file_path, newTrackPath, 'file_path must reflect new disk casing');
      assert.equal(afterTracks[0].missing_since, null, 'Track must remain available');

      // Exactly ONE track in total
      const { rows: totalTracks } = await query('SELECT COUNT(*) FROM tracks');
      assert.equal(parseInt(totalTracks[0].count, 10), 1, 'Total track count must be 1 (no duplicate)');

      // Favorite still valid
      const { rows: favRows } = await query('SELECT track_id FROM user_starred_tracks WHERE user_id = $1', [user.id]);
      assert.equal(favRows.length, 1);
      assert.equal(favRows[0].track_id, originalTrackId);

      // Exactly ONE album in albums table
      const { rows: albums } = await query('SELECT id, title, folder_path FROM albums WHERE artist_id = (SELECT id FROM artists WHERE name = $1)', ['Artist A']);
      assert.equal(albums.length, 1, 'Must have exactly 1 album for this artist');
      assert.equal(albums[0].id, originalAlbumId);
      assert.equal(albums[0].folder_path, newFolder);
    });

    // -------------------------------------------------------------------------
    // 2. Case-insensitive artist & album tag deduplication
    // -------------------------------------------------------------------------
    await t.test('2. Case differences in artist or album tags merge into single artist and album', async () => {
      const albFolder = path.join(musicDir, 'DedupCase', 'AlbumB');
      await fsp.mkdir(albFolder, { recursive: true });

      createDummyMp3(path.join(albFolder, 't1.mp3'), {
        title: 'Track A',
        artist: 'Sewerslvt',
        album: 'Draining Love Story',
        year: 2020,
      });

      createDummyMp3(path.join(albFolder, 't2.mp3'), {
        title: 'Track B',
        artist: 'sewerslvt', // lowercase artist
        album: 'draining love story', // lowercase album
        year: 2020,
      });

      await scanDirectory(musicDir);

      // Exactly ONE artist Sewerslvt
      const { rows: artists } = await query('SELECT id, name FROM artists WHERE LOWER(name) = $1', ['sewerslvt']);
      assert.equal(artists.length, 1, 'Should create only one artist despite case differences in tags');

      // Exactly ONE album Draining Love Story
      const { rows: albums } = await query('SELECT id, title, artist_id FROM albums WHERE LOWER(title) = $1', ['draining love story']);
      assert.equal(albums.length, 1, 'Should create only one album despite case differences in tags');

      // Both tracks linked to this single album
      const { rows: albTracks } = await query('SELECT id, album_id, artist_id FROM tracks WHERE album_id = $1', [albums[0].id]);
      assert.equal(albTracks.length, 2);
    });

    // -------------------------------------------------------------------------
    // 3. /api/search hides ghost albums with 0 available tracks
    // -------------------------------------------------------------------------
    await t.test('3. /api/search does not return albums where all tracks are missing', async () => {
      const ghostFolder = path.join(musicDir, 'GhostTest', 'GhostAlbum');
      await fsp.mkdir(ghostFolder, { recursive: true });
      const ghostTrackPath = path.join(ghostFolder, 'ghost.mp3');

      createDummyMp3(ghostTrackPath, {
        title: 'Ghost Song',
        artist: 'Ghost Artist',
        album: 'Ghost Album',
        year: 2021,
      });

      await scanDirectory(musicDir);

      // Verify search finds the album when available
      const resAvail = await call('GET', '/api/search?q=Ghost');
      assert.equal(resAvail.statusCode, 200);
      const dataAvail = resAvail.json();
      assert.equal(dataAvail.albums.length, 1);
      assert.equal(dataAvail.albums[0].title, 'Ghost Album');

      // Now remove the file from disk (file disappears / drive unmounted)
      await fsp.unlink(ghostTrackPath);
      await scanDirectory(musicDir);

      // Search again: track is returned with available: false, but ghost album is NOT returned in albums list!
      const resMissing = await call('GET', '/api/search?q=Ghost');
      assert.equal(resMissing.statusCode, 200);
      const dataMissing = resMissing.json();
      assert.equal(dataMissing.albums.length, 0, 'Album with 0 available tracks must not appear in search albums');
      assert.equal(dataMissing.tracks.length, 1);
      assert.equal(dataMissing.tracks[0].available, false);
    });
  } finally {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
    await fsp.rm(musicDir, { recursive: true, force: true });
    await app.close();
  }
});
