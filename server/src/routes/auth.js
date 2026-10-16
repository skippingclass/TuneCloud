import { query } from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  requireAdmin,
  encryptSubsonicSecret,
  decryptSubsonicSecret,
} from '../auth.js';

export default async function authRoutes(fastify) {
  fastify.post('/api/auth/register', { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password required' });
    }

    const cleanUsername = String(username).trim();
    if (cleanUsername.length < 3 || cleanUsername.length > 32 || !/^[a-zA-Z0-9_\-.]+$/.test(cleanUsername)) {
      return reply.status(400).send({ error: 'Username must be 3-32 characters (letters, numbers, _, -, .)' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }

    const existing = await query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
    if (existing.rows.length > 0) {
      return reply.status(409).send({ error: 'Username already exists' });
    }

    const passwordHash = await hashPassword(password);
    await query(
      'INSERT INTO users (username, password_hash, subsonic_secret) VALUES ($1, $2, $3)',
      [cleanUsername, passwordHash, encryptSubsonicSecret(password)]
    );

    return { success: true, username: cleanUsername };
  });

  fastify.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const { username, password } = req.body || {};
      if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return reply.status(400).send({ error: 'username and password required' });
      }

      const { rows } = await query('SELECT * FROM users WHERE username = $1', [username.trim()]);
      if (rows.length === 0) {
        return reply.status(401).send({ error: 'Invalid username or password' });
      }

      const user = rows[0];
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({ error: 'Invalid username or password' });
      }

      // Backfill (or refresh after JWT_SECRET rotation) the Subsonic secret.
      if (decryptSubsonicSecret(user.subsonic_secret) !== password) {
        await query('UPDATE users SET subsonic_secret = $1 WHERE id = $2', [
          encryptSubsonicSecret(password),
          user.id,
        ]);
      }

      const token = signToken(user);
      return { token, user: { id: user.id, username: user.username, is_admin: user.is_admin } };
    }
  );

  fastify.get('/api/auth/me', async (req, reply) => {
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice(7);
    } else if (req.query?.token) {
      token = String(req.query.token);
    } else if (req.query?.jwt) {
      token = String(req.query.jwt);
    }

    if (!token) {
      return { authenticated: false };
    }
    try {
      const payload = verifyToken(token);
      const { rows } = await query('SELECT id, username, is_admin FROM users WHERE id = $1', [payload.id]);
      if (rows.length === 0) return { authenticated: false };
      return { authenticated: true, user: rows[0] };
    } catch {
      return { authenticated: false };
    }
  });

  fastify.get('/api/auth/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { rows } = await query('SELECT id, username, is_admin, subsonic_secret, created_at FROM users ORDER BY created_at ASC');
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      is_admin: r.is_admin,
      created_at: r.created_at,
      password: decryptSubsonicSecret(r.subsonic_secret),
    }));
  });

  fastify.put('/api/auth/users/:id/password', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || typeof password !== 'string' || password.length < 8) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters' });
    }
    const hash = await hashPassword(password);
    const enc = encryptSubsonicSecret(password);
    const res = await query(
      'UPDATE users SET password_hash = $1, subsonic_secret = $2 WHERE id = $3 RETURNING id, username, is_admin',
      [hash, enc, id]
    );
    if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
    return { success: true, message: 'Password updated', user: res.rows[0] };
  });

  fastify.patch('/api/auth/users/:id/admin', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    const { is_admin } = req.body || {};
    const userId = parseInt(id, 10);
    if (typeof is_admin !== 'boolean') return reply.status(400).send({ error: 'is_admin must be a boolean' });
    if (req.user?.id === userId && !is_admin) {
      return reply.status(400).send({ error: 'Cannot remove admin privileges from yourself' });
    }
    const res = await query('UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING id, username, is_admin', [is_admin, userId]);
    if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
    return { success: true, user: res.rows[0] };
  });

  fastify.delete('/api/auth/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    const userId = parseInt(id, 10);
    if (req.user?.id === userId) return reply.status(400).send({ error: 'Cannot delete your own account' });
    const res = await query('DELETE FROM users WHERE id = $1 RETURNING id, username', [userId]);
    if (res.rows.length === 0) return reply.status(404).send({ error: 'User not found' });
    return { success: true, message: `User "${res.rows[0].username}" deleted` };
  });
}
