import crypto from 'node:crypto';

const PLACEHOLDERS = new Set([
  'change-me-in-production', 'tunecloud-default-secret-replace-me',
  'replace_with_a_secure_random_string_at_least_32_chars', 'your-random-secret',
]);

export function validateSecurityConfig(env = process.env) {
  if (env.ADMIN_PASSWORD && Buffer.byteLength(env.ADMIN_PASSWORD) > 72) throw new Error('ADMIN_PASSWORD must not exceed 72 UTF-8 bytes');
  if (env.NODE_ENV !== 'production') return;
  const secret = env.JWT_SECRET || '';
  if (secret.length < 32 || PLACEHOLDERS.has(secret) || /replace.?me|change.?me|your[-_]random/i.test(secret)) {
    throw new Error('JWT_SECRET must be a unique random secret of at least 32 characters in production');
  }
  if (env.ADMIN_PASSWORD && (Buffer.byteLength(env.ADMIN_PASSWORD) < 12 ||
      ['admin_secure_password', 'your-admin-password'].includes(env.ADMIN_PASSWORD))) {
    throw new Error('ADMIN_PASSWORD must be a unique password of at least 12 bytes in production');
  }
}

export function trustedProxies(env = process.env) {
  return env.TRUSTED_PROXIES?.split(',').map(s => s.trim()).filter(Boolean) || false;
}

// Never log query strings: Subsonic clients put passwords/tokens in them.
export function safeRequestSerializer(req) {
  return { method: req.method, url: String(req.url || '').split('?')[0],
    remoteAddress: req.socket?.remoteAddress };
}

const attempts = new Map();
const WINDOW = 60_000;
export function accountLoginAllowed(username, now = Date.now()) {
  if (typeof username !== 'string') return false;
  const key = crypto.createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
  for (const [k, entry] of attempts) if (now >= entry.until) attempts.delete(k);
  return !attempts.has(key) || attempts.get(key).count < 10;
}
export function recordLoginFailure(username, now = Date.now()) {
  if (typeof username !== 'string') return;
  const key = crypto.createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
  const entry = attempts.get(key) || { count: 0, until: now + WINDOW };
  if (attempts.size >= 10_000 && !attempts.has(key)) attempts.delete(attempts.keys().next().value);
  entry.count++;
  attempts.set(key, entry);
}
