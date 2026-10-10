import bcrypt from 'bcrypt';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Subsonic token auth needs the clear-text password (t = md5(password + salt)),
// so we additionally store it encrypted with a key derived from JWT_SECRET.
const ENC_KEY = crypto.scryptSync(JWT_SECRET, 'subsonic-salt-key', 32);

export function encryptSubsonicSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

export function decryptSubsonicSecret(encryptedStr) {
  if (!encryptedStr || !encryptedStr.includes(':')) return null;
  try {
    const [ivHex, tagHex, dataHex] = encryptedStr.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let dec = decipher.update(dataHex, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return null;
  }
}

export async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: user.is_admin },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function requireAuth(req, reply) {
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
    return reply.status(401).send({ error: 'Missing or invalid token' });
  }
  try {
    const payload = verifyToken(token);
    req.user = payload;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function requireAdmin(req, reply) {
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
    return reply.status(401).send({ error: 'Missing or invalid token' });
  }
  try {
    const payload = verifyToken(token);
    req.user = payload;
    if (!payload.is_admin) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
