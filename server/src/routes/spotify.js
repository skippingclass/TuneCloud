import { searchArtist } from '../spotify.js';
import { requireAuth } from '../auth.js';

export default async function spotifyRoutes(fastify) {
  fastify.get('/api/spotify/artist', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = req.query;
    if (!name || !name.trim()) {
      return reply.status(400).send({ error: 'name required' });
    }
    const cleanName = String(name).trim().slice(0, 100);

    const result = await searchArtist(cleanName);
    if (!result) {
      return { found: false };
    }

    return { found: true, artist: result };
  });
}
