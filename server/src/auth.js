import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { query } from './db.js';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const LEGACY_KEY = crypto.scryptSync(JWT_SECRET, 'subsonic-salt-key', 32);
// One account/password for web and Subsonic. An independent encryption key is optional.
const ENC_KEY = process.env.SUBSONIC_ENCRYPTION_KEY
  ? crypto.scryptSync(process.env.SUBSONIC_ENCRYPTION_KEY, 'subsonic-salt-key', 32) : LEGACY_KEY;
const COOKIE_NAME = 'tunecloud-stream';
const TOKEN_TTL = 7 * 24 * 60 * 60;

export function encryptSubsonicSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSubsonicSecret(encryptedStr) {
  if (typeof encryptedStr !== 'string') return null;
  for (const key of [ENC_KEY, LEGACY_KEY]) {
    try {
      const [iv, tag, data] = encryptedStr.split(':').map(s => Buffer.from(s, 'hex'));
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch { /* Try the legacy key when migrating an existing installation. */ }
  }
  return null;
}

// Re-encrypt existing credentials once an independent key is configured, while
// the old JWT key is still available. This does not change any user's password.
export async function migrateSubsonicEncryption() {
  if (!process.env.SUBSONIC_ENCRYPTION_KEY) return;
  const { rows } = await query('SELECT id, subsonic_secret FROM users WHERE subsonic_secret IS NOT NULL');
  for (const row of rows) {
    const password = decryptSubsonicSecret(row.subsonic_secret);
    if (password !== null) await query('UPDATE users SET subsonic_secret = $1 WHERE id = $2', [encryptSubsonicSecret(password), row.id]);
  }
}

export function validPassword(password, min = 8) {
  return typeof password === 'string' && password.length >= min && Buffer.byteLength(password) <= 72;
}
export function hashPassword(password) { return bcrypt.hash(password, SALT_ROUNDS); }
export function verifyPassword(password, hash) { return bcrypt.compare(password, hash); }

function createToken(user, kind) {
  return jwt.sign({ id: user.id, version: user.auth_version, kind }, JWT_SECRET,
    { expiresIn: TOKEN_TTL, algorithm: 'HS256' });
}
export function signToken(user) { return createToken(user, 'access'); }
export function verifyToken(token, kind = 'access') {
  const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  if (payload.kind !== kind || !Number.isInteger(payload.id) || !Number.isInteger(payload.version)) {
    throw new Error('Invalid session');
  }
  return payload;
}
export function bearerToken(req) {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}
export async function sessionUser(token, kind = 'access') {
  const payload = verifyToken(token, kind);
  const { rows } = await query('SELECT id, username, is_admin, auth_version FROM users WHERE id = $1', [payload.id]);
  const user = rows[0];
  if (!user || user.auth_version !== payload.version) return null;
  return user;
}

function cookieOptions(req) {
  const secure = process.env.COOKIE_SECURE !== 'false' &&
    (process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' || req.protocol === 'https');
  return `Path=/api/stream; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
export function setStreamCookie(req, reply, user) {
  reply.header('Set-Cookie', `${COOKIE_NAME}=${createToken(user, 'stream')}; Max-Age=${TOKEN_TTL}; ${cookieOptions(req)}`);
  reply.header('Cache-Control', 'no-store');
}
export function clearStreamCookie(req, reply) {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; ${cookieOptions(req)}`);
  reply.header('Cache-Control', 'no-store');
}

async function authenticateRequest(req, reply, stream = false) {
  let token = bearerToken(req);
  let kind = 'access';
  if (!token && stream) {
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(`${COOKIE_NAME}=`));
    token = cookie?.slice(COOKIE_NAME.length + 1);
    kind = 'stream';
  }
  if (!token) return reply.status(401).send({ error: 'Missing or invalid session' });
  try {
    const user = await sessionUser(token, kind);
    if (!user) return reply.status(401).send({ error: 'Invalid or expired session' });
    req.user = user;
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err.message === 'Invalid session') {
      return reply.status(401).send({ error: 'Invalid or expired session' });
    }
    req.log?.error({ code: err.code }, 'Session lookup failed');
    return reply.status(503).send({ error: 'Authentication temporarily unavailable' });
  }
}
export async function requireAuth(req, reply) { return authenticateRequest(req, reply); }
export async function requireStreamAuth(req, reply) { return authenticateRequest(req, reply, true); }
export async function requireAdmin(req, reply) {
  await requireAuth(req, reply);
  if (reply.sent) return;
  if (!req.user.is_admin) return reply.status(403).send({ error: 'Admin access required' });
}
