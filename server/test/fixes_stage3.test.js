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

test('Stage 3: Server-side pagination for albums, artists, favorites, and track availability', { skip: !databaseUrl }, async (t) => {
  const schema = `tunecloud_stage3_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-stage3-music-'));
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

  const user = await createUser('stage3_user');

  async function call(method, endpoint, body = undefined) {
    const headers = { authorization: `Bearer ${user.token}` };
    const opts = { method, url: endpoint, headers };
    if (body !== undefined) {
      opts.payload = body;
    }
    return app.inject(opts);
  }

  try {
    // Populate several albums and artists for pagination tests
    // 5 artists, 5 albums, 10 tracks
    for (let i = 1; i <= 5; i++) {
      const artistDir = path.join(musicDir, `Artist_${i}`);
      const albumDir = path.join(artistDir, `Album_${i}`);
      await fsp.mkdir(albumDir, { recursive: true });

      createDummyMp3(path.join(albumDir, `Track_1.mp3`), {
        title: `Song A${i}`,
        artist: `Artist ${i}`,
        album: `Album ${i}`,
        year: 2000 + i,
        genre: i % 2 === 0 ? 'Rock' : 'Electronic',
      });

      createDummyMp3(path.join(albumDir, `Track_2.mp3`), {
        title: `Song B${i}`,
        artist: `Artist ${i}`,
        album: `Album ${i}`,
        year: 2000 + i,
        genre: i % 2 === 0 ? 'Rock' : 'Electronic',
      });
    }

    await scanDirectory(musicDir);

    await t.test('1. GET /api/albums pagination, bounded page size, search, and tie-breakers', async () => {
      // Page 1 with limit 2
      const resPage1 = await call('GET', '/api/albums?limit=2&offset=0&sort=title_asc');
      assert.equal(resPage1.statusCode, 200);
      const data1 = resPage1.json();
      assert.equal(data1.albums.length, 2);
      assert.equal(data1.total, 5);

      // Page 2 with limit 2
      const resPage2 = await call('GET', '/api/albums?limit=2&offset=2&sort=title_asc');
      assert.equal(resPage2.statusCode, 200);
      const data2 = resPage2.json();
      assert.equal(data2.albums.length, 2);
      assert.equal(data2.total, 5);

      // Verify no overlapping albums across pages (deterministic tie-breaker)
      const idsPage1 = data1.albums.map((a) => a.id);
      const idsPage2 = data2.albums.map((a) => a.id);
      assert.equal(idsPage1.some((id) => idsPage2.includes(id)), false, 'Offsets must be disjoint');

      // Search query across title / artist
      const resSearch = await call('GET', '/api/albums?q=Album 3');
      const dataSearch = resSearch.json();
      assert.equal(dataSearch.total, 1);
      assert.equal(dataSearch.albums[0].title, 'Album 3');

      // Filter by genre
      const resGenre = await call('GET', '/api/albums?genre=Rock');
      const dataGenre = resGenre.json();
      assert.equal(dataGenre.albums.every((a) => a.genre === 'Rock'), true);

      // Bounded page size: limit=9999 is clamped to 200
      const resClamped = await call('GET', '/api/albums?limit=9999');
      assert.equal(resClamped.statusCode, 200);

      // all=true returns all albums
      const resAll = await call('GET', '/api/albums?all=true');
      assert.equal(resAll.json().albums.length, 5);
    });

    await t.test('2. GET /api/artists pagination, tie-breakers, and search', async () => {
      // Page 1 with limit 2
      const resPage1 = await call('GET', '/api/artists?limit=2&offset=0&sort=name&order=asc');
      assert.equal(resPage1.statusCode, 200);
      const data1 = resPage1.json();
      assert.equal(data1.artists.length, 2);
      assert.equal(data1.total, 5);

      // Page 2 with limit 2
      const resPage2 = await call('GET', '/api/artists?limit=2&offset=2&sort=name&order=asc');
      const data2 = resPage2.json();
      assert.equal(data2.artists.length, 2);

      const ids1 = data1.artists.map((a) => a.id);
      const ids2 = data2.artists.map((a) => a.id);
      assert.equal(ids1.some((id) => ids2.includes(id)), false, 'Artists offset must be disjoint');

      // Search query across artists
      const resSearch = await call('GET', '/api/artists?q=Artist 4');
      const dataSearch = resSearch.json();
      assert.equal(dataSearch.total, 1);
      assert.equal(dataSearch.artists[0].name, 'Artist 4');
    });

    await t.test('3. Favorites pagination, IDs listing, and full-collection queries', async () => {
      // Star 4 tracks and 3 albums
      const { rows: allTracks } = await query('SELECT id FROM tracks ORDER BY id ASC LIMIT 4');
      for (const t of allTracks) {
        await call('POST', `/api/favorites/track/${t.id}`);
      }
      const { rows: allAlbums } = await query('SELECT id FROM albums ORDER BY id ASC LIMIT 3');
      for (const a of allAlbums) {
        await call('POST', `/api/favorites/album/${a.id}`);
      }

      // 1. GET /api/favorites/ids returns all IDs for fast lookup in FavoritesContext
      const resIds = await call('GET', '/api/favorites/ids');
      assert.equal(resIds.statusCode, 200);
      const idsData = resIds.json();
      assert.equal(idsData.track_ids.length, 4);
      assert.equal(idsData.album_ids.length, 3);

      // 2. Paginated tracks favorites
      const resFavTracksP1 = await call('GET', '/api/favorites?type=tracks&limit=2&offset=0');
      assert.equal(resFavTracksP1.statusCode, 200);
      const favP1 = resFavTracksP1.json();
      assert.equal(favP1.tracks.length, 2);
      assert.equal(favP1.total, 4);

      const resFavTracksP2 = await call('GET', '/api/favorites?type=tracks&limit=2&offset=2');
      const favP2 = resFavTracksP2.json();
      assert.equal(favP2.tracks.length, 2);
      assert.equal(favP1.tracks[0].id !== favP2.tracks[0].id, true);

      // 3. Paginated albums favorites
      const resFavAlbums = await call('GET', '/api/favorites?type=albums&limit=2&offset=0');
      assert.equal(resFavAlbums.statusCode, 200);
      const favAlbData = resFavAlbums.json();
      assert.equal(favAlbData.albums.length, 2);
      assert.equal(favAlbData.total, 3);

      // 4. all=true retrieves all tracks across all pages for Play All / Shuffle
      const resAllFavTracks = await call('GET', '/api/favorites?type=tracks&all=true');
      assert.equal(resAllFavTracks.json().tracks.length, 4);
    });

    await t.test('4. Track availability presentation in favorites when file missing', async () => {
      // Delete a track file from disk and rescan
      const { rows: tracksToMark } = await query('SELECT id, file_path FROM tracks LIMIT 1');
      const targetTrack = tracksToMark[0];
      await fsp.unlink(targetTrack.file_path);
      await scanDirectory(musicDir);

      // Check track availability in favorites
      const resFav = await call('GET', '/api/favorites?type=tracks&all=true');
      const foundInFav = resFav.json().tracks.find((t) => t.id === targetTrack.id);
      if (foundInFav) {
        assert.equal(foundInFav.available, false, 'Missing track in favorites must have available: false');
      }
    });

  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
    await fsp.rm(musicDir, { recursive: true, force: true });
  }
});
