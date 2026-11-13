import { query } from '../db.js';
import { sendAudioFile } from '../streaming.js';
import { requireStreamAuth } from '../auth.js';

export default async function streamRoutes(fastify) {
  fastify.get('/api/stream/:id', { preHandler: requireStreamAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[1-9]\d*$/.test(String(id)) || Number(id) > 2147483647) {
      return reply.status(400).send({ error: 'Invalid track ID' });
    }
    const { rows } = await query('SELECT file_path, format, missing_since FROM tracks WHERE id = $1', [Number(id)]);

    if (rows.length === 0 || rows[0].missing_since || !rows[0].file_path) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    return sendAudioFile(req, reply, rows[0].file_path, rows[0].format);
  });
}
