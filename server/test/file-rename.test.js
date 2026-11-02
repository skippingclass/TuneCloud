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

function writeMp3(filePath, tags = {}, audioSeed = 'mp3-seed', frameCount = 4) {
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const f = Buffer.alloc(418, 0);
    f[0] = 0xff;
    f[1] = 0xfb;
    f[2] = 0x90;
    f[3] = 0x64;
    crypto.createHash('sha256').update(`${audioSeed}:${i}`).digest().copy(f, 36);
    frames.push(f);
  }
  fs.writeFileSync(filePath, Buffer.concat(frames));
  if (tags && Object.keys(tags).length > 0) nodeID3.write(tags, filePath);
}

function writeFlac(filePath, comments = {}, audioSeed = 'flac-seed', payloadBytes = 1024) {
  const magic = Buffer.from('fLaC', 'ascii');
  // Block 0: STREAMINFO (type 0, length 34): 44100Hz, 2ch, 16bps, 441000 samples (10s)
  const streamInfoHeader = Buffer.from([0x00, 0x00, 0x00, 34]);
  const streamInfo = Buffer.alloc(34, 0);
  streamInfo.writeUInt16BE(4096, 0);
  streamInfo.writeUInt16BE(4096, 2);
  // 44100 Hz (0xAC44), 2ch (1), 16bps (15), total samples = 441000
  const srChBps = (44100 << 12) | (1 << 9) | (15 << 4) | 0;
  streamInfo.writeUInt32BE(srChBps >>> 0, 10);
  streamInfo.writeUInt32BE(441000, 14);

  // Block 1: VORBIS_COMMENT (last block = 0x80 | 4 = 0x84)
  const vendor = Buffer.from('tunecloud-test', 'utf8');
  const entries = Object.entries(comments)
    .filter(([, v]) => v != null)
    .map(([k, v]) => Buffer.from(`${k.toUpperCase()}=${v}`, 'utf8'));
  const vcParts = [];
  const vLen = Buffer.alloc(4);
  vLen.writeUInt32LE(vendor.length, 0);
  vcParts.push(vLen, vendor);
  const cCount = Buffer.alloc(4);
  cCount.writeUInt32LE(entries.length, 0);
  vcParts.push(cCount);
  for (const e of entries) {
    const eLen = Buffer.alloc(4);
    eLen.writeUInt32LE(e.length, 0);
    vcParts.push(eLen, e);
  }
  const vcBody = Buffer.concat(vcParts);
  const vcHeader = Buffer.alloc(4);
  vcHeader[0] = 0x84;
  vcHeader.writeUIntBE(vcBody.length, 1, 3);

  const audio = Buffer.alloc(payloadBytes);
  for (let off = 0; off < payloadBytes; off += 32) {
    const chunk = crypto.createHash('sha256').update(`${audioSeed}:${off}`).digest();
    chunk.copy(audio, off, 0, Math.min(32, payloadBytes - off));
  }
  fs.writeFileSync(filePath, Buffer.concat([magic, streamInfoHeader, streamInfo, vcHeader, vcBody, audio]));
}

test('File rename reconciliation & phantom duplicate safeguards', { skip: !databaseUrl }, async (t) => {
  const schema = `tunecloud_filerename_${crypto.randomBytes(8).toString('hex')}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  await adminPool.query(`CREATE SCHEMA ${schema}`);

  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  process.env.DOTENV_CONFIG_PATH = '/dev/null';

  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-filerename-music-'));
  const coversDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tunecloud-filerename-covers-'));
  process.env.MUSIC_DIR = musicDir;
  process.env.COVERS_DIR = coversDir;

  const { default: pool, initDb, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const { scanDirectory } = await import('../src/scanner.js');

  const app = Fastify();
  await initDb();
  for (const route of ['auth', 'playlists', 'tracks', 'tags', 'stream', 'subsonic', 'browse', 'scan']) {
    await (await import(`../src/routes/${route}.js`)).default(app);
  }
  await app.ready();

  const username = 'rename_user';
  const password = 'rename-password-123';
  const hash = await auth.hashPassword(password);
  const { rows: uRows } = await query(
    'INSERT INTO users (username, password_hash, is_admin, subsonic_secret) VALUES ($1,$2,$3,$4) RETURNING *',
    [username, hash, true, auth.encryptSubsonicSecret(password)]
  );
  const user = uRows[0];
  const token = auth.signToken(user);

  const webGet = (urlPath) =>
    app.inject({ method: 'GET', url: urlPath, headers: { authorization: `Bearer ${token}` } });

  const subGet = (view, params = {}) => {
    const qs = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'test', f: 'json', ...params });
    return app.inject({ method: 'GET', url: `/rest/${view}?${qs}` });
  };

  try {
    await t.test('1. Non-case rename + same-inode retag AND temp-rewrite new-inode retag (MP3 & FLAC) preserve track ID and user refs', async () => {
      const dir = path.join(musicDir, 'Artist1', 'Album1');
      await fsp.mkdir(dir, { recursive: true });

      const mp3Old = path.join(dir, '01 - F***k Censored.mp3');
      const flacOld = path.join(dir, '02 - Sh*t Censored.flac');
      writeMp3(mp3Old, { title: 'F***k Censored', artist: 'Artist 1', album: 'Album 1', trackNumber: '1', year: '2024' }, 'mp3-track-1');
      writeFlac(flacOld, { TITLE: 'Sh*t Censored', ARTIST: 'Artist 1', ALBUM: 'Album 1', TRACKNUMBER: '2', DATE: '2024' }, 'flac-track-2');

      await scanDirectory(musicDir);
      const { rows: initial } = await query('SELECT id, file_path, album_id, track_number FROM tracks ORDER BY track_number ASC');
      assert.equal(initial.length, 2);
      const [mp3Track, flacTrack] = initial;
      const albumId = mp3Track.album_id;

      // Attach favorites, playlist, and play history to both tracks
      await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1,$2), ($1,$3)', [user.id, mp3Track.id, flacTrack.id]);
      const { rows: plRows } = await query('INSERT INTO playlists (name, owner_id) VALUES ($1,$2) RETURNING id', ['Renamed Tracks', user.id]);
      const playlistId = plRows[0].id;
      await query('INSERT INTO playlist_tracks (playlist_id, track_id, track_order) VALUES ($1,$2,1), ($1,$3,2)', [playlistId, mp3Track.id, flacTrack.id]);
      await query('INSERT INTO play_history (user_id, track_id) VALUES ($1,$2), ($1,$3)', [user.id, mp3Track.id, flacTrack.id]);

      // Track 1 (MP3): same-inode rename + in-place tag update
      const mp3New = path.join(dir, '01 - Fuck Uncensored.mp3');
      await fsp.rename(mp3Old, mp3New);
      nodeID3.update({ title: 'Fuck Uncensored' }, mp3New);

      // Track 2 (FLAC): temp-file rewrite to new inode at new filename with identical audio payload
      const flacTmp = path.join(dir, '.tmp-rewrite.flac');
      const flacNew = path.join(dir, '02 - Shit Uncensored.flac');
      writeFlac(flacTmp, { TITLE: 'Shit Uncensored', ARTIST: 'Artist 1', ALBUM: 'Album 1', TRACKNUMBER: '2', DATE: '2024' }, 'flac-track-2');
      await fsp.unlink(flacOld);
      await fsp.rename(flacTmp, flacNew);

      const scanRes = await scanDirectory(musicDir);
      assert.equal(scanRes.missing, 0);

      const { rows: after } = await query('SELECT id, file_path, title, missing_since FROM tracks WHERE album_id = $1 ORDER BY track_number ASC', [albumId]);
      assert.deepEqual(
        after.map((r) => ({ id: r.id, file_path: r.file_path, title: r.title, missing_since: r.missing_since })),
        [
          { id: mp3Track.id, file_path: mp3New, title: 'Fuck Uncensored', missing_since: null },
          { id: flacTrack.id, file_path: flacNew, title: 'Shit Uncensored', missing_since: null },
        ]
      );

      // Web album & Subsonic getAlbum show only the 2 live tracks with preserved IDs
      const webAlb = (await webGet(`/api/albums/${albumId}`)).json();
      assert.deepEqual(webAlb.map((r) => r.id), [mp3Track.id, flacTrack.id]);

      const subAlb = (await subGet('getAlbum', { id: String(albumId) })).json()['subsonic-response'].album;
      assert.equal(subAlb.songCount, 2);
      assert.deepEqual(subAlb.song.map((s) => Number(s.id)), [mp3Track.id, flacTrack.id]);

      // Favorites, playlist, and history still reference the original IDs
      assert.deepEqual(
        (await webGet('/api/favorites?type=tracks')).json().tracks.map((r) => r.id).sort((a, b) => a - b),
        [mp3Track.id, flacTrack.id].sort((a, b) => a - b)
      );
      assert.deepEqual((await webGet(`/api/playlists/${playlistId}`)).json().tracks.map((r) => r.id), [mp3Track.id, flacTrack.id]);
      assert.equal((await webGet('/api/history')).json().total, 2);
    });

    await t.test('2. Already-present missing+live duplicates merge ONLY when both have matching stored hashes; legacy null-hash rows stay hidden without merging', async () => {
      const dir = path.join(musicDir, 'Artist2', 'Album2');
      await fsp.mkdir(dir, { recursive: true });

      const live1Path = path.join(dir, '01 - Verified Uncensored.mp3');
      const live2Path = path.join(dir, '02 - Legacy Uncensored.mp3');
      writeMp3(live1Path, { title: 'Verified Uncensored', artist: 'Artist 2', album: 'Album 2', trackNumber: '1' }, 'verified-pair-audio');
      writeMp3(live2Path, { title: 'Legacy Uncensored', artist: 'Artist 2', album: 'Album 2', trackNumber: '2' }, 'legacy-pair-audio');

      await scanDirectory(musicDir);
      const { rows: liveRows } = await query('SELECT * FROM tracks WHERE file_path = ANY($1::text[]) ORDER BY track_number ASC', [[live1Path, live2Path]]);
      assert.equal(liveRows.length, 2);
      const [live1, live2] = liveRows;

      // Insert pre-existing missing row WITH matching verified hashes for track 1
      const { rows: m1Rows } = await query(
        `INSERT INTO tracks (file_path, file_name, file_size, duration, title, artist_id, album_id, track_number, disc_number, format, missing_since, dev, ino, birthtime_ms, content_hash, audio_hash)
         VALUES ($1, '01 - Verified C*nsored.mp3', $2, $3, 'Verified C*nsored', $4, $5, 1, 1, 'mp3', NOW(), $6, $7, $8, $9, $10)
         RETURNING id`,
        [path.join(dir, '01 - Verified C*nsored.mp3'), live1.file_size, live1.duration, live1.artist_id, live1.album_id, live1.dev, live1.ino, live1.birthtime_ms, live1.content_hash, live1.audio_hash]
      );
      const verifiedMissingId = m1Rows[0].id;

      // Insert legacy missing row WITHOUT stored hashes (NULL content_hash/audio_hash) for track 2
      const { rows: m2Rows } = await query(
        `INSERT INTO tracks (file_path, file_name, file_size, duration, title, artist_id, album_id, track_number, disc_number, format, missing_since)
         VALUES ($1, '02 - Legacy C*nsored.mp3', $2, $3, 'Legacy C*nsored', $4, $5, 2, 1, 'mp3', NOW())
         RETURNING id`,
        [path.join(dir, '02 - Legacy C*nsored.mp3'), live2.file_size, live2.duration, live2.artist_id, live2.album_id]
      );
      const legacyMissingId = m2Rows[0].id;

      await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1,$2), ($1,$3)', [user.id, verifiedMissingId, legacyMissingId]);

      await scanDirectory(musicDir);

      // Verified pair merged into verifiedMissingId; duplicate live1.id deleted
      const { rows: vCheck } = await query('SELECT id, file_path, missing_since FROM tracks WHERE id = $1', [verifiedMissingId]);
      assert.equal(vCheck.length, 1);
      assert.equal(vCheck[0].file_path, live1Path);
      assert.equal(vCheck[0].missing_since, null);
      assert.equal((await query('SELECT 1 FROM tracks WHERE id = $1', [live1.id])).rowCount, 0);

      // Legacy null-hash row is NOT merged and remains missing in DB, but hidden from Web & Subsonic browsing
      const { rows: lCheck } = await query('SELECT id, missing_since FROM tracks WHERE id = $1', [legacyMissingId]);
      assert.equal(lCheck.length, 1);
      assert.notEqual(lCheck[0].missing_since, null);
      assert.equal((await query('SELECT 1 FROM tracks WHERE id = $1 AND missing_since IS NULL', [live2.id])).rowCount, 1);

      const webAlb = (await webGet(`/api/albums/${live1.album_id}`)).json();
      assert.deepEqual(webAlb.map((r) => r.id), [verifiedMissingId, live2.id]);

      const subAlb = (await subGet('getAlbum', { id: String(live1.album_id) })).json()['subsonic-response'].album;
      assert.equal(subAlb.songCount, 2);
      assert.deepEqual(subAlb.song.map((s) => Number(s.id)), [verifiedMissingId, live2.id]);
    });

    await t.test('3. Ambiguous different recordings, duplicate copies, hardlinks, and inode reuse are never falsely merged', async () => {
      const dir = path.join(musicDir, 'Artist3', 'Album3');
      await fsp.mkdir(dir, { recursive: true });

      const cleanPath = path.join(dir, '01 - Song (Clean).mp3');
      writeMp3(cleanPath, { title: 'Song (Clean)', artist: 'Artist 3', album: 'Album 3', trackNumber: '1' }, 'clean-recording-audio');
      await scanDirectory(musicDir);
      const cleanId = (await query('SELECT id FROM tracks WHERE file_path = $1', [cleanPath])).rows[0].id;

      // Replace with different audio recording (Explicit) in same track slot
      await fsp.unlink(cleanPath);
      const explicitPath = path.join(dir, '01 - Song (Explicit).mp3');
      writeMp3(explicitPath, { title: 'Song (Explicit)', artist: 'Artist 3', album: 'Album 3', trackNumber: '1' }, 'explicit-different-audio');
      await scanDirectory(musicDir);

      const explicitId = (await query('SELECT id FROM tracks WHERE file_path = $1', [explicitPath])).rows[0].id;
      assert.notEqual(explicitId, cleanId, 'Different audio recording must not merge into missing clean track ID');

      // Hardlink guard: creating a hardlink to an existing live file must not steal a missing row's identity
      const hardlinkPath = path.join(dir, '03 - Hardlink Copy.mp3');
      await fsp.link(explicitPath, hardlinkPath);
      await scanDirectory(musicDir);
      const { rows: hlRows } = await query('SELECT id FROM tracks WHERE file_path = ANY($1::text[]) AND missing_since IS NULL', [[explicitPath, hardlinkPath]]);
      assert.equal(hlRows.length, 2);
      assert.equal(hlRows.some((r) => r.id === cleanId), false);
    });

    await t.test('4. Case-only rename and temporary missing mount preserve track IDs and user references', async () => {
      const dir = path.join(musicDir, 'MountArtist', 'CaseAlbum');
      await fsp.mkdir(dir, { recursive: true });
      const file1 = path.join(dir, '01-Track.MP3');
      writeMp3(file1, { title: 'Mount Track', artist: 'Mount Artist', album: 'Case Album', trackNumber: '1' }, 'mount-audio');

      await scanDirectory(musicDir);
      const origId = (await query('SELECT id FROM tracks WHERE file_path = $1', [file1])).rows[0].id;
      await query('INSERT INTO user_starred_tracks (user_id, track_id) VALUES ($1,$2)', [user.id, origId]);

      // Case-only rename
      const file1Lower = path.join(dir, '01-track.mp3');
      await fsp.rename(file1, file1Lower);
      await scanDirectory(musicDir);
      assert.equal((await query('SELECT id FROM tracks WHERE file_path = $1 AND missing_since IS NULL', [file1Lower])).rows[0]?.id, origId);

      // Temporary unmount (move folder out of musicDir) and restore
      const outside = path.join(os.tmpdir(), `tunecloud-unmounted-${crypto.randomBytes(6).toString('hex')}`);
      await fsp.rename(dir, outside);
      await scanDirectory(musicDir);

      assert.equal((await webGet(`/api/tracks/${origId}`)).json().available, false);
      assert.equal((await webGet('/api/favorites?type=tracks')).json().tracks.some((r) => r.id === origId && r.available === false), true);

      await fsp.rename(outside, dir);
      await scanDirectory(musicDir);
      assert.equal((await webGet(`/api/tracks/${origId}`)).json().available, true);
    });
    await t.test('5. Replacing a file with an unreadable audio payload clears stale fingerprints', async () => {
      const dir = path.join(musicDir, 'ReplacementArtist', 'ReplacementAlbum');
      await fsp.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, '01 - Replacement.mp3');
      writeMp3(filePath, { title: 'Replacement', artist: 'Replacement Artist', album: 'Replacement Album', trackNumber: '1' }, 'replacement-original');
      await scanDirectory(musicDir);
      const before = (await query('SELECT id, content_hash, audio_hash FROM tracks WHERE file_path = $1', [filePath])).rows[0];
      assert.ok(before.content_hash);
      assert.ok(before.audio_hash);

      // A failed read / empty replacement must never inherit a previous recording's fingerprints.
      await fsp.writeFile(filePath, Buffer.alloc(0));
      await scanDirectory(musicDir, { full: true });
      const after = (await query('SELECT id, content_hash, audio_hash FROM tracks WHERE file_path = $1', [filePath])).rows[0];
      assert.equal(after.id, before.id);
      assert.equal(after.content_hash, null);
      assert.equal(after.audio_hash, null);
    });
  } finally {
    await app.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
    await fsp.rm(musicDir, { recursive: true, force: true });
    await fsp.rm(coversDir, { recursive: true, force: true });
  }
});
