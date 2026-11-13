import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { isWithinRoot, parseIntParam, escapeLike } from '../src/paths.js';
import { validateSecurityConfig, accountLoginAllowed, ipAuthAllowed, recordIpAuthFailure } from '../src/security.js';
import { writeAudioTags } from '../src/tag-writer.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('paths helpers prevent sibling traversal while enforcing root containment, int32 bounds and LIKE escaping', () => {
  assert.equal(isWithinRoot('/music', '/music/..foo'), true);
  assert.equal(isWithinRoot('/music', '/music/..foo/track.flac'), true);
  assert.equal(isWithinRoot('/music', '/music'), true);
  assert.equal(isWithinRoot('/music', '/music-other/track.flac'), false);
  assert.equal(isWithinRoot('/music', '/music/../secret/file.png'), false);
  assert.equal(isWithinRoot('', '/music/a'), false);
  assert.equal(isWithinRoot('/music', null), false);

  assert.equal(parseIntParam('1'), 1);
  assert.equal(parseIntParam('2147483647'), 2147483647);
  assert.equal(parseIntParam('2147483648'), null);
  assert.equal(parseIntParam('-1'), null);
  assert.equal(parseIntParam('bad'), null);
  assert.equal(parseIntParam('0', { allowZero: false }), null);
  assert.equal(parseIntParam('0', { allowZero: true }), 0);

  assert.equal(escapeLike('100%_\\test'), '100\\%\\_\\\\test');
});

test('security config rejects wildcard CORS_ORIGIN in production and throttles IP auth failures with TTL expiry', () => {
  assert.throws(() =>
    validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), CORS_ORIGIN: '*' })
  );
  assert.throws(() =>
    validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), CORS_ORIGIN: 'https://app.example, *' })
  );
  assert.doesNotThrow(() =>
    validateSecurityConfig({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(64), CORS_ORIGIN: 'https://app.example' })
  );

  const testIp = '198.51.100.77';
  const now = 5_000_000;
  for (let i = 0; i < 19; i++) {
    recordIpAuthFailure(testIp, now);
    assert.equal(ipAuthAllowed(testIp, now), true);
  }
  recordIpAuthFailure(testIp, now);
  assert.equal(ipAuthAllowed(testIp, now), false);
  assert.equal(ipAuthAllowed(testIp, now + 60_001), true);
  // After TTL expires, recording one failure starts a fresh bucket instead of locking immediately.
  recordIpAuthFailure(testIp, now + 60_001);
  assert.equal(ipAuthAllowed(testIp, now + 60_001), true);
});

test('audit hardening DB/HTTP end-to-end verification', { skip: !databaseUrl }, async (t) => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'audit_hardening_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.TAG_EDITING_ENABLED = 'true';
  process.env.PUBLIC_URL = 'https://music.example.test';

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-audit-'));
  const musicDir = path.join(dir, 'music');
  const coversDir = path.join(dir, 'covers');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(coversDir, { recursive: true });
  process.env.MUSIC_DIR = musicDir;
  process.env.COVERS_DIR = coversDir;

  const { default: pool, initDb, query } = await import('../src/db.js');
  const { scanDirectory } = await import('../src/scanner.js');
  const auth = await import('../src/auth.js');
  const { tryStartFullJob, endFullJob } = await import('../src/library-lock.js');
  let app;

  try {
    await initDb();
    app = await (await import('../src/index.js')).buildApp();
    app.log.level = 'silent';

    const adminPass = 'admin-hardening-pass';
    const alicePass = 'alice-hardening-pass';
    const adminUser = (
      await query(
        'INSERT INTO users(username, password_hash, is_admin, subsonic_secret) VALUES($1, $2, true, $3) RETURNING *',
        ['admin_h', await auth.hashPassword(adminPass), auth.encryptSubsonicSecret(adminPass)]
      )
    ).rows[0];
    const aliceUser = (
      await query(
        'INSERT INTO users(username, password_hash, is_admin, subsonic_secret) VALUES($1, $2, false, $3) RETURNING *',
        ['alice_h', await auth.hashPassword(alicePass), auth.encryptSubsonicSecret(alicePass)]
      )
    ).rows[0];

    const adminHeaders = { authorization: `Bearer ${auth.signToken(adminUser)}` };
    const subParams = (username, pass, extra = {}) => {
      const salt = 's123';
      const token = crypto.createHash('md5').update(pass + salt).digest('hex');
      return new URLSearchParams({ u: username, s: salt, t: token, f: 'json', c: 'AuditClient', v: '1.16.1', ...extra });
    };

    const validPng = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#224488' } }).png().toBuffer();

    await t.test('cover routes enforce extension allowlist, allow ..foo filenames, and isolate /api/cover/:filename from MUSIC_DIR', async () => {
      await fs.writeFile(path.join(coversDir, '..foo.png'), validPng);
      await fs.writeFile(path.join(coversDir, 'note.txt'), 'not an image');
      await fs.writeFile(path.join(musicDir, 'leak.png'), validPng);

      const dotdot = await app.inject('/api/cover/..foo.png');
      assert.equal(dotdot.statusCode, 200);
      assert.equal(dotdot.headers['content-type'], 'image/png');

      const txt = await app.inject('/api/cover/note.txt');
      assert.equal(txt.statusCode, 404);

      const fromMusic = await app.inject('/api/cover/leak.png');
      assert.equal(fromMusic.statusCode, 404);

      const traversal = await app.inject('/api/cover/..%2Fmusic%2Fleak.png');
      assert.equal(traversal.statusCode, 404);
    });

    let track1Id;
    let track2Id;

    await t.test('scanner handles [bracket] folders, NULL artist_id albums, cover progress accounting and column safety', async () => {
      const albumDir = path.join(musicDir, '[FLAC] Special Release');
      await fs.mkdir(albumDir, { recursive: true });
      const f1 = path.join(albumDir, '01-null-artist.flac');
      const f2 = path.join(albumDir, '02-named.flac');
      await fs.copyFile(new URL('./fixtures/tags/sample.flac', import.meta.url), f1);
      await fs.copyFile(new URL('./fixtures/tags/sample.flac', import.meta.url), f2);
      await fs.writeFile(path.join(albumDir, 'cover.png'), validPng);

      writeAudioTags(f1, 'flac', {
        title: 'Untitled Null Artist',
        album: 'Ambient [FLAC] Set',
        artist: '',
        albumArtist: '',
        genre: 'Rock & <Pop>',
        trackNumber: 1,
      });
      writeAudioTags(f2, 'flac', {
        title: 'Named Artist Song',
        album: 'Ambient [FLAC] Set',
        artist: 'Named Performer',
        albumArtist: 'Named Performer',
        genre: 'Electronic',
        trackNumber: 2,
      });

      const progressEvents = [];
      const res1 = await scanDirectory(musicDir, { onProgress: (evt) => progressEvents.push(evt) });
      assert.equal(res1.total, 2);
      assert.equal(res1.processed, 2);
      assert.equal(res1.errors, 0);

      // Cover progress updates should never yield coversExtracted > coversTotal
      for (const evt of progressEvents) {
        if (evt.phase === 'covers' && evt.coversTotal > 0) {
          assert.ok(evt.coversExtracted <= evt.coversTotal, `coversExtracted=${evt.coversExtracted} exceeded coversTotal=${evt.coversTotal}`);
        }
      }

      // Second incremental scan must succeed identically without duplicate-key errors on NULL artist_id or brackets
      const res2 = await scanDirectory(musicDir, {});
      assert.equal(res2.total, 2);
      assert.equal(res2.unchanged, 2);

      const tracksRes = await app.inject({ url: '/api/tracks', headers: adminHeaders });
      assert.equal(tracksRes.statusCode, 200);
      const tracksBody = tracksRes.json();
      assert.equal(tracksBody.tracks.length, 2);
      for (const tr of tracksBody.tracks) {
        assert.equal('file_path' in tr, false, 'file_path must never leak in public track payloads');
        assert.equal('folder_path' in tr, false);
      }

      const albumsRes = await app.inject({ url: '/api/albums', headers: adminHeaders });
      assert.equal(albumsRes.statusCode, 200);
      const albumsBody = albumsRes.json();
      for (const al of albumsBody.albums) {
        assert.equal('folder_path' in al, false, 'folder_path must never leak in public album payloads');
      }

      track1Id = tracksBody.tracks.find((t) => t.title === 'Untitled Null Artist').id;
      track2Id = tracksBody.tracks.find((t) => t.title === 'Named Artist Song').id;
      assert.ok(track1Id > 0 && track2Id > 0);
    });

    await t.test('tracks validation, read-only artists/by-name, concurrent favorite toggling and HEAD streaming', async () => {
      assert.equal((await app.inject({ url: '/api/tracks?artist_id=bad', headers: adminHeaders })).statusCode, 400);
      assert.equal((await app.inject({ url: '/api/tracks/2147483648', headers: adminHeaders })).statusCode, 400);
      assert.equal((await app.inject({ url: '/api/artists/by-name?name=NeverScannedArtist', headers: adminHeaders })).statusCode, 404);
      const inserted = await query("SELECT 1 FROM artists WHERE name = 'NeverScannedArtist'");
      assert.equal(inserted.rows.length, 0);

      // Missing track favorite must return 404 (FK violation mapped cleanly)
      assert.equal((await app.inject({ method: 'POST', url: '/api/favorites/track/999999', headers: adminHeaders })).statusCode, 404);

      // Concurrent toggles serialize cleanly via pg_advisory_xact_lock
      const [togA, togB] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/favorites/track/${track1Id}`, headers: adminHeaders }),
        app.inject({ method: 'POST', url: `/api/favorites/track/${track1Id}`, headers: adminHeaders }),
      ]);
      assert.equal(togA.statusCode, 200);
      assert.equal(togB.statusCode, 200);
      const stars = [togA.json().starred, togB.json().starred].sort();
      assert.deepEqual(stars, [false, true]);

      // HEAD /api/stream/:id returns headers cleanly with empty body
      const headRes = await app.inject({ method: 'HEAD', url: `/api/stream/${track1Id}`, headers: adminHeaders });
      assert.equal(headRes.statusCode, 200);
      assert.equal(headRes.headers['accept-ranges'], 'bytes');
      assert.equal(headRes.body, '');
    });

    await t.test('OpenSubsonic XML genre rendering, host allowlist, error codes, playlists, scrobble/nowPlaying & sandbox avatar', async () => {
      const genresXml = await app.inject('/rest/getGenres?' + subParams('admin_h', adminPass, { f: 'xml' }));
      assert.equal(genresXml.statusCode, 200);
      assert.ok(genresXml.body.includes('>Rock &amp; &lt;Pop&gt;</genre>'), genresXml.body);

      const badHostAlbum = await app.inject({
        url: '/rest/getAlbumList2?' + subParams('admin_h', adminPass, { type: 'newest' }),
        headers: { host: 'evil.attacker.example' },
      });
      assert.equal(badHostAlbum.statusCode, 200);
      assert.equal(badHostAlbum.body.includes('evil.attacker.example'), false);

      const missingCover = await app.inject('/rest/getCoverArt?' + subParams('admin_h', adminPass, { id: 'al-999999' }));
      assert.equal(missingCover.statusCode, 404);

      const missingStream = await app.inject('/rest/stream?' + subParams('admin_h', adminPass, { id: '999999' }));
      assert.equal(missingStream.statusCode, 200);
      assert.equal(missingStream.json()['subsonic-response'].error.code, 70);

      const similar = await app.inject('/rest/getSimilarSongs?' + subParams('admin_h', adminPass, { id: String(track1Id), count: '5' }));
      assert.equal(similar.statusCode, 200);
      assert.equal(similar.json()['subsonic-response'].status, 'ok');

      // createPlaylist without playlistId then replacing tracks via playlistId
      const created = await app.inject(
        '/rest/createPlaylist?' + subParams('admin_h', adminPass, { name: 'Mix 1', songId: String(track1Id) })
      );
      assert.equal(created.statusCode, 200);
      const playlistId = created.json()['subsonic-response'].playlist.id;
      const replaced = await app.inject(
        '/rest/createPlaylist?' + subParams('admin_h', adminPass, { playlistId: String(playlistId), songId: String(track2Id) })
      );
      assert.equal(replaced.statusCode, 200);
      const entries = replaced.json()['subsonic-response'].playlist.entry;
      assert.equal(entries.length, 1);
      assert.equal(String(entries[0].id), String(track2Id));

      // scrobble with submission=false updates only the submitting user's nowPlaying
      const npSet = await app.inject(
        '/rest/scrobble?' + subParams('admin_h', adminPass, { id: String(track1Id), submission: 'false' })
      );
      assert.equal(npSet.statusCode, 200);
      const aliceNp = await app.inject('/rest/getNowPlaying?' + subParams('alice_h', alicePass));
      assert.equal(aliceNp.statusCode, 200);
      assert.deepEqual(aliceNp.json()['subsonic-response'].nowPlaying?.entry || [], []);

      const avatar = await app.inject('/rest/getAvatar?' + subParams('admin_h', adminPass, { username: 'alice_h' }));
      assert.equal(avatar.statusCode, 200);
      assert.equal(avatar.headers['content-security-policy'], 'sandbox');
    });

    await t.test('scan and tag endpoints enforce mutual exclusion locks and validate IDs', async () => {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/tags/not-an-id', headers: adminHeaders, payload: { title: 'X' } })).statusCode, 400);

      assert.equal(tryStartFullJob('scan'), true);
      try {
        const tagConflict = await app.inject({
          method: 'PUT',
          url: `/api/tags/${track1Id}`,
          headers: adminHeaders,
          payload: { title: 'Blocked' },
        });
        assert.equal(tagConflict.statusCode, 409);

        const scanConflict = await app.inject({
          method: 'POST',
          url: '/api/scan?sync=true',
          headers: adminHeaders,
        });
        assert.equal(scanConflict.statusCode, 409);
      } finally {
        endFullJob('scan');
      }
    });

    await t.test('Subsonic t/s wrong credentials throttle after 10 failures while >305 valid calls remain unthrottled', async () => {
      // Burst >305 authenticated /rest/ping requests must NOT hit global web rate limit
      for (let i = 0; i < 310; i++) {
        const okRes = await app.inject('/rest/ping?' + subParams('admin_h', adminPass));
        assert.equal(okRes.statusCode, 200);
        assert.equal(okRes.json()['subsonic-response'].status, 'ok');
      }

      // 10 wrong t/s attempts lock alice_h while remaining under the 20/IP bucket
      for (let i = 0; i < 10; i++) {
        const bad = await app.inject(
          '/rest/ping?' + new URLSearchParams({ u: 'alice_h', s: 'salt', t: '0'.repeat(32), f: 'json', c: 'Audit', v: '1.16.1' })
        );
        assert.equal(bad.statusCode, 200);
        assert.equal(bad.json()['subsonic-response'].error.code, 40);
      }
      assert.equal(accountLoginAllowed('alice_h'), false);
      const locked = await app.inject('/rest/ping?' + subParams('alice_h', alicePass));
      assert.equal(locked.json()['subsonic-response'].error.code, 0);

      // Valid admin_h continues succeeding cleanly because only alice_h's account bucket tripped
      const adminOk = await app.inject('/rest/ping?' + subParams('admin_h', adminPass));
      assert.equal(adminOk.json()['subsonic-response'].status, 'ok');
    });
  } finally {
    if (app) await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('library-lock enforces exclusive full jobs vs concurrent single-track serialization', async () => {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { tryStartFullJob, endFullJob, isFullJobActive, withTrackLock } = await import('../src/library-lock.js');

  assert.equal(isFullJobActive(), false);
  assert.equal(tryStartFullJob('scan'), true);
  assert.equal(isFullJobActive(), true);
  assert.equal(tryStartFullJob('covers'), false);

  await assert.rejects(
    () => withTrackLock('42', async () => 'should-not-run'),
    (err) => err.statusCode === 409
  );

  endFullJob('scan');
  assert.equal(isFullJobActive(), false);

  const order = [];
  await Promise.all([
    withTrackLock('42', async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end-1');
    }),
    withTrackLock('42', async () => {
      order.push('start-2');
      order.push('end-2');
    }),
  ]);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});
