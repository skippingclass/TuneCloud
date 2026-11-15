import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('scan status requires authentication and reports live tracks and library job state', { skip: !databaseUrl }, async () => {
  const schema = `scan_status_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const app = Fastify();
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.toString();
    process.env.DOTENV_CONFIG_PATH = '/dev/null';
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.NODE_ENV = 'test';
    const db = await import('../src/db.js');
    pool = db.default;
    await db.initDb();
    const { signToken } = await import('../src/auth.js');
    const { tryStartFullJob, endFullJob } = await import('../src/library-lock.js');
    await (await import('../src/routes/scan.js')).default(app);
    await app.ready();
    const user = (await db.query("INSERT INTO users(username,password_hash) VALUES('status-reader','unused') RETURNING *")).rows[0];
    await db.query(`INSERT INTO tracks(file_path,file_name,missing_since)
      VALUES('/status/live.mp3','live.mp3',NULL),('/status/missing.mp3','missing.mp3',NOW())`);
    const headers = { authorization: `Bearer ${signToken(user)}` };
    const status = async () => {
      const response = await app.inject({ url: '/api/scan/status', headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };

    assert.equal((await app.inject('/api/scan/status')).statusCode, 401);
    const idle = await status();
    assert.equal(idle.isScanning, false);
    assert.equal(idle.indexedTracks, 1, 'missing tracks are excluded from indexed count');
    assert.equal(idle.totalFiles, null);
    assert.equal(idle.remaining, null);
    assert.equal(idle.lastResult, null);
    assert.equal(idle.lastScanAt, null);
    assert.equal(idle.progress.phase, 'idle');

    for (const job of ['scan', 'covers']) {
      assert.equal(tryStartFullJob(job), true);
      try {
        const active = await status();
        assert.equal(active.isScanning, true, `${job} holds the library job slot`);
        assert.equal(active.indexedTracks, 1);
      } finally {
        endFullJob(job);
      }
      assert.equal((await status()).isScanning, false, 'released jobs report idle again');
    }
  } finally {
    await app.close();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
