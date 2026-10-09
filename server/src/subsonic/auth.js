import crypto from 'crypto';
import { query } from '../db.js';
import { verifyPassword, decryptSubsonicSecret } from '../auth.js';
import { ErrorCode } from './response.js';

const WRONG = { code: ErrorCode.WRONG_CREDENTIALS, message: 'Wrong username or password.' };

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a).toLowerCase());
  const bb = Buffer.from(String(b).toLowerCase());
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function decodePassword(p) {
  if (p.startsWith('enc:')) {
    return Buffer.from(p.slice(4), 'hex').toString('utf8');
  }
  return p;
}

/**
 * Validates Subsonic credentials (u + p, or u + t + s).
 * Returns { user } on success or { error: { code, message } } on failure.
 */
export async function authenticate(params) {
  const { u, p, t, s } = params;
  if (!u || (!p && !(t && s))) {
    return { error: { code: ErrorCode.MISSING_PARAM, message: 'Required parameter is missing.' } };
  }

  const { rows } = await query(
    'SELECT id, username, password_hash, is_admin, subsonic_secret FROM users WHERE username = $1',
    [u]
  );
  const user = rows[0];
  if (!user) return { error: WRONG };

  if (t && s) {
    const password = decryptSubsonicSecret(user.subsonic_secret);
    if (password === null) {
      console.warn(`Subsonic token auth for "${u}" failed: no subsonic secret stored. Log in to the web UI once to enable it.`);
      return { error: WRONG };
    }
    const expected = crypto.createHash('md5').update(password + s).digest('hex');
    if (!safeEqualHex(t, expected)) return { error: WRONG };
  } else {
    const clear = decodePassword(String(p));
    if (!(await verifyPassword(clear, user.password_hash))) return { error: WRONG };
  }

  return { user: { id: user.id, username: user.username, is_admin: user.is_admin } };
}
