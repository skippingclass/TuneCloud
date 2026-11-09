import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('web discovery lists individual participants and hides legacy composite artist cards', { skip: !databaseUrl }, async t => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const schema = 'artist_comma_' + crypto.randomBytes(8).toString('hex');
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
    await (await import('../src/routes/tracks.js')).default(app);
    const user = (await query("INSERT INTO users(username,password_hash) VALUES('artist-comma',$1) RETURNING *",
      [await auth.hashPassword('artist-comma-password')])).rows[0];
    const headers = { authorization: 'Bearer ' + auth.signToken(user) };
    const names = ['Scally Milano', 'uglystephan'];
    const credit = names.join(', ');
    const artists = (await query('INSERT INTO artists(name) SELECT unnest($1::text[]) RETURNING id,name', [[...names, credit]])).rows;
    const composite = artists.find(artist => artist.name === credit);
    const participants = artists.filter(artist => artist.id !== composite.id);
    const track = (await query("INSERT INTO tracks(file_path,file_name,title,artist_id,track_artist_credit) VALUES('/regression/feature.mp3','feature.mp3','Feature song',$1,$2) RETURNING id", [composite.id, credit])).rows[0];
    for (const artist of participants) await query("INSERT INTO track_credits(track_id,artist_id,role) VALUES($1,$2,'artist')", [track.id, artist.id]);
    for (const endpoint of ['/api/artists', ...names.map(name => '/api/artists?q=' + encodeURIComponent(name)), ...names.map(name => '/api/search?q=' + encodeURIComponent(name))]) {
      await t.test(endpoint, async () => {
        const response = await app.inject({ url: endpoint, headers });
        assert.equal(response.statusCode, 200, response.body);
        const result = response.json();
        const expected = endpoint === '/api/artists' ? participants : participants.filter(artist => endpoint.endsWith(encodeURIComponent(artist.name)));
        assert.deepEqual(result.artists.map(row => row.id).sort((a, b) => a - b), expected.map(artist => artist.id).sort((a, b) => a - b));
        assert.ok(result.artists.every(artist => Number(artist.track_count) === 1));
        if (endpoint.startsWith('/api/artists')) assert.equal(result.total, expected.length);
      });
    }
  } finally {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
