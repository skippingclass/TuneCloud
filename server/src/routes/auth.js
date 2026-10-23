import { query } from '../db.js';
import {
  hashPassword,
  verifyPassword,
  signToken,
  sessionUser,
  bearerToken,
  validPassword,
  setStreamCookie,
  clearStreamCookie,
  requireAdmin,
  encryptSubsonicSecret,
  decryptSubsonicSecret,
} from '../auth.js';
import { accountLoginAllowed, recordLoginFailure } from '../security.js';

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

    if (!validPassword(password)) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters and at most 72 UTF-8 bytes' });
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

      if (!validPassword(password, 1)) return reply.status(401).send({ error: 'Invalid username or password' });
      if (!accountLoginAllowed(username)) return reply.status(429).send({ error: 'Too many login attempts for this account' });
      const { rows } = await query('SELECT * FROM users WHERE username = $1', [username.trim()]);
      if (rows.length === 0) {
        recordLoginFailure(username);
        return reply.status(401).send({ error: 'Invalid username or password' });
      }

      const user = rows[0];
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        recordLoginFailure(username);
        return reply.status(401).send({ error: 'Invalid username or password' });
      }

      // Backfill (or refresh after JWT_SECRET rotation) the Subsonic secret.
      if (process.env.SUBSONIC_ENCRYPTION_KEY || decryptSubsonicSecret(user.subsonic_secret) !== password) {
        await query('UPDATE users SET subsonic_secret = $1 WHERE id = $2', [
          encryptSubsonicSecret(password),
          user.id,
        ]);
      }

      const token = signToken(user);
      setStreamCookie(req, reply, user);
      return { token, user: { id: user.id, username: user.username, is_admin: user.is_admin } };
    }
  );

  fastify.get('/api/auth/me', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = bearerToken(req);
    if (!token) return { authenticated: false };
    try {
      const user = await sessionUser(token);
      if (!user) { clearStreamCookie(req, reply); return { authenticated: false }; }
      setStreamCookie(req, reply, user);
      return { authenticated: true, user: { id: user.id, username: user.username, is_admin: user.is_admin } };
    } catch (err) {
      if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(err.name) || err.message === 'Invalid session') {
        clearStreamCookie(req, reply);
        return { authenticated: false };
      }
      return reply.status(503).send({ error: 'Authentication temporarily unavailable' });
    }
  });

  fastify.post('/api/auth/logout', { preHandler: async (req, reply) => {
    // Clear even when the supplied access token is already expired.
    clearStreamCookie(req, reply);
    const { requireAuth } = await import('../auth.js');
    return requireAuth(req, reply);
  } }, async (req) => {
    await query('UPDATE users SET auth_version = auth_version + 1 WHERE id = $1', [req.user.id]);
    return { success: true };
  });

  fastify.get('/api/auth/users', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { rows } = await query('SELECT id, username, is_admin, created_at FROM users ORDER BY created_at ASC');
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      is_admin: r.is_admin,
      created_at: r.created_at,
    }));
  });

  fastify.put('/api/auth/users/:id/password', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params;
    const { password } = req.body || {};
    if (!password || !validPassword(password)) {
      return reply.status(400).send({ error: 'Password must be at least 8 characters and at most 72 UTF-8 bytes' });
    }
    const hash = await hashPassword(password);
    const enc = encryptSubsonicSecret(password);
    const res = await query(
      'UPDATE users SET password_hash = $1, subsonic_secret = $2, auth_version = auth_version + 1 WHERE id = $3 RETURNING id, username, is_admin',
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
    const res = await query('UPDATE users SET is_admin = $1, auth_version = auth_version + 1 WHERE id = $2 RETURNING id, username, is_admin', [is_admin, userId]);
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
