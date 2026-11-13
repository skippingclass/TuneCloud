import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { parseFile } from 'music-metadata';

const near = (actual, expected) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) < 0.01,
  `expected ${expected} seconds, got ${actual}`,
);

test('Opus scan duration and repair of unchanged zero-duration tracks', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = 'opus_duration_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-opus-duration-'));
  process.env.MUSIC_DIR = root;
  process.env.COVERS_DIR = path.join(root, 'covers');
  await fs.mkdir(process.env.COVERS_DIR);
  const { default: pool, initDb, query } = await import('../src/db.js');
  const { scanDirectory, scanSingleFile } = await import('../src/scanner.js');
  const files = ['long.opus', 'long.ogg'].map(name => path.join(root, name));
  const short = path.join(root, 'short.opus');
  const read = async file => (await query('SELECT * FROM tracks WHERE file_path=$1', [file])).rows[0];
  try {
    await initDb();
    for (const file of files) await fs.copyFile(new URL('./fixtures/tags/duration-30s.opus', import.meta.url), file);
    await fs.copyFile(new URL('./fixtures/tags/sample.opus', import.meta.url), short);
    const fixture = await parseFile(files[0], { skipCovers: true, duration: true });
    near(fixture.format.duration, 30);
    assert.equal(fixture.format.codec, 'Opus');
    const defaultRead = await parseFile(files[0], { skipCovers: true });
    t.diagnostic(`parser duration: default=${defaultRead.format.duration}, explicit=${fixture.format.duration}`);

    await t.test('full scan stores actual duration for both Opus extensions and short files', async () => {
      const result = await scanDirectory(root, { full: true });
      assert.equal(result.errors, 0);
      assert.equal(result.processed, 3);
      for (const file of files) near((await read(file)).duration, 30);
      near((await read(short)).duration, 0.15);
    });

    await t.test('single-file rescan stores actual duration', async () => {
      assert.equal(await scanSingleFile(files[0]), true);
      near((await read(files[0])).duration, 30);
    });

    await t.test('incremental scan repairs legacy zeros without changing files, IDs or user references', async () => {
      const original = await read(files[0]);
      const bytes = await fs.readFile(files[0]);
      const stat = await fs.stat(files[0]);
      const user = (await query("INSERT INTO users(username,password_hash) VALUES('opus-duration','unused') RETURNING id")).rows[0].id;
      const playlist = (await query("INSERT INTO playlists(name,owner_id) VALUES('Keep Opus',$1) RETURNING id", [user])).rows[0].id;
      await query('INSERT INTO playlist_tracks(playlist_id,track_id,track_order) VALUES($1,$2,1)', [playlist, original.id]);
      await query('INSERT INTO user_starred_tracks(user_id,track_id) VALUES($1,$2)', [user, original.id]);
      await query('INSERT INTO play_history(user_id,track_id) VALUES($1,$2)', [user, original.id]);
      await query('UPDATE tracks SET duration=0 WHERE file_path=ANY($1::text[])', [files]);
      const result = await scanDirectory(root);
      assert.equal(result.processed, 2, 'repair both unchanged long files, skip healthy short Opus');
      for (const file of files) near((await read(file)).duration, 30);
      const repaired = await read(files[0]);
      assert.equal(repaired.id, original.id);
      assert.equal(repaired.album_id, original.album_id);
      assert.equal(repaired.artist_id, original.artist_id);
      assert.equal(repaired.mtime.getTime(), original.mtime.getTime());
      assert.equal(repaired.content_hash, original.content_hash);
      assert.deepEqual(await fs.readFile(files[0]), bytes);
      assert.equal((await fs.stat(files[0])).mtimeMs, stat.mtimeMs);
      for (const table of ['playlist_tracks', 'user_starred_tracks', 'play_history']) {
        assert.equal((await query(`SELECT track_id FROM ${table}`)).rows[0].track_id, original.id);
      }
    });

    await t.test('healthy files stay skipped by subsequent incremental scans', async () => {
      // Isolate this contract even if earlier subtests failed before the fix.
      await query('UPDATE tracks SET duration=30 WHERE file_path=ANY($1::text[])', [files]);
      const result = await scanDirectory(root);
      assert.equal(result.processed, 0);
      assert.equal(result.unchanged, 3);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await fs.rm(root, { recursive: true, force: true });
  }
});
