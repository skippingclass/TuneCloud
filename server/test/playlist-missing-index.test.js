import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('Subsonic removal indexes refer to visible playlist entries and preserve missing entries', { skip: !databaseUrl }, async () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'playlist_index_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  const { default: pool, initDb, query } = await import('../src/db.js');
  const auth = await import('../src/auth.js');
  const app = Fastify();
  try {
    await initDb();
    await (await import('../src/routes/subsonic.js')).default(app);
    const password = 'playlist-index-password';
    const user = (await query(`INSERT INTO users(username,password_hash,subsonic_secret)
      VALUES('playlist-index',$1,$2) RETURNING *`,
    [await auth.hashPassword(password), auth.encryptSubsonicSecret(password)])).rows[0];
    const credentials = {
      u: user.username, s: 'test-salt',
      t: crypto.createHash('md5').update(password + 'test-salt').digest('hex'),
      f: 'json', v: '1.16.1', c: 'regression-test',
    };
    const sub = async (endpoint, params) => {
      const response = await app.inject('/rest/' + endpoint + '?' + new URLSearchParams({ ...credentials, ...params }));
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json()['subsonic-response'];
      assert.equal(result.status, 'ok', response.body);
      return result;
    };
    const tracks = (await query(`INSERT INTO tracks(file_path,file_name,title,missing_since)
      VALUES('/regression/a.mp3','a.mp3','Missing A',NOW()),
            ('/regression/b.mp3','b.mp3','B',NULL),
            ('/regression/c.mp3','c.mp3','C',NULL) RETURNING id`)).rows;
    const [a, b, c] = tracks.map(track => track.id);
    const playlist = (await sub('createPlaylist', { name: 'Missing index', songId: [a, b, c].join(',') })).playlist;
    const visibleIds = async () => (await sub('getPlaylist', { id: playlist.id })).playlist.entry.map(track => Number(track.id));
    assert.deepEqual(await visibleIds(), [b, c], 'the client sees only B and C');
    await sub('updatePlaylist', { playlistId: playlist.id, songIndexToRemove: '1' });
    const stored = (await query('SELECT track_id FROM playlist_tracks WHERE playlist_id=$1 ORDER BY track_order,id', [playlist.id])).rows.map(row => row.track_id);
    assert.ok(stored.includes(a), 'missing A must retain its playlist reference');
    assert.deepEqual(await visibleIds(), [b], 'removing visible index 1 must remove C, not B');
    assert.deepEqual(stored, [a, b]);
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
