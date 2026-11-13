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
  if (env.CORS_ORIGIN && env.CORS_ORIGIN.split(',').some(origin => origin.trim() === '*')) {
    throw new Error('Wildcard CORS_ORIGIN is not allowed in production');
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

function pruneAndCheckBucket(bucketKey, limit, now = Date.now()) {
  for (const [k, entry] of attempts) if (now >= entry.until) attempts.delete(k);
  const entry = attempts.get(bucketKey);
  return !entry || now >= entry.until || entry.count < limit;
}

function recordBucketFailure(bucketKey, now = Date.now()) {
  const existing = attempts.get(bucketKey);
  const entry = existing && now < existing.until ? existing : { count: 0, until: now + WINDOW };
  if (attempts.size >= 10_000 && !attempts.has(bucketKey)) attempts.delete(attempts.keys().next().value);
  entry.count++;
  attempts.set(bucketKey, entry);
}

function hashBucket(prefix, raw) {
  return `${prefix}:${crypto.createHash('sha256').update(String(raw).trim().toLowerCase()).digest('hex')}`;
}

export function accountLoginAllowed(username, now = Date.now()) {
  if (typeof username !== 'string') return false;
  return pruneAndCheckBucket(hashBucket('user', username), 10, now);
}
export function recordLoginFailure(username, now = Date.now()) {
  if (typeof username !== 'string') return;
  recordBucketFailure(hashBucket('user', username), now);
}
export function ipAuthAllowed(ip, now = Date.now()) {
  if (typeof ip !== 'string' || !ip.trim()) return true;
  return pruneAndCheckBucket(hashBucket('ip', ip), 20, now);
}
export function recordIpAuthFailure(ip, now = Date.now()) {
  if (typeof ip !== 'string' || !ip.trim()) return;
  recordBucketFailure(hashBucket('ip', ip), now);
}
