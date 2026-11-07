import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import nodeID3 from 'node-id3';
import Fastify from 'fastify';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('incremental artwork refresh and cache invalidation', { skip: !databaseUrl }, async () => {
  const schema = `cover_rescan_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-rescan-'));
  process.env.MUSIC_DIR = root;
  process.env.COVERS_DIR = path.join(root, 'cache');
  const { default: pool, initDb, query } = await import('../src/db.js');
  const { initCoversDir, extractCoversForAlbum, coverUrl, findAlbumsWithChangedFolderCovers } = await import('../src/cover.js');
  const { scanDirectory } = await import('../src/scanner.js');
  const app = Fastify();
  try {
    await initDb();
    await initCoversDir();
    await (await import('../src/routes/cover.js')).default(app);
    await (await import('../src/routes/subsonic.js')).default(app);
    const albumDir = path.join(root, 'Album');
    const disc = path.join(albumDir, 'CD1');
    await fs.mkdir(disc, { recursive: true });
    const track = path.join(disc, '01.mp3');
    await fs.writeFile(track, Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(414).fill(0)]));
    nodeID3.write({ title: 'Song', artist: 'Artist', album: 'Album', trackNumber: '1' }, track);
    const sidecar = path.join(albumDir, 'cover.jpg');
    const readAlbum = async () => (await query("SELECT * FROM albums WHERE title = 'Album'")).rows[0];
    await fs.writeFile(sidecar, 'first artwork');
    await scanDirectory(root);
    let album = await readAlbum();
    const firstUrl = album.cover_path;
    assert.ok(firstUrl, 'shared parent artwork is found for a disc track');
    assert.equal(await fs.readFile(coverUrl(firstUrl), 'utf8'), 'first artwork');
    assert.deepEqual(await findAlbumsWithChangedFolderCovers(), []);

    await fs.writeFile(sidecar, 'second artwork');
    const replaced = await scanDirectory(root);
    assert.equal(replaced.processed, 0, 'audio metadata stays unchanged');
    album = await readAlbum();
    assert.notEqual(album.cover_path, firstUrl, 'artwork content changes its URL');
    const direct = await app.inject(album.cover_path);
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.body, 'second artwork');
    const byId = await app.inject(`/api/cover/album/${album.id}`);
    assert.equal(byId.body, 'second artwork', 'versioned DB paths resolve by album ID');
    assert.equal(byId.headers['cache-control'], 'no-cache');
    const { hashPassword, encryptSubsonicSecret } = await import('../src/auth.js');
    await query('INSERT INTO users (username, password_hash, subsonic_secret) VALUES ($1,$2,$3)',
      ['cover-test', await hashPassword('cover-password'), encryptSubsonicSecret('cover-password')]);
    const token = crypto.createHash('md5').update('cover-password' + 'salt').digest('hex');
    const subsonic = await app.inject(`/rest/getCoverArt?id=al-${album.id}&u=cover-test&t=${token}&s=salt`);
    assert.equal(subsonic.statusCode, 200);
    assert.equal(subsonic.body, 'second artwork');
    assert.equal(subsonic.headers['cache-control'], 'no-cache');
    const stable = await scanDirectory(root);
    assert.equal(stable.processed, 0);
    assert.equal(stable.covers, 0, 'unchanged artwork is not re-extracted');

    await fs.unlink(sidecar);
    await scanDirectory(root);
    assert.equal((await readAlbum()).cover_path, null, 'removed artwork clears the DB');
    assert.equal(coverUrl(album.cover_path), null, 'removed artwork clears the cache');

    const embedded = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8Z8AAAAASUVORK5CYII=', 'base64');
    nodeID3.update({ image: { mime: 'image/png', type: { id: 3 }, description: 'front', imageBuffer: embedded } }, track);
    const changedTime = new Date(Date.now() + 2000);
    await fs.utimes(track, changedTime, changedTime);
    await scanDirectory(root);
    album = await readAlbum();
    assert.deepEqual(await fs.readFile(coverUrl(album.cover_path)), embedded, 'retagged embedded artwork refreshes');
    nodeID3.write({ title: 'Song', artist: 'Artist', album: 'Album', trackNumber: '1' }, track);
    const clearedTime = new Date(Date.now() + 4000);
    await fs.utimes(track, clearedTime, clearedTime);
    await scanDirectory(root);
    assert.equal((await readAlbum()).cover_path, null, 'removed embedded artwork clears the album cover');

    await fs.writeFile(sidecar, 'added artwork');
    const added = await scanDirectory(root);
    assert.equal(added.processed, 0);
    album = await readAlbum();
    assert.equal(await fs.readFile(coverUrl(album.cover_path), 'utf8'), 'added artwork');

    // A parser failure must preserve artwork even if the sidecar disappears.
    await fs.unlink(sidecar);
    await fs.writeFile(track, Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0xff, 0xff, 0xff, 0xff]));
    await extractCoversForAlbum(album.id);
    assert.equal((await readAlbum()).cover_path, album.cover_path);
    assert.equal(await fs.readFile(coverUrl(album.cover_path), 'utf8'), 'added artwork');
    assert.deepEqual(await findAlbumsWithChangedFolderCovers(), [album.id], 'failed parsing leaves the album eligible for retry');
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});
