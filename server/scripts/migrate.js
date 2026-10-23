import pool, { initDb } from '../src/db.js';
try { await initDb(); } finally { await pool.end(); }
