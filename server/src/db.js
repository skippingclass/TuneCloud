import pg from 'pg';
import 'dotenv/config';
import { runMigrations } from './migrations/runner.js';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
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
