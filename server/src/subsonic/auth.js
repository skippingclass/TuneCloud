import crypto from 'crypto';
import { query } from '../db.js';
import { verifyPassword, decryptSubsonicSecret, encryptSubsonicSecret } from '../auth.js';
import { accountLoginAllowed, recordLoginFailure } from '../security.js';
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

  const throttled = () => ({ error: { code: ErrorCode.GENERIC, message: 'Too many authentication attempts. Retry shortly.' } });
  // Token authentication uses a cheap digest, so valid streams remain available
  // even when somebody else is submitting bad passwords for this account.
  if (!(t && s) && !accountLoginAllowed(u)) return throttled();
  const fail = () => { recordLoginFailure(u); return { error: WRONG }; };

  const { rows } = await query(
    'SELECT id, username, password_hash, is_admin, subsonic_secret FROM users WHERE username = $1',
    [u]
  );
  const user = rows[0];
  if (!user) return fail();

  if (t && s) {
    const password = decryptSubsonicSecret(user.subsonic_secret);
    if (password === null) {
      console.warn(`Subsonic token auth for "${u}" failed: no subsonic secret stored. Log in to the web UI once to enable it.`);
      return { error: { code: ErrorCode.GENERIC, message: 'Log in to the web UI once to refresh Subsonic authentication.' } };
    }
    const expected = crypto.createHash('md5').update(password + s).digest('hex');
    if (!safeEqualHex(t, expected)) return accountLoginAllowed(u) ? fail() : throttled();
  } else {
    const clear = decodePassword(String(p));
    if (Buffer.byteLength(clear) > 72 || !(await verifyPassword(clear, user.password_hash))) return fail();
    if (process.env.SUBSONIC_ENCRYPTION_KEY || decryptSubsonicSecret(user.subsonic_secret) !== clear) {
      await query('UPDATE users SET subsonic_secret = $1 WHERE id = $2', [encryptSubsonicSecret(clear), user.id]);
    }
  }

  return { user: { id: user.id, username: user.username, is_admin: user.is_admin } };
}
