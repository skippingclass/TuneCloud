import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('rename migration never merges clean/explicit recordings from similar metadata alone', { skip: !databaseUrl }, async () => {
  const schema = `rename_safety_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { default: pool, initDb, query } = await import('../src/db.js');
  try {
    await initDb();
    const user = (await query("INSERT INTO users(username,password_hash) VALUES('migration-test','unused') RETURNING id")).rows[0].id;
    const artist = (await query("INSERT INTO artists(name) VALUES('Artist') RETURNING id")).rows[0].id;
    const album = (await query("INSERT INTO albums(title,artist_id) VALUES('Album',$1) RETURNING id", [artist])).rows[0].id;
    const rows = (await query(`INSERT INTO tracks(file_path,file_name,title,album_id,artist_id,track_number,disc_number,duration,file_size,format,missing_since)
      VALUES('/missing/clean.flac','F**k.flac','F**k',$1,$2,2,1,142,500000,'flac',NOW()),
            ('/live/explicit.flac','Fuck.flac','Fuck',$1,$2,2,1,142.1,500001,'flac',NULL) RETURNING id`, [album,artist])).rows;
    const ids = rows.map(row => row.id);
    const playlist = (await query("INSERT INTO playlists(name,owner_id) VALUES('Versions',$1) RETURNING id", [user])).rows[0].id;
    for (let i = 0; i < ids.length; i++) {
      await query('INSERT INTO user_starred_tracks(user_id,track_id) VALUES($1,$2)', [user,ids[i]]);
      await query('INSERT INTO playlist_tracks(playlist_id,track_id,track_order) VALUES($1,$2,$3)', [playlist,ids[i],i+1]);
      await query('INSERT INTO play_history(user_id,track_id) VALUES($1,$2)', [user,ids[i]]);
    }
    // Simulate upgrading a populated installation: these old rows have no trustworthy identity hash.
    const sql = await readFile(new URL('../src/migrations/010_track_identity_and_rename_reconciliation.sql', import.meta.url), 'utf8');
    await query(sql);
    assert.deepEqual((await query('SELECT id FROM tracks ORDER BY id')).rows.map(row => row.id), ids);
    assert.equal((await query('SELECT * FROM user_starred_tracks')).rowCount, 2);
    assert.deepEqual((await query('SELECT track_id FROM playlist_tracks ORDER BY track_order')).rows.map(row => row.track_id), ids);
    assert.equal((await query('SELECT * FROM play_history')).rowCount, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
