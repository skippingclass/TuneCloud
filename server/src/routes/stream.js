import fs from 'fs';
import { query } from '../db.js';
import { sendAudioFile } from '../streaming.js';

export default async function streamRoutes(fastify) {
  fastify.get('/api/stream/:id', async (req, reply) => {
    const { id } = req.params;
    const { rows } = await query('SELECT file_path, format FROM tracks WHERE id = $1', [id]);

    if (rows.length === 0) {
      return reply.status(404).send({ error: 'Track not found' });
    }

    const filePath = rows[0].file_path;

    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found on disk' });
    }

    sendAudioFile(req, reply, filePath, rows[0].format);
  });
}
