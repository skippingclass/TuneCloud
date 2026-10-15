import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import fastifyMetrics from 'fastify-metrics';
import fs from 'fs';
import { initDb, query } from './db.js';
import { initCoversDir } from './cover.js';
import { setupCustomMetrics } from './metrics.js';
import { hashPassword, verifyPassword, encryptSubsonicSecret, decryptSubsonicSecret } from './auth.js';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.log('ADMIN_PASSWORD not set — skipping admin user creation. Register via /api/auth/register');
    return;
  }
  const { rows } = await query('SELECT id, is_admin, password_hash, subsonic_secret FROM users WHERE username = $1', [username]);
  if (rows.length > 0) {
    if (!rows[0].is_admin) {
      await query('UPDATE users SET is_admin = true WHERE id = $1', [rows[0].id]);
      console.log(`Admin privileges granted to existing user "${username}"`);
    } else {
      console.log(`Admin user "${username}" already exists`);
    }
    if (
      decryptSubsonicSecret(rows[0].subsonic_secret) !== password &&
      await verifyPassword(password, rows[0].password_hash)
    ) {
      await query('UPDATE users SET subsonic_secret = $1 WHERE id = $2', [encryptSubsonicSecret(password), rows[0].id]);
      console.log(`Subsonic secret updated for "${username}"`);
    }
    return;
  }
  const hash = await hashPassword(password);
  await query(
    'INSERT INTO users (username, password_hash, is_admin, subsonic_secret) VALUES ($1, $2, true, $3)',
    [username, hash, encryptSubsonicSecret(password)]
  );
  console.log(`Admin user "${username}" created`);
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production') {
      throw new Error('FATAL: JWT_SECRET must be set to a strong secret in production mode!');
    }
  }

  await initDb();
  await initCoversDir();
  await seedAdmin();

  const app = Fastify({
    logger: true,
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : true;

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => {
      return (
        req.url === '/metrics' ||
        req.url.startsWith('/metrics') ||
        req.url === '/api/health' ||
        req.url.startsWith('/api/stream/')
      );
    },
  });

  await app.register(fastifyMetrics, { endpoint: '/metrics' });
  setupCustomMetrics(app);

  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  }));

  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    await app.register(staticFiles, {
      root: clientDist,
      prefix: '/',
      wildcard: false,
    });
  }

  const { default: browse } = await import('./routes/browse.js');
  const { default: stream } = await import('./routes/stream.js');
  const { default: tracks } = await import('./routes/tracks.js');
  const { default: scan } = await import('./routes/scan.js');
  const { default: tags } = await import('./routes/tags.js');
  const { default: cover } = await import('./routes/cover.js');
  const { default: spotify } = await import('./routes/spotify.js');
  const { default: auth } = await import('./routes/auth.js');
  const { default: subsonic } = await import('./routes/subsonic.js');
  const { default: playlists } = await import('./routes/playlists.js');

  browse(app);
  stream(app);
  tracks(app);
  scan(app);
  tags(app);
  cover(app);
  spotify(app);
  auth(app);
  subsonic(app);
  playlists(app);

  if (fs.existsSync(clientDist)) {
    app.setNotFoundHandler(async (req, reply) => {
      if (!req.url.startsWith('/api/') && !req.url.startsWith('/rest/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  }

  const port = parseInt(process.env.PORT || '4000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    console.log(`Server running at http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
