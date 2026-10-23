import pg from 'pg';
import 'dotenv/config';
import { runMigrations } from './migrations/runner.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
  idleTimeoutMillis: 30000,
});

export async function initDb() {
  await runMigrations(pool);
  console.log('Database migrations up to date');
}

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getClient() {
  return pool.connect();
}

export default pool;

// All statements in a transaction must use this same checked-out connection.
export async function transaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
