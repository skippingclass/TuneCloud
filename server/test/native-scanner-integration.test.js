import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const binary = process.env.RUST_SCANNER_BIN || fileURLToPath(new URL('../native/scanner/target/release/tunecloud-scanner', import.meta.url));
const nativeRequired = process.env.SCANNER_ENGINE === 'rust';

test('switching scanner engines preserves track identity and incomplete native walks never mark tracks missing', {
  skip: !databaseUrl || (!nativeRequired && !existsSync(binary)),
}, async () => {
  const schema = `native_scanner_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tunecloud-native-integration-'));
  const previous = Object.fromEntries(['DATABASE_URL', 'DOTENV_CONFIG_PATH', 'MUSIC_DIR', 'COVERS_DIR', 'SCANNER_ENGINE', 'RUST_SCANNER_BIN'].map(key => [key, process.env[key]]));
  let pool;
  let closeNativeScanner;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.DOTENV_CONFIG_PATH = '/dev/null';
    process.env.MUSIC_DIR = path.join(dir, 'music [FLAC]');
    process.env.COVERS_DIR = path.join(dir, 'covers');
    process.env.RUST_SCANNER_BIN = binary;
    process.env.SCANNER_ENGINE = 'js';
    await fs.mkdir(process.env.MUSIC_DIR);
    ({ default: pool } = await import('../src/db.js'));
    const { initDb, query } = await import('../src/db.js');
    const { initCoversDir } = await import('../src/cover.js');
    const { scanDirectory } = await import('../src/scanner.js');
    const native = await import('../src/native-scanner.js');
    ({ closeNativeScanner } = native);
    await initDb();
    await initCoversDir();

    const original = path.join(process.env.MUSIC_DIR, 'Original.mp3');
    const renamed = path.join(process.env.MUSIC_DIR, 'Renamed.mp3');
    await fs.copyFile(new URL('./fixtures/tags/sample.mp3', import.meta.url), original);
    await scanDirectory(process.env.MUSIC_DIR);
    const readTrack = async () => {
      const { rows } = await query('SELECT id, file_path, content_hash, audio_hash, metadata, missing_since FROM tracks');
      assert.equal(rows.length, 1, 'rescans must never introduce a duplicate track');
      return rows[0];
    };
    const baseline = await readTrack();
    assert.equal(native.getNativeScanner().getInfo().engine, 'js');
    const userId = (await query("INSERT INTO users(username,password_hash) VALUES('native-test','unused') RETURNING id")).rows[0].id;
    const playlistId = (await query("INSERT INTO playlists(name,owner_id) VALUES('Native playlist',$1) RETURNING id", [userId])).rows[0].id;
    await query('INSERT INTO playlist_tracks(playlist_id,track_id,track_order) VALUES($1,$2,1)', [playlistId, baseline.id]);
    await query('INSERT INTO user_starred_tracks(user_id,track_id) VALUES($1,$2)', [userId, baseline.id]);
    await query('INSERT INTO play_history(user_id,track_id) VALUES($1,$2)', [userId, baseline.id]);
    const assertReferences = async () => {
      for (const table of ['playlist_tracks', 'user_starred_tracks', 'play_history']) {
        assert.equal((await query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE track_id=$1`, [baseline.id])).rows[0].count, 1);
      }
    };

    await closeNativeScanner();
    process.env.SCANNER_ENGINE = 'rust';
    await scanDirectory(process.env.MUSIC_DIR, { full: true });
    assert.equal(native.getNativeScanner().getInfo().engine, 'rust');
    assert.equal(native.getNativeScanner().getInfo().state, 'ready');
    assert.deepEqual(await readTrack(), baseline, 'native and JS full scans persist identical identity and metadata');
    await fs.rename(original, renamed);
    await scanDirectory(process.env.MUSIC_DIR);
    const afterRename = await readTrack();
    assert.equal(afterRename.id, baseline.id);
    assert.equal(afterRename.file_path, renamed);
    assert.equal(afterRename.audio_hash, baseline.audio_hash);
    await assertReferences();

    const parked = path.join(dir, 'parked.mp3');
    await fs.rename(renamed, parked);
    const broken = path.join(process.env.MUSIC_DIR, 'unreadable.mp3');
    await fs.symlink('does-not-exist.mp3', broken);
    await assert.rejects(scanDirectory(process.env.MUSIC_DIR), /scanner|list|walk|symbolic|symlink|file|directory/i);
    assert.equal((await readTrack()).missing_since, null, 'failed walk cannot change availability');
    await assertReferences();

    await fs.unlink(broken);
    await scanDirectory(process.env.MUSIC_DIR);
    assert.ok((await readTrack()).missing_since instanceof Date, 'a complete walk can mark a removed file missing');
    await assertReferences();
    await fs.rename(parked, renamed);
    await scanDirectory(process.env.MUSIC_DIR);
    assert.equal((await readTrack()).id, baseline.id);
    assert.equal((await readTrack()).missing_since, null);
    await closeNativeScanner();
    process.env.SCANNER_ENGINE = 'js';
    await scanDirectory(process.env.MUSIC_DIR, { full: true });
    assert.equal((await readTrack()).id, baseline.id, 'JS rollback reuses native track identities');
    await assertReferences();
  } finally {
    await closeNativeScanner?.();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
    await fs.rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
