import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveCoverFile, sendCoverFile } from '../cover.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERS_DIR = path.resolve(process.env.COVERS_DIR || path.join(__dirname, '../../covers'));

async function serveCover(req, reply, filename) {
  const safe = path.basename(filename.split('?')[0]);
  const filepath = await resolveCoverFile(path.isAbsolute(filename) && !filename.startsWith('/api/') ? filename : path.join(COVERS_DIR, safe), { allowMusic: true });
  if (!filepath) return reply.status(404).send({ error: 'Not found' });
  return sendCoverFile(req, reply, filepath, req.query.size);
}

export default async function coverRoutes(fastify) {
  fastify.get('/api/cover/artist/:id', async (req, reply) => {
    const cached = await resolveCoverFile(path.join(COVERS_DIR, `artist_${req.params.id}.jpg`));
    if (cached) return sendCoverFile(req, reply, cached, req.query.size);
    const { query } = await import('../db.js');
    const { rows } = await query(`SELECT cover_path FROM albums al WHERE (artist_id = $1 OR EXISTS (SELECT 1 FROM track_credits c JOIN tracks member ON member.id=c.track_id WHERE c.artist_id=$1 AND member.album_id=al.id AND member.missing_since IS NULL)) AND cover_path IS NOT NULL
      AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = al.id AND t.missing_since IS NULL) ORDER BY id LIMIT 1`, [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'No cover' });
    return serveCover(req, reply, rows[0].cover_path);
  });
  fastify.get('/api/cover/album/:id', async (req, reply) => {
    const { default: db } = await import('../db.js');
    const { rows } = await db.query('SELECT cover_path FROM albums WHERE id = $1', [req.params.id]);
    if (!rows[0]?.cover_path) {
      return reply.status(404).send({ error: 'No cover' });
    }
    return serveCover(req, reply, rows[0].cover_path);
  });

  fastify.get('/api/cover/track/:id', async (req, reply) => {
    const { default: db } = await import('../db.js');
    const { rows } = await db.query(
      'SELECT COALESCE(t.cover_path, al.cover_path) as cover_path FROM tracks t LEFT JOIN albums al ON t.album_id = al.id WHERE t.id = $1',
      [req.params.id]
    );
    if (!rows[0]?.cover_path) {
      return reply.status(404).send({ error: 'No cover' });
    }
    return serveCover(req, reply, rows[0].cover_path);
  });

  fastify.get('/api/cover/:filename', async (req, reply) => {
    return serveCover(req, reply, req.params.filename);
  });
}
