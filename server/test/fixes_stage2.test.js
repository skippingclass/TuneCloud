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

function createCorruptedMp3(filePath) {
  // Bad syncsafe size in ID3v2 header causes music-metadata to throw an error
  fs.writeFileSync(filePath, Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]));
}

test('Stage 2 fixes: album metadata rescan, tag clearing, availability, personal stats, transactional scrobble, and browse N+1', { skip: !databaseUrl }, async (t) => {
  const schema = `tunecloud_stage2_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-stage2-music-'));
  process.env.MUSIC_DIR = musicDir;
  process.env.COVERS_DIR = path.join(musicDir, 'covers');
  await fsp.mkdir(process.env.COVERS_DIR, { recursive: true });

  const { default: pool, initDb, query, transaction } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const { scanDirectory, refreshAlbumsMetadata } = await import('../src/scanner.js');

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
    return rows[0];
  }

  const user1 = await createUser('user_one');
  const user2 = await createUser('user_two');
  const headers = (u) => ({ authorization: `Bearer ${auth.signToken(u)}` });
  const call = (method, reqUrl, u, payload) => app.inject({ method, url: reqUrl, headers: headers(u), payload });

  try {
    // =========================================================================
    // 1. Изменение тегов существующего альбома при пересканировании
    // =========================================================================
    await t.test('album metadata updates on rescan: year, genre, artist, preserving album ID and foreign keys', async () => {
      const albumDir = path.join(musicDir, 'AlbumA');
      await fsp.mkdir(albumDir, { recursive: true });

      const track1Path = path.join(albumDir, 'track1.mp3');
      const track2Path = path.join(albumDir, 'track2.mp3');

      createDummyMp3(track1Path, {
        title: 'Song 1',
        artist: 'Original Artist',
        album: 'Album A',
        year: '2020',
        genre: 'Rock',
        trackNumber: '1',
      });
      createDummyMp3(track2Path, {
        title: 'Song 2',
        artist: 'Original Artist',
        album: 'Album A',
        year: '2020',
        genre: 'Rock',
        trackNumber: '2',
      });

      const initialScan = await scanDirectory(musicDir, { full: true });
      assert.equal(initialScan.processed, 2);

      const { rows: albBefore } = await query("SELECT * FROM albums WHERE title = 'Album A'");
      assert.equal(albBefore.length, 1);
      const originalAlbumId = albBefore[0].id;
      assert.equal(albBefore[0].year, 2020);
      assert.equal(albBefore[0].genre, 'Rock');

      // Add a favorite star and a playlist track linked to this album
      await query('INSERT INTO user_starred_albums (user_id, album_id) VALUES ($1, $2)', [user1.id, originalAlbumId]);
      const { rows: plRows } = await query('INSERT INTO playlists (name, owner_id) VALUES ($1, $2) RETURNING id', ['My Playlist', user1.id]);
      const playlistId = plRows[0].id;
      const { rows: tRows } = await query("SELECT id FROM tracks WHERE album_id = $1 ORDER BY id", [originalAlbumId]);
      await query('INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES ($1, $2, 1)', [playlistId, tRows[0].id]);

      // Now retag files on disk: year -> 2024, genre -> Synthwave, artist -> Renamed Artist
      createDummyMp3(track1Path, {
        title: 'Song 1',
        artist: 'Renamed Artist',
        album: 'Album A',
        year: '2024',
        genre: 'Synthwave',
        trackNumber: '1',
      });
      createDummyMp3(track2Path, {
        title: 'Song 2',
        artist: 'Renamed Artist',
        album: 'Album A',
        year: '2024',
        genre: 'Synthwave',
        trackNumber: '2',
      });

      // Update mtimes so incremental scan detects changes
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(track1Path, future, future);
      fs.utimesSync(track2Path, future, future);

      const rescan = await scanDirectory(musicDir, { full: false });
      assert.equal(rescan.processed, 2);

      // Verify: Album ID is preserved, user connections preserved
      const { rows: albAfter } = await query("SELECT al.*, a.name as artist_name FROM albums al LEFT JOIN artists a ON al.artist_id = a.id WHERE al.id = $1", [originalAlbumId]);
      assert.equal(albAfter.length, 1);
      assert.equal(albAfter[0].id, originalAlbumId);
      assert.equal(albAfter[0].year, 2024);
      assert.equal(albAfter[0].genre, 'Synthwave');
      assert.equal(albAfter[0].artist_name, 'Renamed Artist');

      // Starred album and playlist links still intact
      const { rows: stars } = await query('SELECT * FROM user_starred_albums WHERE user_id = $1 AND album_id = $2', [user1.id, originalAlbumId]);
      assert.equal(stars.length, 1);
      const { rows: plTracks } = await query('SELECT * FROM playlist_tracks WHERE playlist_id = $1', [playlistId]);
      assert.equal(plTracks.length, 1);
    });

    // =========================================================================
    // 2. Очистка удалённых тегов vs сохранение при ошибке парсинга
    // =========================================================================
    await t.test('tag clearing: removed tags become NULL on success, but preserved on parse error', async () => {
      const tagsDir = path.join(musicDir, 'TagsTest');
      await fsp.mkdir(tagsDir, { recursive: true });
      const trackPath = path.join(tagsDir, 'tagged.mp3');

      createDummyMp3(trackPath, {
        title: 'Tagged Track',
        artist: 'Tag Artist',
        album: 'Tags Album',
        year: '2018',
        genre: 'Jazz',
        trackNumber: '5',
      });

      await scanDirectory(musicDir, { full: false });
      const { rows: before } = await query("SELECT * FROM tracks WHERE file_path = $1", [trackPath]);
      assert.equal(before[0].year, 2018);
      assert.equal(before[0].genre, 'Jazz');
      assert.equal(before[0].parse_error, false);

      // A) Successful read with tags removed: year and genre removed
      nodeID3.removeTags(trackPath);
      // Write only title, no year or genre
      nodeID3.write({ title: 'Tagged Track' }, trackPath);
      const future = new Date(Date.now() + 10000);
      fs.utimesSync(trackPath, future, future);

      await scanDirectory(musicDir, { full: false });
      const { rows: afterCleared } = await query("SELECT * FROM tracks WHERE file_path = $1", [trackPath]);
      assert.equal(afterCleared[0].year, null, 'Deleted year must be cleared to NULL');
      assert.equal(afterCleared[0].genre, null, 'Deleted genre must be cleared to NULL');
      assert.equal(afterCleared[0].parse_error, false);

      // Restore year & genre for next test step
      nodeID3.write({ title: 'Tagged Track', year: '2019', genre: 'Blues' }, trackPath);
      const future2 = new Date(Date.now() + 15000);
      fs.utimesSync(trackPath, future2, future2);
      await scanDirectory(musicDir, { full: false });

      const { rows: restored } = await query("SELECT * FROM tracks WHERE file_path = $1", [trackPath]);
      assert.equal(restored[0].year, 2019);
      assert.equal(restored[0].genre, 'Blues');

      // B) File corrupted (parse error): metadata must be preserved
      createCorruptedMp3(trackPath);
      const future3 = new Date(Date.now() + 20000);
      fs.utimesSync(trackPath, future3, future3);

      const corruptScan = await scanDirectory(musicDir, { full: false });
      assert.equal(corruptScan.errors >= 1, true, 'Corrupt scan must report errors');

      const { rows: afterCorrupt } = await query("SELECT * FROM tracks WHERE file_path = $1", [trackPath]);
      assert.equal(afterCorrupt[0].year, 2019, 'Previous year must be preserved on parse error');
      assert.equal(afterCorrupt[0].genre, 'Blues', 'Previous genre must be preserved on parse error');
      assert.equal(afterCorrupt[0].parse_error, true, 'parse_error flag must be set to true');
    });

    // =========================================================================
    // 3. Вычисление метаданных альбома по всему составу, включая неизменившиеся треки
    // =========================================================================
    await t.test('album consensus metadata is calculated across all member tracks including unchanged ones', async () => {
      const albumDir = path.join(musicDir, 'MultiTrackAlbum');
      await fsp.mkdir(albumDir, { recursive: true });

      const t1 = path.join(albumDir, 't1.mp3');
      const t2 = path.join(albumDir, 't2.mp3');
      const t3 = path.join(albumDir, 't3.mp3');

      createDummyMp3(t1, { title: 'T1', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Metal' });
      createDummyMp3(t2, { title: 'T2', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Metal' });
      createDummyMp3(t3, { title: 'T3', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Metal' });

      await scanDirectory(musicDir, { full: false });
      const { rows: alb1 } = await query("SELECT * FROM albums WHERE title = 'Consensus Album'");
      assert.equal(alb1[0].year, 2021);
      assert.equal(alb1[0].genre, 'Metal');

      // Change ONLY t1's genre to 'Heavy Metal' in an incremental scan
      createDummyMp3(t1, { title: 'T1', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Heavy Metal' });
      const future = new Date(Date.now() + 25000);
      fs.utimesSync(t1, future, future);

      const incScan = await scanDirectory(musicDir, { full: false });
      assert.equal(incScan.processed, 1, 'Only 1 file processed in incremental scan');

      // Album genre consensus across all 3 tracks: t1 is Heavy Metal, t2 is Metal, t3 is Metal -> Metal wins!
      const { rows: alb2 } = await query("SELECT * FROM albums WHERE id = $1", [alb1[0].id]);
      assert.equal(alb2[0].genre, 'Metal', 'Consensus across all tracks should remain Metal');

      // Now change t2 and t3 to Heavy Metal as well
      createDummyMp3(t2, { title: 'T2', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Heavy Metal' });
      createDummyMp3(t3, { title: 'T3', album: 'Consensus Album', artist: 'Artist X', year: '2021', genre: 'Heavy Metal' });
      const future2 = new Date(Date.now() + 30000);
      fs.utimesSync(t2, future2, future2);
      fs.utimesSync(t3, future2, future2);

      await scanDirectory(musicDir, { full: false });
      const { rows: alb3 } = await query("SELECT * FROM albums WHERE id = $1", [alb1[0].id]);
      assert.equal(alb3[0].genre, 'Heavy Metal', 'Consensus genre updates to Heavy Metal when majority changes');
    });

    // =========================================================================
    // 4. Доступность файлов: признак available и исключение из очередей
    // =========================================================================
    await t.test('availability: missing_since marks available=false, excludes from queues, restores on return', async () => {
      const availDir = path.join(musicDir, 'AvailAlbum');
      await fsp.mkdir(availDir, { recursive: true });
      const trackPath = path.join(availDir, 'avail_track.mp3');

      createDummyMp3(trackPath, {
        title: 'Available Track',
        artist: 'Avail Artist',
        album: 'Avail Album',
        year: '2022',
        genre: 'Electronic',
      });

      await scanDirectory(musicDir, { full: false });
      const { rows: tRows } = await query("SELECT * FROM tracks WHERE file_path = $1", [trackPath]);
      const trackId = tRows[0].id;
      assert.equal(tRows[0].missing_since, null);

      // Add to favorites & play history
      await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1, $2)', [user1.id, trackId]);
      await query('INSERT INTO play_history (user_id, track_id) VALUES ($1, $2)', [user1.id, trackId]);

      // Check API returns available: true
      const getRes = await call('GET', `/api/tracks/${trackId}`, user1);
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json().available, true);

      // Check Subsonic getSong returns available: true
      const subRes = await call('GET', `/rest/getSong.view?id=${trackId}&u=user_one&p=${password}&v=1.16.1&c=test&f=json`, user1);
      assert.equal(subRes.statusCode, 200);
      assert.equal(subRes.json()['subsonic-response'].song.available, true);

      // Simulate disappearing drive / deletion of file
      await fsp.unlink(trackPath);
      const missingScan = await scanDirectory(musicDir, { full: false });
      assert.equal(missingScan.missing >= 1, true);

      // Track is marked missing_since
      const { rows: missingRow } = await query("SELECT * FROM tracks WHERE id = $1", [trackId]);
      assert.notEqual(missingRow[0].missing_since, null);

      // Web API returns available: false
      const getMissingRes = await call('GET', `/api/tracks/${trackId}`, user1);
      assert.equal(getMissingRes.statusCode, 200);
      assert.equal(getMissingRes.json().available, false);

      // Search returns available: false
      const searchRes = await call('GET', '/api/search?q=Available', user1);
      const searchedTrack = searchRes.json().tracks.find((t) => t.id === trackId);
      assert.ok(searchedTrack);
      assert.equal(searchedTrack.available, false);

      // Favorites return available: false, star is preserved
      const favRes = await call('GET', '/api/favorites', user1);
      const favTrack = favRes.json().tracks.find((t) => t.id === trackId);
      assert.ok(favTrack);
      assert.equal(favTrack.available, false);

      // Subsonic recommendation endpoints exclude missing track
      const randomSub = await call('GET', `/rest/getRandomSongs.view?size=50&u=user_one&p=${password}&v=1.16.1&c=test&f=json`, user1);
      const randomSongs = randomSub.json()['subsonic-response'].randomSongs.song || [];
      assert.equal(randomSongs.some((s) => s.id === String(trackId)), false, 'Missing track must not appear in getRandomSongs');

      const genreSub = await call('GET', `/rest/getSongsByGenre.view?genre=Electronic&u=user_one&p=${password}&v=1.16.1&c=test&f=json`, user1);
      const genreSongs = genreSub.json()['subsonic-response'].songsByGenre.song || [];
      assert.equal(genreSongs.some((s) => s.id === String(trackId)), false, 'Missing track must not appear in getSongsByGenre');

      // Streaming returns 404 for missing track
      const streamRes = await call('GET', `/api/stream/${trackId}`, user1);
      assert.equal(streamRes.statusCode, 404);

      // File returns (mount restored)
      createDummyMp3(trackPath, {
        title: 'Available Track',
        artist: 'Avail Artist',
        album: 'Avail Album',
        year: '2022',
        genre: 'Electronic',
      });

      const returnScan = await scanDirectory(musicDir, { full: false });
      assert.equal(returnScan.processed >= 1, true);

      // Verify availability restored with identical ID, star, and history
      const { rows: restoredRow } = await query("SELECT * FROM tracks WHERE id = $1", [trackId]);
      assert.equal(restoredRow.length, 1);
      assert.equal(restoredRow[0].missing_since, null);

      const getRestoredRes = await call('GET', `/api/tracks/${trackId}`, user1);
      assert.equal(getRestoredRes.json().available, true);
    });

    // =========================================================================
    // 5. Изоляция статистики двух пользователей и персональные On Repeat / Jump back in
    // =========================================================================
    await t.test('personal statistics: user history isolation on albums and tracks', async () => {
      const statsDir = path.join(musicDir, 'StatsAlbum');
      await fsp.mkdir(statsDir, { recursive: true });
      const track1Path = path.join(statsDir, 'user_track1.mp3');

      createDummyMp3(track1Path, {
        title: 'User Track 1',
        artist: 'Stats Artist',
        album: 'Stats Album',
        year: '2023',
        genre: 'Ambient',
      });

      await scanDirectory(musicDir, { full: false });
      const { rows: tRows } = await query("SELECT t.id, t.album_id FROM tracks t WHERE t.file_path = $1", [track1Path]);
      const trackId = tRows[0].id;
      const albumId = tRows[0].album_id;

      // User 1 scrobbles track 3 times via web API
      await call('POST', `/api/scrobble/${trackId}`, user1);
      await call('POST', `/api/scrobble/${trackId}`, user1);
      await call('POST', `/api/scrobble/${trackId}`, user1);

      // Check User 1 album stats
      const u1AlbumsRes = await call('GET', '/api/albums', user1);
      const u1AlbumList = u1AlbumsRes.json().albums || u1AlbumsRes.json();
      const u1Album = u1AlbumList.find((a) => a.id === albumId);
      assert.ok(u1Album);
      assert.equal(u1Album.play_count, 3, "User 1 should see their 3 scrobbles in album play_count");
      assert.notEqual(u1Album.last_played_at, null, "User 1 should see personal last_played_at");
      assert.equal(u1Album.global_play_count, 3, "Global play count tracks overall plays");

      // Check User 2 album stats: User 2 has NEVER played this album!
      const u2AlbumsRes = await call('GET', '/api/albums', user2);
      const u2AlbumList = u2AlbumsRes.json().albums || u2AlbumsRes.json();
      const u2Album = u2AlbumList.find((a) => a.id === albumId);
      assert.ok(u2Album);
      assert.equal(u2Album.play_count, 0, "User 2 album play_count must be 0 (isolated from User 1)");
      assert.equal(u2Album.last_played_at, null, "User 2 last_played_at must be null");
      assert.equal(u2Album.global_play_count, 3, "User 2 can see global popularity separately");

      // Check User 1 track listing
      const u1TracksRes = await call('GET', `/api/tracks?sort=play_count&order=desc`, user1);
      const u1Track = u1TracksRes.json().tracks.find((t) => t.id === trackId);
      assert.equal(u1Track.play_count, 3);

      // Check User 2 track listing
      const u2TracksRes = await call('GET', `/api/tracks?sort=play_count&order=desc`, user2);
      const u2Track = u2TracksRes.json().tracks.find((t) => t.id === trackId);
      assert.equal(u2Track.play_count, 0, "User 2 track play_count must be 0");
    });

    // =========================================================================
    // 6. Транзакционность скроблинга и откат при ошибке (Web API и Subsonic)
    // =========================================================================
    await t.test('scrobble transaction rollback on error', async () => {
      const { rows: countBefore } = await query("SELECT COUNT(*) FROM play_history");
      const histCountBefore = parseInt(countBefore[0].count, 10);

      // Web API: scrobble non-existent track
      const webRes = await call('POST', '/api/scrobble/999999', user1);
      assert.equal(webRes.statusCode, 404);

      // Subsonic: scrobble non-existent track
      const subRes = await call('GET', `/rest/scrobble.view?id=999999&u=user_one&p=${password}&v=1.16.1&c=test&f=json`, user1);
      assert.equal(subRes.statusCode, 200);
      assert.equal(subRes.json()['subsonic-response'].status, 'failed');
      assert.equal(subRes.json()['subsonic-response'].error.code, 70); // NOT_FOUND

      // Verify no orphan play_history rows inserted
      const { rows: countAfter } = await query("SELECT COUNT(*) FROM play_history");
      assert.equal(parseInt(countAfter[0].count, 10), histCountBefore, 'No history rows should be inserted on failed scrobble');
    });

    // =========================================================================
    // 7. Устранение N+1 запросов при просмотре папки (/api/browse/dirs)
    // =========================================================================
    await t.test('browse dirs eliminates N+1 queries and preserves format, order, and available flag', async () => {
      const browseDir = path.join(musicDir, 'BrowseNPlusOne');
      await fsp.mkdir(browseDir, { recursive: true });

      const files = ['01_intro.mp3', '02_verse.mp3', '03_chorus.mp3'];
      for (let i = 0; i < files.length; i++) {
        createDummyMp3(path.join(browseDir, files[i]), {
          title: `Song ${i + 1}`,
          artist: 'Browse Artist',
          album: 'Browse Album',
          trackNumber: String(i + 1),
        });
      }

      await scanDirectory(musicDir, { full: false });

      const browseRes = await call('GET', '/api/browse/dirs?dir=BrowseNPlusOne', user1);
      assert.equal(browseRes.statusCode, 200);
      const entries = browseRes.json();
      assert.equal(entries.length, 3);

      for (let i = 0; i < entries.length; i++) {
        assert.equal(entries[i].name, files[i]);
        assert.equal(entries[i].type, 'file');
        assert.ok(entries[i].meta);
        assert.equal(entries[i].meta.available, true);
        assert.equal(entries[i].meta.track_number, i + 1);
      }
    });

    // =========================================================================
    // 8. Альбом на границе пакетов и инкрементальный/полный rescan
    // =========================================================================
    await t.test('album spanning across batch boundaries derives consensus from all tracks', async () => {
      const splitDir = path.join(musicDir, 'SplitAlbum');
      await fsp.mkdir(splitDir, { recursive: true });

      // Create 4 tracks for an album
      for (let i = 1; i <= 4; i++) {
        createDummyMp3(path.join(splitDir, `part_${i}.mp3`), {
          title: `Part ${i}`,
          artist: i <= 3 ? 'Dominant Artist' : 'Guest Artist',
          album: 'Split Boundary Album',
          year: '2023',
          genre: 'Folk',
          trackNumber: String(i),
        });
      }

      // Initial scan
      const scan1 = await scanDirectory(musicDir, { full: false });
      assert.ok(scan1.processed >= 4);

      // Verify album is correctly formed
      const { rows: splitAlb } = await query("SELECT al.*, a.name as artist_name FROM albums al LEFT JOIN artists a ON al.artist_id = a.id WHERE al.title = 'Split Boundary Album'");
      assert.equal(splitAlb.length, 1);
      assert.equal(splitAlb[0].artist_name, 'Dominant Artist');
      assert.equal(splitAlb[0].genre, 'Folk');
      assert.equal(splitAlb[0].year, 2023);

      // Incremental scan with 0 changes: unchanged count equals total files
      const incScan = await scanDirectory(musicDir, { full: false });
      assert.equal(incScan.processed, 0);
      assert.equal(incScan.unchanged, incScan.total);

      // Full rescan: re-processes all files
      const fullScan = await scanDirectory(musicDir, { full: true });
      assert.equal(fullScan.processed, fullScan.total);
      assert.equal(fullScan.unchanged, 0);
    });

  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
    await fsp.rm(musicDir, { recursive: true, force: true }).catch(() => {});
  }
});
